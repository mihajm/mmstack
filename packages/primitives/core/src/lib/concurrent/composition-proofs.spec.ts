/**
 * PURE MODEL of the composition: overlapping async transaction bodies, optimistic guesses (both
 * tiers), conditional undo, attribution, the display hold, an in-place error boundary and a
 * hold-and-swap transition, all running in ONE trace. The per-Part proofs show each mechanism on
 * its own; this file checks that their guarantees survive when they run together.
 *
 * Every rule below is transcribed from the per-Part model that proves it (named at each rule);
 * none is re-derived. The real `merge3` is the only import.
 *
 * Layers of one node:
 *  - truth: the authoritative value, owned by the undo ledger (per-generation entries, owner
 *    chain, compare-and-restore; `merge3` for the store root);
 *  - live guess (live tier): a per-node guess history over the truth shadow; the display shows the
 *    most recent open guess laid after the node's last authoritative write;
 *  - overlay guess (overlay tier): one fork per body over the store root, folded in open order,
 *    discarded at settlement.
 *
 * Theorems, checked after every event of every generated trace:
 *  - T1 a write or a synchronous kickoff inside a slice belongs to that slice's body and no other.
 *  - T2 held readers never show a body's write while the hold is open (a guess only through the
 *    bypass), including readers first evaluated during the hold: such a reader is seeded with the
 *    pre of the entry for its node with the lowest record order written since the hold began,
 *    whether its transaction is still open or has settled; the hold never ends while a retain is
 *    open or the body has not returned.
 *  - T3 settling a body undoes exactly its writes still in effect and nothing another writer did.
 *  - T4 no guess survives settlement, in either tier; while open, readers see the tier's guess.
 *  - T5 the committed display is one clean frame or the fallback, never a torn frame.
 *  - T6 a settled transaction cannot be reopened by a late continuation.
 * Stated limits, shown and pinned: L1 kickoffs outside a slice are attributed by the open window;
 * L2 undo keeps values, not invariants across store paths; L3 an unwrapped late write lands;
 * L4 held readers freeze a live guess unless the bypass is on; L5 a reader first evaluated during
 * a hold over a node no transaction recorded since the hold began (an unrecorded signal, a
 * derivation, a store leaf) shows the live value. Every body write in this model is recorded, so
 * L5 is pinned on the real scope.
 *
 * A branch mounted under the page scope shares its hold (a per-view scope with no transactions of
 * its own). The two-scope variant adds a long-lived child scope inside the page: its own hold
 * count, hold episodes, seeders, resource, transactions and readers, holding while it or the page
 * holds, its seed lookup walking up to the page while the page holds.
 *
 * Killed alternatives run under the same generators and are shown to break the theorem they
 * would weaken.
 *
 * Re-pointed: generated two-scope traces are recorded step by step and replayed against the real
 * transactions, scopes, held readers, `guessable` and `optimisticStore`; the state after every
 * step must match the model's.
 */
import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  type ResourceStatus,
  runInInjectionContext,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { merge3 } from '../store/fork-store';
import {
  declareRecordOptions,
  recordTargetOf,
  recordWrite,
  transactional,
} from './active-transaction';
import { optimisticStore } from '../store/optimistic-store';
import { store } from '../store/store';
import { holdRegistrySize, recordHoldEntry } from './hold-seed';
import { guessable, type Guessable } from './optimistic';
import {
  type AsyncTransactionRef,
  injectStartTransaction,
  type RecordOptions,
  type Transaction,
  type TransactionOutcome,
} from './transaction';
import { abortTransaction } from './transaction-driver';
import {
  createAttributedPending,
  createForwardingScope,
  createTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

// ─── vocabulary ──────────────────────────────────────────────────────────────────────────

type Id = 'A' | 'B' | 'C' | 'D';
type Reason = 'abort' | 'superseded' | 'destroyed';
type Outcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly reason: Reason }
  | { readonly kind: 'failed'; readonly error: unknown };

// same PRNG as every per-Part model
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Sig = 's0' | 's1' | 'g0' | 'g1';
/** Plain signals: the ledger's compare is `Object.is` (the fallback for unstamped writers). */
const PLAIN: readonly Sig[] = ['s0', 's1'];
/** Guess-capable signals (live tier): wrapped so every set stamps, the compare is by stamp. */
const GUESSABLE: readonly Sig[] = ['g0', 'g1'];
const SIGS: readonly Sig[] = [...PLAIN, ...GUESSABLE];
const ROOT = 'root';
type Target = Sig | typeof ROOT;

// store shape, readLeaf and writeLeaf transcribed from transaction-proofs.spec.ts
type Tree = { a: { p: string; q: string }; b: { r: string }; c: string };
const LEAVES = ['a.p', 'a.q', 'b.r', 'c'] as const;
type Leaf = (typeof LEAVES)[number];
function readLeaf(tree: Tree, leaf: Leaf): string {
  const [k1, k2] = leaf.split('.') as [keyof Tree, string | undefined];
  const node = tree[k1] as unknown as Record<string, string>;
  return (k2 === undefined ? node : node[k2]) as string;
}
function writeLeaf(tree: Tree, leaf: Leaf, v: string): Tree {
  const [k1, k2] = leaf.split('.') as [keyof Tree, string | undefined];
  if (k2 === undefined) return { ...tree, [k1]: v };
  return { ...tree, [k1]: { ...(tree[k1] as object), [k2]: v } };
}
const initialTree = (): Tree => ({
  a: { p: 'init:a.p', q: 'init:a.q' },
  b: { r: 'init:b.r' },
  c: 'init:c',
});

/** A physical value. `s` is a stamp minted per set; `at` the logical time of the set. */
type Cell = {
  readonly v: string;
  readonly s: number;
  readonly kind: 'initial' | 'auth' | 'guess';
  readonly by: Id | 'F' | null;
  readonly at: number;
};

const poisoned = (v: string) => v.includes('!');

/** Variants: the reference is every first option; each other option is a killed alternative. */
type Options = {
  /** exact = slice ownership + claims; zone = everything during a running body belongs to it */
  readonly attribution: 'exact' | 'zone';
  /** owned = per-generation compare-and-restore + merge3 root; blind = first-touch pre, restored always */
  readonly restore: 'owned' | 'blind';
  /** history = per-node guess history (live tier); snapshot = each guess restores what it covered;
   *  entry = a guess is a revert-always ledger entry written live, no history */
  readonly guessRule: 'history' | 'snapshot' | 'entry';
  /** how a later writer over a guessed node is detected */
  readonly detect: 'stamp' | 'objectIs';
  /** overlay tier at completion: discard the fork, or commit it onto the base */
  readonly overlay: 'discard' | 'commit';
  /** held readers over a guessed node: bypass + truth-shadow frame, bypass reads only, none */
  readonly bypass: 'both' | 'reads' | 'none';
  /** boundary on a render throw: hide the kept view, or leave the faulted frame on screen */
  readonly boundary: 'hide' | 'last-good-frame';
  /** continuous = the hold spans the body; first-render = released by the no-async fallback */
  readonly hold: 'continuous' | 'first-render';
  /** enter on a settled transaction: throw before running, or run the slice anyway */
  readonly closedEnter: 'throw' | 'run';
  /** a reader first evaluated during a hold: seeded from the ledger, or the live value */
  readonly midHold: 'seed' | 'live';
  /** which open entry seeds it: the first in transaction open order, or the first recorded */
  readonly seedOrder: 'open' | 'record';
  /** a transaction's seeds are dropped at its settlement, or kept until the hold ends */
  readonly seedLife: 'settlement' | 'hold';
  /** the swap commits when the scope is neither pending nor holding, or on not pending alone */
  readonly swap: 'unheld' | 'pending';
  /** world shape, not an alternative: add the child scope (its bodies, resource and readers) */
  readonly twoScope: boolean;
  /**
   * trace shape, not an alternative: what a replay against the real code can run (no faults or
   * swaps); `plain` also turns guesses into plain writes and writes only plain signals
   */
  readonly replayable: 'no' | 'plain' | 'guesses';
  /** a scope created inside a holding one: holds and seeds through it, neither, or only the swap watcher reads it */
  readonly inherit: 'chain' | 'none' | 'watcher';
  /** a scope's seeders at its own hold count 0: dropped only when nothing above holds it, or always */
  readonly seedDrop: 'unheld' | 'own0';
  /** a seed counts only when recorded after the earliest hold episode of the chain began, or always */
  readonly episodeFilter: 'on' | 'off';
  /**
   * where a mid-hold reader's seed comes from: the scope chain's seeders (as landed), or a
   * candidate: one registry of every recorded entry, filtered by when the reader's scope started
   * holding (own or inherited)
   */
  readonly seedScope: 'chain' | 'tree';
};
const REFERENCE: Options = {
  attribution: 'exact',
  restore: 'owned',
  guessRule: 'history',
  detect: 'stamp',
  overlay: 'discard',
  bypass: 'both',
  boundary: 'hide',
  hold: 'continuous',
  closedEnter: 'throw',
  midHold: 'seed',
  seedOrder: 'record',
  seedLife: 'hold',
  swap: 'unheld',
  twoScope: false,
  replayable: 'no',
  inherit: 'chain',
  seedDrop: 'unheld',
  episodeFilter: 'on',
  seedScope: 'tree',
};

class ClosedError extends Error {
  constructor(id: Id) {
    super(`transaction ${id} is closed`);
  }
}

/** Ledger entry, transcribed from transaction-proofs.spec.ts `Entry`. */
type LEntry = {
  readonly tx: Id;
  readonly gen: number;
  /** global record order (oracle and the record-order seed variant) */
  readonly seq: number;
  /** model time of the record (the ideal mid-hold seed reads it) */
  readonly at: number;
  readonly kind: 'authoritative' | 'guess';
  readonly target: Target;
  readonly pre: Cell | Tree;
  mine: Cell | Tree | undefined;
  open: boolean;
  readonly prev: LEntry | undefined;
};

/** Guess history, transcribed from optimistic-proofs.spec.ts `GuessEntry` / `GuessState`. */
type GuessEntry = {
  readonly b: Id;
  readonly order: number;
  readonly gen: number;
  readonly v: string;
};
type GuessState = { hist: GuessEntry[]; truth: Cell; mine: Cell };

/** The page scope, the child scope created inside it, and a branch's per-view scope. */
type ScopeId = 'page' | 'child' | 'branch';
type ScopeState = {
  own: number;
  /** hold-seed episode stamp: the record sequence when its own hold went 0 to 1 */
  episode: number | undefined;
  /** transactions whose seeders are registered here, in registration order */
  seeders: Id[];
  /** oracle: why a seeder left the list */
  readonly dropped: Map<Id, 'rehold' | 'own0' | 'hold-end' | 'settlement'>;
  /** oracle: the model time the scope last started holding (own or inherited) */
  since: number | undefined;
  /** the record sequence at that moment (the `seedScope: 'tree'` candidate's stamp) */
  sinceSeq: number;
  /** coverage: own hold episodes so far */
  episodes: number;
};

class Txn {
  status: 'running' | 'returned' | 'settled' = 'running';
  outcome: Outcome | undefined;
  resolutions = 0;
  log: LEntry[] = [];
  gen = 0;
  depth = 0;
  readonly retains = new Set<number>();
  readonly nested = new Set<number>();
  settledAt = Infinity;
  fork: { ancestor: Tree; value: Tree } | undefined;
  sliceBefore: number[] | undefined;
  /** its first entry per node (transaction.ts `seedLogs`), kept past settlement */
  readonly seedLog = new Map<Target, LEntry>();
  sawPending = false;
  rendered = false;
  constructor(
    readonly id: Id,
    readonly order: number,
    readonly openedAt: number,
    readonly loads0: readonly number[],
    readonly pre: readonly boolean[],
    readonly scope: 'page' | 'child' = 'page',
  ) {}
}

type Res = {
  loading: boolean;
  count: number;
  at: number;
  /** the body whose slice started the current flight synchronously, else null */
  by: Id | null;
  /** zone alternative only: every body running when it started */
  zone: Id[];
};
const RES = 3;

type Reader = {
  readonly node: Sig;
  readonly scope: ScopeId;
  readonly rid: number;
  /** linkedSignal memory: what the last evaluation showed, and the truth beneath it */
  last: { shown: Cell; truth: Cell; at: number; born?: Birth } | undefined;
};
/**
 * Oracle only, taken when a reader is first evaluated during a hold: each open transaction's
 * oldest entry for the node, and which bodies had settled by then.
 */
type Birth = {
  readonly entries: readonly { readonly order: number; readonly pre: Cell }[];
  readonly settled: ReadonlySet<Id>;
};
type Content = {
  readonly inst: number;
  readonly readers: Reader[];
  readonly dom: { v: string; frame: number }[];
  hidden: boolean;
  attached: boolean;
};
type Branch = {
  readonly id: number;
  content: Content | undefined;
  fault: { kind: 'update' | 'creation'; inst: number } | undefined;
  sawPending: boolean;
  sawHolding: boolean;
  rendered: boolean;
};

/** A recorded step, replayed against the real implementation (see the re-pointed sweeps). */
type RecEv =
  | { readonly k: 'open'; readonly id: Id; readonly scope: 'page' | 'child' }
  | { readonly k: 'enter'; readonly id: Id }
  | { readonly k: 'exit'; readonly id: Id }
  | { readonly k: 'enterClosed'; readonly id: Id }
  | { readonly k: 'write'; readonly n: Sig; readonly v: string }
  | {
      readonly k: 'tree';
      readonly leaves: readonly Leaf[];
      readonly vs: readonly string[];
    }
  | {
      readonly k: 'guess';
      readonly id: Id;
      readonly n: Sig;
      readonly v: string;
    }
  | {
      readonly k: 'overlay';
      readonly id: Id;
      readonly p: Leaf;
      readonly v: string;
    }
  | { readonly k: 'start'; readonly i: number }
  | { readonly k: 'settle'; readonly i: number }
  | { readonly k: 'retain'; readonly id: Id; readonly r: number }
  | { readonly k: 'release'; readonly id: Id; readonly r: number }
  | { readonly k: 'nest'; readonly into: Id; readonly token: number }
  | { readonly k: 'nestSettle'; readonly token: number }
  | { readonly k: 'return'; readonly id: Id }
  | { readonly k: 'throw'; readonly id: Id }
  | { readonly k: 'cancel'; readonly id: Id; readonly reason: Reason }
  | { readonly k: 'render' }
  | {
      readonly k: 'mount';
      readonly rid: number;
      readonly n: Sig;
      readonly scope: 'page' | 'child';
    };
type TxnSnap = {
  readonly settled: boolean;
  readonly outcome?: string;
  readonly pending?: boolean;
  readonly log?: string;
};
/** The model state after a top-level step; `readers` after the steps that evaluate them. */
type RecSnap = {
  readonly values: Readonly<Record<string, string>>;
  readonly holding: { readonly page: boolean; readonly child: boolean };
  readonly txns: Readonly<Record<string, TxnSnap>>;
  readonly readers?: readonly (readonly [number, string])[];
};
type Rec = { readonly e: RecEv; readonly snap?: RecSnap };
const outcomeName = (o: Outcome | undefined): string =>
  !o ? 'none' : o.kind === 'aborted' ? `aborted:${o.reason}` : o.kind;

class World {
  time = 0;
  /** set to record every step for a replay */
  rec: Rec[] | undefined;
  private rids = 0;
  private stamps = 0;
  private ids = 0;
  private seqs = 0;
  readonly cells = new Map<Sig, Cell>();
  root: Tree = initialTree();
  readonly gs = new Map<Sig, GuessState>();
  private readonly snaps = new Map<string, { pre: Cell; mine: Cell }>();
  readonly owner = new Map<Target, LEntry>();
  readonly txns = new Map<Id, Txn>();
  private readonly stack: Id[] = [];
  readonly res: Res[] = Array.from({ length: RES }, () => ({
    loading: false,
    count: 0,
    at: 0,
    by: null,
    zone: [],
  }));
  /** load count → owner; `null` = the owner settled, nobody live adopts the load */
  readonly claims = new Map<number, Map<number, Id | null>>();
  readonly scopes: Record<'page' | 'child', ScopeState> = {
    page: this.scope(),
    child: this.scope(),
  };
  /** oracle: every ledger entry ever recorded */
  readonly allEntries: LEntry[] = [];
  /** hold-seed's registry: the entries a reader can still consult, pruned at hold boundaries */
  registry: LEntry[] = [];
  /** hold-seed `prune`: entries at or below the lowest stretch start of any held scope are dead */
  registryBound(): number | undefined {
    let bound: number | undefined;
    for (const x of ['page', 'child'] as const)
      if (this.idealHolding(x)) {
        const since = this.scopes[x].sinceSeq;
        if (bound === undefined || since < bound) bound = since;
      }
    return bound;
  }
  private pruneRegistry(): void {
    const bound = this.registryBound();
    this.registry =
      bound === undefined ? [] : this.registry.filter((e) => e.seq > bound);
  }
  /** readers mounted on the page or the child scope (two-scope traces) */
  readonly mounted: Reader[] = [];
  /** visibility oracle bookkeeping, independent of the machine (optimistic-proofs `Oracle`) */
  readonly oGuesses: (GuessEntry & { n: Sig; time: number })[] = [];
  readonly lastAuth = new Map<Sig, number>();
  readonly oOverlay: (GuessEntry & { p: Leaf })[] = [];
  readonly settledGuessers = new Set<Id>();
  baseWritesFromForks = 0;
  readonly page: Reader[];
  current: Branch;
  incoming: Branch | undefined;
  frames = 0;
  readonly bad = new Set<string>();

  constructor(readonly opt: Options) {
    for (const n of SIGS)
      this.cells.set(n, this.cell(`init:${n}`, 'initial', null));
    this.page = SIGS.map((node) => this.reader(node));
    this.current = this.branch();
    this.render();
  }

  cell(v: string, kind: Cell['kind'], by: Cell['by']): Cell {
    return { v, s: ++this.stamps, kind, by, at: this.time };
  }
  /** Record a step; the state after it when it is top level (`readers` given = evaluated now). */
  private log(e: RecEv, readers?: RecSnap['readers']): void {
    if (!this.rec) return;
    if (this.stack.length) {
      this.rec.push({ e });
      return;
    }
    const txns: Record<string, TxnSnap> = {};
    for (const t of this.txns.values())
      txns[t.id] =
        t.status === 'settled'
          ? { settled: true, outcome: outcomeName(t.outcome) }
          : {
              settled: false,
              pending: this.pending(t),
              log: [...new Set(t.log.map((x) => x.target))].sort().join(),
            };
    const values: Record<string, string> = {};
    for (const n of SIGS) values[n] = this.display(n).v;
    for (const n of GUESSABLE)
      values[`truth:${n}`] = (this.truthGet(n) as Cell).v;
    for (const l of LEAVES) {
      values[l] = readLeaf(this.root, l);
      values[`facade:${l}`] = this.facade(l);
    }
    this.rec.push({
      e,
      snap: {
        values,
        holding: {
          page: this.holdingOf('page'),
          child: this.holdingOf('child'),
        },
        txns,
        readers,
      },
    });
  }
  txn(id: Id): Txn {
    const t = this.txns.get(id);
    if (!t) throw new Error(`model: no transaction ${id}`);
    return t;
  }
  settled(id: Id): boolean {
    return this.txns.get(id)?.status === 'settled';
  }
  open(): Txn[] {
    return [...this.txns.values()].filter((t) => t.status !== 'settled');
  }
  private scope(): ScopeState {
    return {
      own: 0,
      episode: undefined,
      seeders: [],
      dropped: new Map(),
      since: undefined,
      sinceSeq: 0,
      episodes: 0,
    };
  }
  private drop(
    sc: ScopeState,
    why: 'rehold' | 'own0' | 'hold-end' | 'settlement',
    only?: Id,
  ): void {
    for (const id of sc.seeders)
      if (!only || id === only) sc.dropped.set(id, why);
    sc.seeders = only ? sc.seeders.filter((x) => x !== only) : [];
  }
  /** The page scope's hold (the one-scope view the pins read). */
  get holding(): boolean {
    return this.holdingOf('page');
  }
  get holdCount(): number {
    return this.scopes.page.own + this.scopes.child.own;
  }
  /** transition-scope `holding`: own count, or the enclosing scope's `holding()` when linked. */
  holdingOf(x: ScopeId): boolean {
    const page = this.scopes.page.own > 0;
    if (x === 'page') return page;
    const linked = this.opt.inherit === 'chain' && page;
    return x === 'child' ? this.scopes.child.own > 0 || linked : linked;
  }
  /** Oracle: a hold on a scope holds every scope created inside it. */
  idealHolding(x: ScopeId): boolean {
    const page = this.scopes.page.own > 0;
    return x === 'child' ? this.scopes.child.own > 0 || page : page;
  }
  /** Oracle: when the scope's current hold began (model time). */
  since(x: ScopeId): number {
    return this.scopes[x === 'branch' ? 'page' : x].since ?? Infinity;
  }
  private updateSince(): void {
    for (const x of ['page', 'child'] as const) {
      const sc = this.scopes[x];
      if (!this.idealHolding(x)) sc.since = undefined;
      else if (sc.since === undefined) {
        sc.since = this.time;
        sc.sinceSeq = this.seqs;
      }
    }
  }
  scopeOfRes(i: number): 'page' | 'child' {
    return this.opt.twoScope && i === RES - 1 ? 'child' : 'page';
  }
  currentBody(): Id | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }
  counts(): number[] {
    return this.res.map((r) => r.count);
  }

  // ─── truth layer + live guess layer ────────────────────────────────────────────────────

  /** Later-writer detection: stamps on guess-capable nodes, `Object.is` on plain ones. */
  same(n: Sig, a: Cell, b: Cell): boolean {
    return GUESSABLE.includes(n) && this.opt.detect === 'stamp'
      ? a.s === b.s
      : Object.is(a.v, b.v);
  }
  display(n: Sig): Cell {
    return this.cells.get(n) as Cell;
  }
  // optimistic-proofs `LiveMachine.sync`: a guess the cell no longer carries is buried for good
  sync(n: Sig): GuessState | undefined {
    const g = this.gs.get(n);
    if (g && !this.same(n, this.display(n), g.mine)) this.gs.delete(n);
    return this.gs.get(n);
  }
  guessInEffect(n: Sig): boolean {
    return this.opt.guessRule === 'history' && !!this.sync(n);
  }
  /** The truth beneath any live guess: what undo logs record and restore. */
  truthGet(t: Target): Cell | Tree {
    if (t === ROOT) return this.root;
    const g = this.opt.guessRule === 'history' ? this.sync(t) : undefined;
    return g ? g.truth : this.display(t);
  }
  truthSet(t: Target, v: Cell | Tree): void {
    if (t === ROOT) {
      this.root = v as Tree;
      return;
    }
    const g = this.opt.guessRule === 'history' ? this.sync(t) : undefined;
    if (g) g.truth = v as Cell;
    else this.cells.set(t, v as Cell);
  }

  // ─── the undo ledger (transaction-proofs `Ledger`: 'generation' and 'blind' variants) ───

  record(t: Txn, target: Target, kind: LEntry['kind']): void {
    if (t.status === 'settled') return; // the write lands unrecorded
    const mineFor = t.log.filter((e) => e.target === target);
    const latest = mineFor[mineFor.length - 1];
    if (this.opt.restore === 'blind') {
      if (latest) {
        latest.open = true;
        return;
      }
    } else if (
      latest &&
      latest.open &&
      this.owner.get(target) === latest &&
      latest.kind === kind
    )
      return;
    const cur = this.owner.get(target);
    if (cur) this.finalize(cur);
    const e: LEntry = {
      tx: t.id,
      gen: ++t.gen,
      seq: ++this.seqs,
      at: this.time,
      kind,
      target,
      pre: this.truthGet(target),
      mine: undefined,
      open: true,
      prev: cur,
    };
    t.log.push(e);
    this.owner.set(target, e);
    this.allEntries.push(e);
    if (this.registryBound() !== undefined) this.registry.push(e);
    if (!t.seedLog.has(target)) t.seedLog.set(target, e);
  }
  finalize(e: LEntry): void {
    if (!e.open) return;
    e.open = false;
    e.mine = this.truthGet(e.target);
  }
  /** One atomic compare-and-restore. */
  undo(e: LEntry): void {
    const cur = this.truthGet(e.target);
    const owned = this.owner.get(e.target) === e;
    if (e.target === ROOT && this.opt.restore !== 'blind') {
      const next = merge3(e.mine, cur, e.pre) as Tree;
      if (next !== cur) this.truthSet(ROOT, next);
    } else if (
      this.opt.restore === 'blind' ||
      (owned &&
        e.target !== ROOT &&
        this.same(e.target, cur as Cell, e.mine as Cell))
    ) {
      this.truthSet(e.target, e.pre);
    }
    if (owned) {
      if (e.prev) this.owner.set(e.target, e.prev);
      else this.owner.delete(e.target);
    }
  }

  // ─── attribution (attribution-proofs `claimsEnv` = transition-scope claims ledger) ─────

  claim(t: Txn): void {
    const before = t.sliceBefore as number[];
    this.counts().forEach((after, i) => {
      if (this.scopeOfRes(i) !== t.scope) return; // `snapshotLoads` reads the scope's own resources
      let byCount = this.claims.get(i);
      if (!byCount) this.claims.set(i, (byCount = new Map()));
      for (let c = before[i] + 1; c <= after; c++)
        if (!byCount.has(c)) byCount.set(c, t.id);
    });
  }
  releaseClaims(t: Txn): void {
    for (const byCount of this.claims.values())
      for (const [c, o] of byCount) if (o === t.id) byCount.set(c, null);
  }
  attributedEach(t: Txn): boolean[] {
    return this.res.map((r, i) => {
      if (t.status === 'settled' || !r.loading) return false;
      if (this.scopeOfRes(i) !== t.scope) return false;
      if (this.opt.attribution === 'zone')
        return r.at >= t.openedAt && r.zone.includes(t.id);
      const claimedBy = this.claims.get(i)?.get(r.count);
      if (claimedBy !== undefined) return claimedBy === t.id;
      return !t.pre[i] || r.count > t.loads0[i];
    });
  }
  pending(t: Txn): boolean {
    return this.attributedEach(t).some(Boolean);
  }
  /** The page scope's pending (a branch's per-view scope is modelled with the page's resources). */
  scopePending(): boolean {
    return this.res.some((r, i) => r.loading && this.scopeOfRes(i) === 'page');
  }

  // ─── writes, guesses, flights ──────────────────────────────────────────────────────────

  /** T3 oracle bookkeeping: every truth-layer write, in order. */
  readonly truthWrites: {
    readonly key: Sig | Leaf;
    readonly v: string;
    readonly s: number;
    readonly by: Id | 'F';
    readonly kind: 'auth' | 'guess';
  }[] = [];
  readonly stats = new Map<string, number>();
  bump(k: string, n = 1): void {
    this.stats.set(k, (this.stats.get(k) ?? 0) + n);
  }

  private claimersNow(): Id[] {
    if (this.opt.attribution === 'zone')
      return this.open()
        .filter((t) => t.status === 'running')
        .map((t) => t.id);
    const cur = this.currentBody();
    return cur && !this.settled(cur) ? [cur] : [];
  }
  /** T1: a write inside a slice is recorded by that slice's body and no other; outside, by none. */
  private claimWrite(target: Target): Id | 'F' {
    const cur = this.currentBody();
    const claimers = this.claimersNow();
    const want = cur && !this.settled(cur) ? [cur] : [];
    if (claimers.join() !== want.join()) this.bad.add('T1-write');
    for (const c of claimers) this.record(this.txn(c), target, 'authoritative');
    return cur ?? 'F';
  }
  private noteTruth(
    key: Sig | Leaf,
    v: string,
    s: number,
    by: Id | 'F',
    kind: 'auth' | 'guess',
  ) {
    this.truthWrites.push({ key, v, s, by, kind });
  }

  /** `v` given = an equal-value confirmation; otherwise a fresh value tagged by its writer. */
  writeSig(n: Sig, spec: { v?: string; poison?: boolean } = {}): void {
    this.time++;
    if (this.guessInEffect(n))
      this.bump(
        spec.v === this.display(n).v ? 'T4-confirmed-guess' : 'T4-burials',
      );
    const by = this.claimWrite(n);
    const v = spec.v ?? `${by}#${++this.ids}${spec.poison ? '!' : ''}`;
    const c = this.cell(v, 'auth', by);
    this.cells.set(n, c);
    this.lastAuth.set(n, this.time);
    this.noteTruth(n, v, c.s, by, 'auth');
    this.log({ k: 'write', n, v });
  }
  writeTree(leaves: readonly Leaf[], suffix = ''): void {
    this.time++;
    const by = this.claimWrite(ROOT);
    const tag = `${by}#${++this.ids}${suffix}`;
    let next = this.root;
    const vs = leaves.map((leaf, i) => {
      const v = `${tag}.${i}`;
      next = writeLeaf(next, leaf, v);
      this.noteTruth(leaf, v, 0, by, 'auth');
      return v;
    });
    // two leaves of `a` replaced as one object: fresh references along the whole subtree
    this.root = leaves.length > 1 ? { ...next, a: { ...next.a } } : next;
    this.log({ k: 'tree', leaves, vs });
  }

  guessLive(n: Sig, v: string): void {
    const cur = this.currentBody();
    if (!cur || this.settled(cur)) return;
    this.log({ k: 'guess', id: cur, n, v });
    this.time++;
    const t = this.txn(cur);
    const gen = ++t.gen;
    this.oGuesses.push({ b: cur, order: t.order, gen, v, n, time: this.time });
    if (this.opt.guessRule === 'entry') {
      // a revert-always entry, written live (transaction-proofs `Ledger`, kind 'guess')
      for (const c of this.claimersNow()) this.record(this.txn(c), n, 'guess');
      const c = this.cell(v, 'guess', cur);
      this.cells.set(n, c);
      this.noteTruth(n, v, c.s, cur, 'guess');
      return;
    }
    if (this.opt.guessRule === 'snapshot') {
      // optimistic-proofs `LiveMachine.guess` with history off
      const key = `${cur}|${n}`;
      const pre = this.snaps.get(key)?.pre ?? this.display(n);
      const mine = this.cell(v, 'guess', cur);
      this.cells.set(n, mine);
      this.snaps.set(key, { pre, mine });
      return;
    }
    let g = this.sync(n);
    if (!g) {
      const c = this.display(n);
      g = { hist: [], truth: c, mine: c };
      this.gs.set(n, g);
    }
    g.hist.push({ b: cur, order: t.order, gen, v });
    this.apply(n, g);
  }
  // optimistic-proofs `LiveMachine.apply`
  private apply(n: Sig, g: GuessState): void {
    let top = g.hist[0];
    for (const e of g.hist)
      if (e.order > top.order || (e.order === top.order && e.gen > top.gen))
        top = e;
    g.mine = this.cell(top.v, 'guess', top.b);
    this.cells.set(n, g.mine);
  }

  guessOverlay(leaf: Leaf, v: string): void {
    const cur = this.currentBody();
    if (!cur || this.settled(cur)) return;
    this.log({ k: 'overlay', id: cur, p: leaf, v });
    this.time++;
    const t = this.txn(cur);
    const f = this.fork(t);
    (t.fork as { value: Tree }).value = writeLeaf(f, leaf, v);
    this.oOverlay.push({ b: cur, order: t.order, gen: ++t.gen, v, p: leaf });
  }
  // optimistic-proofs `OverlayMachine.fork`: re-link to a moved base the way forkStore does
  fork(t: Txn): Tree {
    const f = t.fork as { ancestor: Tree; value: Tree };
    if (f.ancestor !== this.root) {
      f.value = merge3(f.ancestor, f.value, this.root) as Tree;
      f.ancestor = this.root;
    }
    return f.value;
  }
  // optimistic-proofs `OverlayMachine.facade`, fold 'all'
  facade(p: Leaf): string {
    let v = this.root;
    for (const t of this.open().sort((a, b) => a.order - b.order))
      if (t.fork) v = merge3(this.root, this.fork(t), v) as Tree;
    return readLeaf(v, p);
  }

  startRes(i: number, mode: 'sync' | 'scheduled' | 'foreign'): void {
    this.time++;
    const r = this.res[i];
    // the innermost slice whose transaction is on the resource's scope claims it at its exit
    const scope = this.scopeOfRes(i);
    const cur =
      mode === 'sync'
        ? [...this.stack].reverse().find((id) => this.txn(id).scope === scope)
        : undefined;
    r.loading = true;
    r.count++;
    r.at = this.time;
    r.by = cur && !this.settled(cur) ? cur : null;
    r.zone = this.open()
      .filter((t) => t.status === 'running')
      .map((t) => t.id);
    this.progress();
    this.log({ k: 'start', i });
  }
  settleRes(i: number): void {
    this.time++;
    this.res[i].loading = false;
    this.progress();
    this.log({ k: 'settle', i });
  }

  // ─── lifecycle (async-transaction-proofs `World`, slices per transaction.ts `enter`) ────

  openBody(id: Id, scope: 'page' | 'child' = 'page'): Txn {
    this.time++;
    const t = new Txn(
      id,
      this.txns.size,
      this.time,
      this.counts(),
      this.res.map((r) => r.loading),
      scope,
    );
    t.fork = { ancestor: this.root, value: this.root };
    this.txns.set(id, t);
    // transition-scope `beginHold` (hold-seed `beginHoldEpisode` at own 0 to 1), then the seeder
    const sc = this.scopes[scope];
    if (sc.own === 0) {
      if (sc.episodes++) this.bump(`T2-2s-${scope}-successive-episodes`);
      if (sc.seeders.length) this.bump(`T2-2s-${scope}-episode-drops-kept`);
      this.drop(sc, 'rehold');
      sc.episode = this.seqs;
    }
    sc.own++;
    sc.seeders.push(id);
    this.updateSince();
    this.pruneRegistry();
    this.rec?.push({ e: { k: 'open', id, scope } });
    return t;
  }
  /** transition-scope `endHold`: episode ends at own 0; seeders go only once nothing holds the scope. */
  private endHold(t: Txn): void {
    const sc = this.scopes[t.scope];
    if (this.opt.seedLife === 'settlement') this.drop(sc, 'settlement', t.id);
    sc.own--;
    if (sc.own === 0) {
      sc.episode = undefined;
      if (!this.holdingOf(t.scope)) this.drop(sc, 'hold-end');
      else if (this.opt.seedDrop === 'own0') this.drop(sc, 'own0');
      else this.bump(`T2-2s-${t.scope}-keeps-seeders`); // settled under the enclosing hold
    }
    this.updateSince();
    this.pruneRegistry();
  }

  enter(id: Id, fn: () => void): void {
    const t = this.txn(id);
    if (t.status === 'settled' && this.opt.closedEnter === 'throw') {
      this.log({ k: 'enterClosed', id });
      throw new ClosedError(id);
    }
    if (t.depth === 0) t.sliceBefore = this.counts();
    this.rec?.push({ e: { k: 'enter', id } });
    this.stack.push(id);
    t.depth++;
    try {
      fn();
    } finally {
      this.stack.pop();
      if (--t.depth === 0) {
        for (const e of t.log) this.finalize(e);
        if (t.status !== 'settled') this.claim(t);
      }
    }
    if (!this.stack.length) this.progress();
    this.log({ k: 'exit', id });
  }

  retain(id: Id): number {
    const t = this.txn(id);
    if (t.status === 'settled') throw new ClosedError(id);
    const r = ++this.ids;
    t.retains.add(r);
    this.log({ k: 'retain', id, r });
    return r;
  }
  release(id: Id, r: number): void {
    this.time++;
    this.txn(id).retains.delete(r);
    this.progress();
    this.log({ k: 'release', id, r });
  }
  /** A nested startTransaction inside a slice merges into the slice's transaction. */
  nestedStart(): { into: Id; token: number } {
    const into = this.currentBody();
    if (!into) throw new Error('model: nestedStart outside a slice');
    const token = ++this.ids;
    this.txn(into).nested.add(token);
    this.log({ k: 'nest', into, token });
    return { into, token };
  }
  nestedSettle(into: Id, token: number): void {
    this.time++;
    this.txn(into).nested.delete(token);
    this.progress();
    this.log({ k: 'nestSettle', token });
  }
  bodyReturn(id: Id): void {
    this.time++;
    const t = this.txn(id);
    if (t.status !== 'settled') {
      t.status = 'returned';
      this.progress();
    }
    this.log({ k: 'return', id });
  }
  bodyThrow(id: Id, error: unknown): void {
    this.time++;
    const t = this.txn(id);
    if (t.status !== 'settled') this.settle(t, { kind: 'failed', error }, true);
    this.log({ k: 'throw', id });
  }
  /** abort, supersede and destroy restore and settle at once (destroy restores, as abort). */
  cancel(id: Id, reason: Reason): void {
    this.time++;
    const t = this.txn(id);
    if (t.status !== 'settled')
      this.settle(t, { kind: 'aborted', reason }, true);
    this.log({ k: 'cancel', id, reason });
  }

  progress(): void {
    if (this.stack.length) return; // effects never run inside a synchronous slice
    for (const t of this.open()) {
      const p = this.pending(t);
      if (p) t.sawPending = true;
      const bodyDone =
        this.opt.hold === 'continuous'
          ? t.status === 'returned'
          : t.sawPending || t.rendered; // the no-async fallback of the sync form
      if (bodyDone && !p && t.retains.size === 0 && t.nested.size === 0)
        this.settle(t, { kind: 'completed' }, false);
    }
  }

  private truthKeys(): Map<
    Sig | Leaf,
    { by: Id | 'F' | null; v: string; s: number }
  > {
    const out = new Map<
      Sig | Leaf,
      { by: Id | 'F' | null; v: string; s: number }
    >();
    for (const n of SIGS) {
      const c = this.truthGet(n) as Cell;
      out.set(n, { by: c.by, v: c.v, s: c.s });
    }
    for (const l of LEAVES) {
      const v = readLeaf(this.root, l);
      const hash = v.indexOf('#');
      out.set(l, {
        by: hash > 0 ? (v.slice(0, hash) as Id | 'F') : null,
        v,
        s: 0,
      });
    }
    return out;
  }

  settle(t: Txn, outcome: Outcome, restore: boolean): void {
    this.time++;
    for (const g of this.oGuesses)
      if (
        g.b === t.id &&
        this.oGuesses.some((o) => o.b !== t.id && o.n === g.n)
      )
        this.bump(
          this.oGuesses.some(
            (o) => o.b !== t.id && o.n === g.n && o.order > t.order,
          )
            ? 'T4-older-settles-first'
            : 'T4-newer-settles-first',
        );
    if (
      outcome.kind === 'completed' &&
      (t.status !== 'returned' || t.retains.size || t.nested.size)
    )
      this.bad.add('T2-hold-spans-body');
    const before = this.truthKeys();
    t.status = 'settled';
    t.outcome = outcome;
    t.settledAt = this.time;
    t.resolutions++;
    // ledger settle: finalize, then undo newest-first
    for (const e of t.log) this.finalize(e);
    for (let i = t.log.length - 1; i >= 0; i--)
      if (
        restore ||
        (this.opt.guessRule === 'entry' && t.log[i].kind === 'guess')
      )
        this.undo(t.log[i]);
    t.log = [];
    // live guess layer: optimistic-proofs `LiveMachine.settle`
    if (this.opt.guessRule === 'history')
      for (const n of GUESSABLE) {
        const g = this.sync(n);
        if (!g) continue;
        g.hist = g.hist.filter((e) => e.b !== t.id);
        if (g.hist.length) this.apply(n, g);
        else {
          this.cells.set(n, g.truth); // the truth keeps its own stamp
          this.gs.delete(n);
        }
      }
    if (this.opt.guessRule === 'snapshot')
      for (const [key, rec] of [...this.snaps]) {
        if (!key.startsWith(`${t.id}|`)) continue;
        const n = key.slice(2) as Sig;
        if (this.same(n, this.display(n), rec.mine)) this.cells.set(n, rec.pre);
        this.snaps.delete(key);
      }
    // overlay tier: discard (or the killed commit)
    if (outcome.kind === 'completed' && this.opt.overlay === 'commit') {
      const staged = this.fork(t);
      for (const p of LEAVES)
        if (readLeaf(staged, p) !== readLeaf(this.root, p))
          this.baseWritesFromForks++;
      this.root = staged;
    }
    t.fork = undefined;
    for (let i = this.oGuesses.length - 1; i >= 0; i--)
      if (this.oGuesses[i].b === t.id) this.oGuesses.splice(i, 1);
    for (let i = this.oOverlay.length - 1; i >= 0; i--)
      if (this.oOverlay[i].b === t.id) this.oOverlay.splice(i, 1);
    this.settledGuessers.add(t.id);
    this.releaseClaims(t);
    t.retains.clear();
    t.nested.clear();
    this.endHold(t);
    this.checkSettle(t, before, restore);
  }

  /** T3 at every settlement (transaction-proofs `runTrace` settle checks). */
  private checkSettle(
    t: Txn,
    before: Map<Sig | Leaf, { by: Id | 'F' | null; v: string; s: number }>,
    restore: boolean,
  ): void {
    const after = this.truthKeys();
    let changed = false;
    for (const [k, b] of before) {
      const a = after.get(k) as { by: Id | 'F' | null; v: string; s: number };
      const isSig = (SIGS as readonly string[]).includes(k);
      const wrote = this.truthWrites.some((w) => w.key === k && w.by === t.id);
      if (isSig ? a.s !== b.s : a.v !== b.v) {
        changed = true;
        if (!restore && this.opt.guessRule !== 'entry')
          this.bad.add('T3-commit-moved');
        else if (b.by !== t.id) {
          const equalValue =
            PLAIN.includes(k as Sig) &&
            b.by === 'F' &&
            this.truthWrites.some(
              (w) => w.key === k && w.by === t.id && w.v === b.v,
            );
          if (equalValue) this.bump('L-equal-value');
          else this.bad.add('T3-undid-other');
        }
      } else if (restore && b.by !== t.id && wrote) this.bump('T3-yields');
      if (restore && a.by === t.id) this.bad.add('T3-own-survives');
    }
    if (restore && changed) this.bump('T3-effective-aborts');
  }

  // ─── display: held readers, the in-place boundary, the hold-and-swap ───────────────────

  reader(node: Sig, scope: ScopeId = 'page'): Reader {
    return { node, scope, rid: ++this.rids, last: undefined };
  }
  /** hold-seed `preHoldValueOf` chain: the scope, then its enclosing scope while that one holds. */
  chain(x: ScopeId): ('page' | 'child')[] {
    const up: 'page'[] =
      x !== 'page' && this.opt.inherit === 'chain' && this.holdingOf('page')
        ? ['page']
        : [];
    return x === 'page' ? ['page'] : x === 'child' ? ['child', ...up] : up;
  }
  /** The earliest hold episode over the chain (a seed counts only when recorded after it). */
  chainStart(x: ScopeId): number {
    let start = Infinity;
    for (const s of this.chain(x))
      start = Math.min(start, this.scopes[s].episode ?? Infinity);
    return start;
  }
  /**
   * hold-seed `preHoldValueOf` over the transaction seeders: each seeder registered on the chain
   * answers with its transaction's first entry for the node (open or settled, kept until the scope
   * drops it); the lowest record order wins.
   */
  seedOf(x: ScopeId, n: Sig): Cell | undefined {
    return this.seedEntry(x, n)?.pre as Cell | undefined;
  }
  seedEntry(x: ScopeId, n: Sig): LEntry | undefined {
    const found = this.seedCandidates(x, n).map((c) => c.e);
    if (this.opt.seedOrder === 'open') return found[0];
    return found.sort((a, b) => a.seq - b.seq)[0];
  }
  /** Each counted seeder's answer for the node, in chain then registration (open) order. */
  seedCandidates(x: ScopeId, n: Sig): { order: number; e: LEntry }[] {
    if (this.opt.seedScope === 'tree') {
      const from = this.scopes[x === 'branch' ? 'page' : x].sinceSeq;
      return this.registry
        .filter((e) => e.target === n && e.seq > from)
        .map((e) => ({ order: this.txn(e.tx).order, e }));
    }
    const start = this.chainStart(x);
    const filter = this.opt.episodeFilter === 'on' && start !== Infinity;
    return this.chain(x).flatMap((s) =>
      this.scopes[s].seeders.flatMap((id) => {
        const t = this.txn(id);
        const e = t.seedLog.get(n);
        return e && !(filter && e.seq <= start) ? [{ order: t.order, e }] : [];
      }),
    );
  }
  /**
   * The frame a held reader shows from: its linkedSignal memory, or, first evaluated during a
   * hold, the seeded pre (`hold`: `prev === undefined && curr.held` → the seed when found).
   */
  private frame(r: Reader): Reader['last'] {
    if (r.last || !this.holdingOf(r.scope) || this.opt.midHold !== 'seed')
      return r.last;
    const s = this.seedOf(r.scope, r.node);
    return s && { shown: s, truth: s, at: this.time };
  }
  /**
   * What a held reader shows now, without evaluating it (`scope.hold` is a linkedSignal that
   * keeps its previous value while holding; a reader with no previous value shows the seed, or
   * the live value when nothing seeds it). Over a guessed node the bypass shows a guess in
   * effect, and the frozen frame is the truth beneath any guess.
   */
  peekHeld(r: Reader): Cell {
    const last = this.frame(r);
    if (!this.holdingOf(r.scope) || !last) return this.display(r.node);
    if (this.opt.bypass !== 'none' && this.guessInEffect(r.node))
      return this.display(r.node);
    return this.opt.bypass === 'both' ? last.truth : last.shown;
  }
  readHeld(r: Reader): Cell {
    const v = this.peekHeld(r);
    const held = this.holdingOf(r.scope);
    if (!held || !r.last) {
      const first = !r.last;
      const seeded = held ? this.frame(r) : undefined;
      r.last = seeded ?? {
        shown: this.display(r.node),
        truth: this.truthGet(r.node) as Cell,
        at: this.time,
      };
      if (held) {
        const entries = this.seedCandidates(r.scope, r.node).map((c) => ({
          order: c.order,
          pre: c.e.pre as Cell,
        }));
        const settled = new Set(
          [...this.txns.values()]
            .filter((t) => t.status === 'settled')
            .map((t) => t.id),
        );
        r.last.born = { entries, settled };
        this.bump('T2-born-in-hold');
        if (entries.length) this.bump('T2-born-in-hold-recorded');
      }
      if (first && this.opt.twoScope) this.checkBorn(r);
    }
    return v;
  }
  /**
   * Two-scope oracle, independent of the seeders: a reader first evaluated while its scope is held
   * starts from the pre of the earliest entry, by any transaction on any scope, recorded since that
   * scope's hold began; with none, from the live truth. A miss is named by why the real lookup
   * could not see that entry.
   */
  private checkBorn(r: Reader): void {
    if (!this.idealHolding(r.scope)) return;
    const since = this.since(r.scope);
    let first: LEntry | undefined;
    for (const e of this.allEntries)
      if (e.target === r.node && e.at > since && (!first || e.seq < first.seq))
        first = e;
    const inherited = r.scope === 'child' && this.scopes.child.own === 0;
    this.bump(`T2-2s-born-${r.scope}${inherited ? '-inherited' : ''}`);
    if (first) {
      this.bump('T2-2s-born-recorded');
      const t = this.txn(first.tx);
      if (t.scope !== r.scope) this.bump('T2-2s-born-recorded-other-scope');
      if (t.status === 'settled') this.bump('T2-2s-born-recorded-settled');
    }
    const want = first ? first.pre : this.truthGet(r.node);
    if ((r.last as NonNullable<Reader['last']>).truth === want) return;
    this.bad.add(`T2-2s-${this.bornMiss(r, first)}`);
  }
  private bornMiss(r: Reader, first: LEntry | undefined): string {
    if (!this.holdingOf(r.scope)) return 'unheld';
    const won =
      this.opt.midHold === 'seed' ? this.seedEntry(r.scope, r.node) : undefined;
    if (!first || (won && won.at <= this.since(r.scope))) return 'stale-seed';
    const t = this.txn(first.tx);
    if (t.seedLog.get(r.node) !== first) return 'first-record-before-hold';
    if (r.scope !== 'child' && t.scope === 'child')
      return 'child-write-under-page';
    const sc = this.scopes[t.scope];
    if (
      r.scope === 'child' &&
      t.scope === 'page' &&
      (!this.chain(r.scope).includes('page') ||
        sc.dropped.get(t.id) === 'hold-end')
    )
      return 'parent-hold-ended';
    if (!sc.seeders.includes(t.id))
      return `seeder-dropped-${sc.dropped.get(t.id) ?? 'never-added'}`;
    if (
      this.opt.episodeFilter === 'on' &&
      first.seq <= this.chainStart(r.scope)
    )
      return 'seed-filtered';
    return 'seed-order';
  }
  /** What each reader shows now, by reader id (recorded right after an evaluation). */
  private shownBy(rs: readonly Reader[]): RecSnap['readers'] {
    return rs.map((r) => [r.rid, this.peekHeld(r).v] as const);
  }
  readers(): Reader[] {
    const out = [...this.page, ...this.mounted];
    for (const b of [this.current, this.incoming])
      if (b?.content) out.push(...b.content.readers);
    return out;
  }
  /** A view mounted on the page or the child scope, evaluated at once. */
  mount(node: Sig, scope: 'page' | 'child'): Reader {
    this.time++;
    const r = this.reader(node, scope);
    this.mounted.push(r);
    if (this.mounted.length > 6) this.mounted.shift();
    this.readHeld(r);
    this.log({ k: 'mount', rid: r.rid, n: node, scope }, this.shownBy([r]));
    return r;
  }

  /** A constructor reads `s1`: a poisoned `s1` is a creation throw. */
  private createContent(): Content | undefined {
    if (poisoned(this.display('s1').v)) return undefined;
    return {
      inst: ++this.ids,
      readers: [this.reader('s0'), this.reader('g0')],
      dom: [0, 1, 2, 3].map(() => ({ v: '', frame: -1 })),
      hidden: false,
      attached: true,
    };
  }
  branch(): Branch {
    const content = this.createContent();
    if (!content) this.bump('T5-creation-faults');
    return {
      id: ++this.ids,
      content,
      fault: content ? undefined : { kind: 'creation', inst: 0 },
      sawPending: this.scopePending(),
      sawHolding: false,
      rendered: false,
    };
  }
  /** Bindings in template order: held s0, live s1, held g0, a computed over the held two. */
  private evaluate(c: Content, frame: number): number {
    const bindings = [
      () => this.readHeld(c.readers[0]).v,
      () => this.display('s1').v,
      () => this.readHeld(c.readers[1]).v,
      () => `${this.peekHeld(c.readers[0]).v}+${this.peekHeld(c.readers[1]).v}`,
    ];
    for (let k = 0; k < bindings.length; k++) {
      const v = bindings[k]();
      if (poisoned(v)) return k; // bindings before k are already applied: a torn frame
      c.dom[k] = { v, frame };
    }
    return -1;
  }
  private fault(b: Branch, c: Content): void {
    if (this.opt.boundary === 'hide') c.hidden = true;
    c.attached = false;
    b.fault = { kind: 'update', inst: c.inst };
  }
  private renderBranch(b: Branch, frame: number): void {
    const c = b.content;
    if (!c || !c.attached || b.fault) return;
    if (this.evaluate(c, frame) >= 0) {
      this.bump('T5-update-faults');
      this.fault(b, c);
    }
  }
  /**
   * Names a seeded reader showing a body write. The two known classes have a precise witness: an
   * open entry whose pre IS the shown write; the seed came from it. A write by a younger open body
   * recorded over by an older one (cross-order), or a write by a body that already settled inside
   * the hold (settled writer). Anything else is a plain violation.
   */
  seedFault(born: Birth, shown: Cell): string {
    const by = shown.by as Id;
    const from = born.entries.filter((e) => e.pre === shown);
    if (from.length && born.settled.has(by))
      return 'T2-seed-after-settled-writer';
    const y = this.txns.get(by);
    if (y && !born.settled.has(by) && from.some((e) => e.order < y.order))
      return 'T2-seed-cross-order';
    return 'T2-born-in-hold-shows-body-write';
  }
  /** What the user sees of the committed branch. */
  visible(): string {
    const b = this.current;
    const c = b.content;
    return `${b.id}:${b.fault ? 'fallback' : '-'}:${c && !c.hidden ? c.dom.map((d) => d.v).join(',') : 'hidden'}`;
  }

  render(): void {
    this.time++;
    const frame = ++this.frames;
    this.renderBranch(this.current, frame);
    for (const r of this.page) this.readHeld(r);
    for (const r of this.mounted) this.readHeld(r);
    const evaluated = this.rec && this.shownBy([...this.page, ...this.mounted]);
    const inc = this.incoming;
    if (inc) {
      this.renderBranch(inc, frame);
      // MmTransition: commit once neither pending nor holding, after a pending or holding edge,
      // or after the first render if neither was ever seen
      const p = this.scopePending();
      const h = this.opt.swap === 'unheld' && this.swapHolding();
      if (p) inc.sawPending = true;
      if (h) inc.sawHolding = true;
      if ((inc.sawPending || inc.sawHolding) && !p && !h) this.commitSwap(inc);
      else if (!inc.rendered) {
        inc.rendered = true;
        if (!inc.sawPending && !p && !h) this.commitSwap(inc);
      }
    }
    for (const t of this.open()) t.rendered = true;
    if (this.holdingOf('page'))
      for (const r of this.page)
        if (
          this.peekHeld(r) !== this.display(r.node) &&
          this.display(r.node).by !== 'F'
        )
          this.bump('T2-held-hides-a-write');
    this.progress();
    this.log({ k: 'render' }, evaluated || undefined);
  }
  /** What the swap watcher reads as the incoming scope's `holding()`. */
  private swapHolding(): boolean {
    if (this.opt.inherit === 'none') return false;
    return this.opt.inherit === 'watcher'
      ? this.scopes.page.own > 0
      : this.holdingOf('branch');
  }
  navigate(): void {
    this.time++;
    if (this.incoming) this.bump('T5-retargets');
    this.incoming = this.branch();
  }
  private commitSwap(inc: Branch): void {
    const c = inc.content;
    const clean =
      !!c &&
      !inc.fault &&
      !c.hidden &&
      new Set(c.dom.map((d) => d.frame)).size === 1 &&
      c.dom[0].frame >= 0;
    const caught = !!inc.fault && (!c || c.hidden);
    if (this.scopePending() || !(clean || caught)) this.bad.add('T5-swap');
    // a branch mounted during a hold commits with the rest of the held tree, never ahead of it
    if (this.idealHolding('branch')) this.bad.add('T5-swap-under-hold');
    else if (inc.sawHolding) this.bump('T5-commits-at-release');
    if (inc.fault) this.bump('T5-commits-faulted');
    this.bump('T5-commits');
    this.current = inc;
    this.incoming = undefined;
  }
  /** errored.ts `retry`: re-attach and render the kept view now, or build it anew after a creation throw. */
  retry(): void {
    this.time++;
    const b = this.current;
    if (!b.fault) return;
    this.bump('T5-retries');
    const before = this.visible();
    const keptInst = b.fault.kind === 'update' ? b.fault.inst : undefined;
    let c = b.content;
    if (b.fault.kind === 'creation' || !c) {
      c = this.createContent();
      if (!c) {
        this.bump('T5-retry-failed');
        if (this.visible() !== before) this.bad.add('T5-retry-changed');
        return;
      }
      b.content = c;
    } else {
      c.hidden = false;
      c.attached = true;
    }
    if (this.evaluate(c, ++this.frames) >= 0) {
      this.fault(b, c);
      this.bump('T5-retry-failed');
      if (this.visible() !== before) this.bad.add('T5-retry-changed');
      return;
    }
    if (keptInst !== undefined && keptInst !== c.inst)
      this.bad.add('T5-instance-lost');
    b.fault = undefined;
    this.bump('T5-retry-clean');
  }

  // ─── oracles ───────────────────────────────────────────────────────────────────────────

  /** optimistic-proofs `Oracle.liveGuess`: the most recent open guess laid after the last authoritative write. */
  liveGuess(n: Sig): string | undefined {
    const since = this.lastAuth.get(n) ?? 0;
    let best: (GuessEntry & { time: number }) | undefined;
    for (const g of this.oGuesses) {
      if (g.n !== n || g.time <= since) continue;
      if (
        !best ||
        g.order > best.order ||
        (g.order === best.order && g.gen > best.gen)
      )
        best = g;
    }
    return best?.v;
  }
  /** optimistic-proofs `Oracle.overlay`: the most recent open overlay guess on a path. */
  overlayGuess(p: Leaf): string | undefined {
    let best: GuessEntry | undefined;
    for (const g of this.oOverlay) {
      if (g.p !== p) continue;
      if (
        !best ||
        g.order > best.order ||
        (g.order === best.order && g.gen > best.gen)
      )
        best = g;
    }
    return best?.v;
  }
  /** transaction-proofs `runTrace` alive rule: aborted writers and settled guesses are dead. */
  alive(w: World['truthWrites'][number]): boolean {
    if (w.by === 'F') return true;
    const t = this.txn(w.by);
    if (t.status !== 'settled') return true;
    if ((t.outcome as Outcome).kind !== 'completed') return false;
    return w.kind !== 'guess';
  }

  /** Every theorem that is a state invariant, checked after every event. */
  check(): void {
    // the registry keeps exactly the entries after the lowest held stretch start: nothing a
    // reader consults is pruned, and nothing older is kept
    const bound = this.registryBound();
    const live = this.allEntries.filter(
      (e) => bound !== undefined && e.seq > bound,
    );
    if (this.registry.length > live.length) this.bad.add('T2-registry-size');
    if (live.some((e) => !this.registry.includes(e)))
      this.bad.add('T2-registry-pruned-live');
    if (this.registry.length) this.bump('T2-registry-kept');
    const open = this.open();
    // T2: one hold per unsettled body, on its own scope
    for (const x of ['page', 'child'] as const)
      if (this.scopes[x].own !== open.filter((t) => t.scope === x).length)
        this.bad.add('T2-hold-accounting');
    {
      for (const r of this.readers()) {
        if (!r.last || !this.idealHolding(r.scope)) continue;
        const since = this.since(r.scope);
        const held = this.holdingOf(r.scope);
        const shown = this.peekHeld(r);
        const lg = GUESSABLE.includes(r.node)
          ? this.liveGuess(r.node)
          : undefined;
        // with the bypass on, a frame frozen before the hold shows a guess in effect, else the truth
        if (
          held &&
          this.opt.bypass !== 'none' &&
          GUESSABLE.includes(r.node) &&
          r.last.at < since &&
          shown.v !== (lg ?? r.last.truth.v)
        )
          this.bad.add('T4-held-visibility');
        if (held && shown.kind === 'guess' && this.settled(shown.by as Id))
          this.bad.add('T4-held-phantom');
        const bypassed = lg !== undefined && shown === this.display(r.node);
        const bodyWrite =
          shown.kind === 'auth' && shown.by !== 'F' && shown.at >= since;
        if (bypassed || !bodyWrite) continue;
        if (!held) this.bad.add('T2-unheld-shows-body-write');
        else if (r.last.at < since) this.bad.add('T2-held-shows-body-write');
        else if (r.last.born?.entries.length)
          this.bad.add(this.seedFault(r.last.born, shown));
        else {
          // L5: nothing open recorded the node when the reader was first evaluated
          this.bump('L5-born-in-hold-unrecorded');
          const c = this.current.content;
          if (c && !c.hidden && c.readers.includes(r))
            this.bump('L5-born-in-hold-unrecorded-visible');
        }
      }
    }
    // T3: the truth layer equals the ideal, up to the stated limits
    const actual = this.truthKeys();
    for (const [k, a] of actual) {
      const isSig = (SIGS as readonly string[]).includes(k);
      let ideal: World['truthWrites'][number] | undefined;
      for (let i = this.truthWrites.length - 1; i >= 0 && !ideal; i--) {
        const w = this.truthWrites[i];
        if (w.key === k && this.alive(w)) ideal = w;
      }
      const ok = ideal
        ? isSig
          ? a.s === ideal.s
          : a.v === ideal.v
        : a.v === `init:${k}`;
      if (ok) continue;
      // stated limit: on a plain node an unrecorded write re-landing a dead writer's value is
      // invisible to that writer's rollback (`Object.is` cannot tell them apart)
      const equalValue =
        !!ideal &&
        ideal.by === 'F' &&
        PLAIN.includes(k as Sig) &&
        this.truthWrites.some(
          (x) =>
            x.key === k && x.by !== 'F' && !this.alive(x) && x.v === ideal?.v,
        );
      if (equalValue) {
        this.bump('L-equal-value-diverged');
        continue;
      }
      const w = this.truthWrites.find(
        (x) => x.key === k && (isSig ? x.s === a.s : x.v === a.v),
      );
      if (w && !this.alive(w)) this.bump('T3-resurrections');
      else this.bad.add('T3-ideal');
    }
    // T4: live tier visibility, phantoms, no guess in an undo log
    for (const n of GUESSABLE) {
      const disp = this.display(n);
      const lg = this.liveGuess(n);
      // a guess only exists while its body is open, so always under that body's hold
      if (lg !== undefined) this.bump('T4-guess-shown-held');
      if (lg !== undefined && disp.v !== lg) this.bad.add('T4-visibility');
      if (
        lg === undefined &&
        this.opt.guessRule === 'history' &&
        disp.v !== (this.truthGet(n) as Cell).v
      )
        this.bad.add('T4-visibility');
      if (disp.kind === 'guess' && this.settled(disp.by as Id))
        this.bad.add('T4-phantom');
    }
    for (const t of open)
      for (const e of t.log)
        if (
          e.target !== ROOT
            ? (e.pre as Cell).kind === 'guess'
            : JSON.stringify(e.pre).includes('~')
        )
          this.bad.add('T4-guess-in-undo-log');
    // T4: overlay tier
    for (const p of LEAVES) {
      if (this.overlayGuess(p) !== undefined) this.bump('T4-overlay-shown');
      const want = this.overlayGuess(p) ?? readLeaf(this.root, p);
      if (this.facade(p) !== want) this.bad.add('T4-overlay-visibility');
      if (readLeaf(this.root, p).includes('~'))
        this.bad.add('T4-base-has-guess');
    }
    if (this.baseWritesFromForks) this.bad.add('T4-discard-writes-base');
    // T5: what is visible of the committed branch is one clean frame, or the fallback
    const b = this.current;
    const c = b.content;
    if (c && !c.hidden) {
      const frames = new Set(c.dom.map((d) => d.frame));
      if (
        b.fault ||
        frames.size !== 1 ||
        c.dom[0].frame < 0 ||
        c.dom.some((d) => poisoned(d.v))
      )
        this.bad.add('T5-torn-visible');
    }
    if (b.fault?.kind === 'update' && c?.inst !== b.fault.inst)
      this.bad.add('T5-instance-lost');
  }

  /** T4 no-leak, once every body settled. */
  checkQuiescent(): void {
    for (const n of GUESSABLE) {
      if (this.display(n).kind === 'guess' || this.gs.size)
        this.bad.add('T4-no-leak');
      if (this.display(n) !== this.truthGet(n)) this.bad.add('T4-no-leak');
    }
    for (const p of LEAVES)
      if (
        this.facade(p) !== readLeaf(this.root, p) ||
        readLeaf(this.root, p).includes('~')
      )
        this.bad.add('T4-no-leak');
    for (const t of this.txns.values()) if (t.fork) this.bad.add('T4-no-leak');
  }
}

// ─── generated traces ────────────────────────────────────────────────────────────────────

type SliceOp =
  | { readonly k: 'write'; readonly n: Sig; readonly poison: boolean }
  | { readonly k: 'tree'; readonly leaves: readonly Leaf[] }
  | { readonly k: 'guess'; readonly n: Sig }
  | { readonly k: 'overlay'; readonly p: Leaf }
  | { readonly k: 'start'; readonly i: number }
  | { readonly k: 'schedule'; readonly i: number }
  | { readonly k: 'nest'; readonly ops: readonly SliceOp[] }
  | { readonly k: 'other'; readonly ops: readonly SliceOp[] }
  | { readonly k: 'retain' };
type Step =
  | { readonly k: 'slice'; readonly ops: readonly SliceOp[] }
  | { readonly k: 'unwrapped'; readonly n: Sig }
  | { readonly k: 'end'; readonly throws: boolean };

function genScript(r: () => number): Step[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const simple = (): SliceOp => {
    const x = r();
    if (x < 0.4) return { k: 'write', n: pick(SIGS), poison: r() < 0.12 };
    if (x < 0.6) return { k: 'tree', leaves: [pick(LEAVES)] };
    if (x < 0.8) return { k: 'guess', n: pick(GUESSABLE) };
    return { k: 'start', i: Math.floor(r() * RES) };
  };
  const op = (): SliceOp => {
    const x = r();
    if (x < 0.32) return { k: 'write', n: pick(SIGS), poison: r() < 0.12 };
    if (x < 0.42) return { k: 'tree', leaves: [pick(LEAVES)] };
    if (x < 0.46) return { k: 'tree', leaves: ['a.p', 'a.q'] };
    if (x < 0.62) return { k: 'guess', n: pick(GUESSABLE) };
    if (x < 0.7) return { k: 'overlay', p: pick(LEAVES) };
    if (x < 0.8) return { k: 'start', i: Math.floor(r() * RES) };
    if (x < 0.87) return { k: 'schedule', i: Math.floor(r() * RES) };
    if (x < 0.91) return { k: 'nest', ops: [simple(), simple()] };
    if (x < 0.95) return { k: 'other', ops: [simple(), simple()] };
    return { k: 'retain' };
  };
  const slice = (): Step => ({
    k: 'slice',
    ops: Array.from({ length: 1 + Math.floor(r() * 3) }, op),
  });
  const steps: Step[] = [slice()];
  const more = 1 + Math.floor(r() * 4);
  for (let i = 0; i < more; i++) {
    if (r() < 0.25) steps.push({ k: 'unwrapped', n: pick(SIGS) });
    steps.push(slice());
  }
  steps.push({ k: 'end', throws: r() < 0.2 });
  return steps;
}

type Body = {
  readonly id: Id;
  readonly scope: 'page' | 'child';
  readonly script: Step[];
  cursor: number;
  opened: boolean;
  ended: boolean;
  cancelled: boolean;
};

type Run = { readonly bad: Set<string>; readonly stats: Map<string, number> };

/** One generated interleaving; `biased` favours the orders the theorems are most exposed to. */
/** A script the real code can run: guesses become plain writes, writes go to plain signals. */
function replayable(steps: Step[]): Step[] {
  const plain = (n: Sig): Sig => PLAIN[SIGS.indexOf(n) % PLAIN.length];
  const op = (o: SliceOp): SliceOp =>
    o.k === 'write' || o.k === 'guess'
      ? { k: 'write', n: plain(o.n), poison: false }
      : o.k === 'overlay'
        ? { k: 'tree', leaves: [o.p] }
        : o.k === 'nest' || o.k === 'other'
          ? { ...o, ops: o.ops.map(op) }
          : o;
  return steps.map((s) =>
    s.k === 'slice'
      ? { k: 'slice', ops: s.ops.map(op) }
      : s.k === 'unwrapped'
        ? { k: 'unwrapped', n: plain(s.n) }
        : s,
  );
}

/** Unchanged scripts outside a replay; a replay with guesses keeps everything but faults. */
function noFaults(steps: Step[]): Step[] {
  const op = (o: SliceOp): SliceOp =>
    o.k === 'write'
      ? { ...o, poison: false }
      : o.k === 'nest' || o.k === 'other'
        ? { ...o, ops: o.ops.map(op) }
        : o;
  return steps.map((s) =>
    s.k === 'slice' ? { k: 'slice', ops: s.ops.map(op) } : s,
  );
}

function runTrace(
  seed: number,
  opt: Options,
  biased: boolean,
  rec?: Rec[],
): Run {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const w = new World(opt);
  w.rec = rec;
  const writable = opt.replayable === 'plain' ? PLAIN : SIGS;
  const two = opt.twoScope;
  const ids: Id[] = two
    ? r() < 0.5
      ? ['A', 'B', 'C', 'D']
      : ['A', 'B', 'C']
    : r() < 0.4
      ? ['A', 'B', 'C']
      : ['A', 'B'];
  const bodies: Body[] = ids.map((id) => ({
    id,
    scope: two && r() < 0.5 ? 'child' : 'page',
    script:
      opt.replayable === 'plain'
        ? replayable(genScript(r))
        : opt.replayable === 'guesses'
          ? noFaults(genScript(r))
          : genScript(r),
    cursor: 0,
    opened: false,
    ended: false,
    cancelled: false,
  }));
  const scheduled: { by: Id; i: number }[] = [];
  const retains: [Id, number][] = [];
  const nested: { into: Id; token: number }[] = [];
  const followUps: (() => void)[] = [];
  let uniq = 0;
  let destroyed = false;
  const fingerprint = () =>
    JSON.stringify([[...w.cells.values()].map((c) => c.s), w.root, w.counts()]);
  const settlements = () =>
    JSON.stringify([...w.txns.values()].map((t) => [t.outcome, t.resolutions]));

  const runOp = (id: Id, op: SliceOp): void => {
    switch (op.k) {
      case 'write':
        return w.writeSig(op.n, { poison: op.poison });
      case 'tree':
        return w.writeTree(op.leaves);
      case 'guess':
        return w.guessLive(op.n, `${id}~${++uniq}`);
      case 'overlay':
        return w.guessOverlay(op.p, `${id}~${++uniq}`);
      case 'start':
        if (w.open().length > 1) w.bump('T1-starts-with-overlap');
        return w.startRes(op.i, 'sync');
      case 'schedule':
        scheduled.push({ by: id, i: op.i });
        return;
      case 'nest':
        nested.push(w.nestedStart());
        w.bump('T1-nested');
        return op.ops.forEach((o) => runOp(id, o));
      case 'other': {
        const others = w.open().filter((t) => t.id !== id);
        if (!others.length) return;
        const y = pick(others).id;
        w.bump('T1-enter-other');
        return w.enter(y, () => op.ops.forEach((o) => runOp(y, o)));
      }
      case 'retain':
        retains.push([id, w.retain(id)]);
        return;
    }
  };

  const runSlice = (b: Body, ops: readonly SliceOp[]): void => {
    const wasSettled = w.settled(b.id);
    const before = fingerprint();
    try {
      w.enter(b.id, () => ops.forEach((op) => runOp(b.id, op)));
    } catch (e) {
      if (!(e instanceof ClosedError)) throw e;
      w.bump('T6-closed-enters');
      if (fingerprint() !== before) w.bad.add('T6-closed-enter');
      b.ended = true;
      return;
    }
    if (wasSettled) w.bad.add('T6-closed-enter');
    if (biased) {
      const wrote = ops.flatMap((o) =>
        o.k === 'write' || o.k === 'guess' ? [o.n] : [],
      );
      if (two && wrote.length && r() < 0.35)
        followUps.push(() => mount(pick(wrote)));
      const x = r();
      if (x < 0.3) followUps.push(() => w.render());
      else if (x < 0.5 && scheduled.length) followUps.push(runScheduled);
      else if (x < 0.75 && wrote.length)
        followUps.push(
          () => foreignWrite(pick(wrote)),
          () => w.render(),
        );
      else followUps.push(settleRace);
    }
  };

  const stepBody = (b: Body): void => {
    if (!b.opened) {
      b.opened = true;
      w.openBody(b.id, b.scope); // beginHold, then the synchronous prefix
    }
    const step = b.script[b.cursor++];
    const late = w.settled(b.id);
    if (step.k === 'slice') runSlice(b, step.ops);
    else if (step.k === 'unwrapped') {
      w.writeSig(step.n); // a continuation writing after an await without enter
      if (late) {
        w.bump('L3-late-unwrapped');
        if (w.display(step.n).by !== 'F' || w.display(step.n).at !== w.time)
          w.bad.add('L3-late-unwrapped');
      }
    } else {
      b.ended = true;
      const before = late ? [fingerprint(), settlements()].join() : '';
      if (step.throws) w.bodyThrow(b.id, new Error(`body ${b.id} failed`));
      else w.bodyReturn(b.id);
      if (late) {
        w.bump('T6-late-landings');
        if ([fingerprint(), settlements()].join() !== before)
          w.bad.add('T6-late-landing');
      }
    }
    if (b.cursor >= b.script.length) b.ended = true;
  };

  const mount = (n: Sig): void => {
    w.mount(n, r() < 0.5 ? 'child' : 'page');
  };
  const foreignWrite = (n: Sig): void => {
    if (r() < 0.35)
      w.writeSig(n, { v: w.display(n).v }); // a refetch confirming what is shown
    else w.writeSig(n);
  };
  function runScheduled(): void {
    const s = scheduled.shift();
    if (!s) return;
    const holdBefore = w.holdCount;
    const closed = w.settled(s.by);
    w.startRes(s.i, 'scheduled');
    if (closed) {
      w.bump('T6-late-scheduled');
      if (
        w.holdCount !== holdBefore ||
        w.attributedEach(w.txn(s.by)).some(Boolean)
      )
        w.bad.add('T6-late-scheduled');
    }
    if (w.open().some((t) => t.id !== s.by && w.attributedEach(t)[s.i]))
      w.bump('L1-scheduled-counted-by-other');
  }
  function settleRace(): void {
    const live = bodies.filter(
      (b) => b.opened && !w.settled(b.id) && !b.cancelled,
    );
    const loading = w.res.flatMap((x, i) => (x.loading ? [i] : []));
    if (loading.length) w.settleRes(pick(loading));
    if (live.length) {
      const b = pick(live);
      b.cancelled = true;
      w.cancel(b.id, pick(['abort', 'superseded'] as const));
    }
  }

  const invariants = (): void => {
    w.check();
    for (const t of w.txns.values())
      if (t.status === 'settled' && t.resolutions !== 1)
        w.bad.add('T6-done-once');
    const open = w.open();
    w.res.forEach((x, i) => {
      if (!x.loading) return;
      for (const t of open) {
        const got = w.attributedEach(t)[i];
        if (x.by !== null) {
          // claimed in a slice: the starter's while open, nobody's once it settled
          if (got !== (t.id === x.by && !w.settled(x.by)))
            w.bad.add('T1-flight');
          if (w.settled(x.by) && !got) w.bump('T1-settled-claim-unadopted');
        } else {
          const window = x.at >= t.openedAt && w.scopeOfRes(i) === t.scope;
          if (got !== window) w.bad.add('L1-window');
        }
      }
    });
  };

  const actions: (() => boolean)[] = [
    () => {
      const ready = bodies.filter((b) => !b.ended);
      if (!ready.length) return false;
      stepBody(pick(ready));
      return true;
    },
    () => (foreignWrite(pick(writable)), true),
    () => (w.writeTree([pick(LEAVES)]), true),
    () => (w.startRes(Math.floor(r() * RES), 'foreign'), true),
    () => {
      const loading = w.res.flatMap((x, i) => (x.loading ? [i] : []));
      if (!loading.length) return false;
      const i = pick(loading);
      w.settleRes(i);
      if (r() < 0.3) w.startRes(i, 'foreign'); // same-tick settle and refire
      return true;
    },
    () => {
      if (!scheduled.length) return false;
      runScheduled();
      return true;
    },
    () => {
      const x = retains.shift();
      if (!x) return false;
      w.release(...x);
      return true;
    },
    () => {
      const x = nested.shift();
      if (!x) return false;
      w.nestedSettle(x.into, x.token);
      return true;
    },
    () => (w.render(), true),
    () => (w.retry(), true),
    () => (w.navigate(), true),
    () => (mount(pick(SIGS)), true),
  ];
  const weights = [0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 5, 6, 7, 8, 8, 8, 9, 10];
  if (two) weights.push(11, 11, 11);
  if (opt.replayable !== 'no') weights.splice(weights.indexOf(9), 2); // no retries, no navigations
  const settledCount = () =>
    [...w.txns.values()].filter((t) => t.status === 'settled').length;

  for (let turn = 0; turn < 220; turn++) {
    const settledBefore = two && biased ? settledCount() : 0;
    const next = followUps.shift();
    if (next) next();
    else {
      const x = r();
      const live = bodies.filter(
        (b) => b.opened && !w.settled(b.id) && !b.cancelled,
      );
      if (x < 0.05 && live.length) {
        const b = pick(live);
        b.cancelled = true;
        w.cancel(b.id, pick(['abort', 'superseded'] as const));
      } else if (x < 0.06 && !destroyed && live.length) {
        destroyed = true;
        for (const t of w.open()) w.cancel(t.id, 'destroyed');
      } else {
        const start = Math.floor(r() * weights.length);
        for (let i = 0; i < weights.length; i++)
          if (actions[weights[(start + i) % weights.length]]()) break;
      }
    }
    invariants();
    // a view mounted right after a settlement: the frame kept seeders and episodes must cover
    if (two && biased && settledCount() > settledBefore)
      followUps.push(() => mount(pick(SIGS)));
    if (bodies.every((b) => b.ended) && !scheduled.length && !followUps.length)
      break;
  }
  // drain: finish every script (continuations outlive their cancels), start, settle, release
  for (const b of bodies)
    while (!b.ended) {
      stepBody(b);
      invariants();
    }
  for (let guard = 0; guard < 50; guard++) {
    const moved = [5, 6, 7, 4].some((a) => actions[a]());
    w.render();
    invariants();
    if (!moved) break;
  }
  for (const t of w.txns.values())
    if (t.status !== 'settled') w.bad.add('liveness');
  if (w.holdCount !== 0) w.bad.add('T2-hold-accounting');
  w.checkQuiescent();
  return { bad: w.bad, stats: w.stats };
}

// ─── sweeps ──────────────────────────────────────────────────────────────────────────────

const SEEDS = 1500; // per generator mode: uniform and biased, so 3000 traces per theorem
const ALT_SEEDS = 600;

type Sweep = {
  readonly bad: Map<string, number[]>;
  readonly stats: Map<string, number>;
};
function sweep(opt: Options, seeds = SEEDS): Sweep {
  const bad = new Map<string, number[]>();
  const stats = new Map<string, number>();
  for (const biased of [false, true])
    for (let seed = 1; seed <= seeds; seed++) {
      const run = runTrace(seed, opt, biased);
      for (const v of run.bad) {
        const seen = bad.get(v) ?? [];
        if (seen.length < 3) seen.push(biased ? -seed : seed);
        bad.set(v, seen);
      }
      for (const [k, n] of run.stats) stats.set(k, (stats.get(k) ?? 0) + n);
    }
  return { bad, stats };
}
const memo = new Map<string, Sweep>();
const swept = (opt: Partial<Options> = {}, seeds = SEEDS) => {
  const key = JSON.stringify([opt, seeds]);
  let s = memo.get(key);
  if (!s) memo.set(key, (s = sweep({ ...REFERENCE, ...opt }, seeds)));
  return s;
};
const theorem = (s: Sweep, prefix: string) =>
  Object.fromEntries([...s.bad].filter(([k]) => k.startsWith(prefix)));

const reaches = (s: Sweep, keys: Record<string, number>) => {
  for (const [k, min] of Object.entries(keys))
    expect([k, (s.stats.get(k) ?? 0) > min, s.stats.get(k)]).toEqual([
      k,
      true,
      s.stats.get(k),
    ]);
};

describe('composition model: theorems over generated traces (1500 uniform + 1500 biased seeds)', () => {
  it('T1 attribution is exact where asked: in-slice writes and kickoffs belong to that body only', () => {
    const s = swept();
    expect(theorem(s, 'T1')).toEqual({});
    reaches(s, {
      'T1-starts-with-overlap': 1000,
      'T1-nested': 500,
      'T1-enter-other': 200,
    });
  });
  it('T2 the hold brackets the body: no held reader shows a body write, readers first evaluated mid-hold included', () => {
    const s = swept();
    expect(theorem(s, 'T2')).toEqual({});
    expect(theorem(s, 'liveness')).toEqual({});
    reaches(s, {
      'T2-held-hides-a-write': 1000,
      'T2-born-in-hold': 3000,
      'T2-born-in-hold-recorded': 1000,
      'T5-commits-at-release': 500,
    });
  });
  it('T3 abort is exact and non-destructive, up to the stated limits', () => {
    const s = swept();
    expect(theorem(s, 'T3')).toEqual({});
    reaches(s, {
      'T3-effective-aborts': 3000,
      'T3-yields': 1000,
      'T3-resurrections': 0,
      'L-equal-value': 0,
    });
  });
  it('T4 no guess survives, both tiers: visibility per tier, no phantom, no guess in an undo log', () => {
    const s = swept();
    expect(theorem(s, 'T4')).toEqual({});
    reaches(s, {
      'T4-guess-shown-held': 1000,
      'T4-overlay-shown': 1000,
      'T4-burials': 500,
      'T4-confirmed-guess': 100,
      'T4-older-settles-first': 50,
      'T4-newer-settles-first': 50,
    });
  });
  it('T5 the display never commits a torn frame: faults hide, retries change only the fallback, swaps commit clean', () => {
    const s = swept();
    expect(theorem(s, 'T5')).toEqual({});
    reaches(s, {
      'T5-update-faults': 300,
      'T5-creation-faults': 50,
      'T5-retry-failed': 50,
      'T5-retry-clean': 50,
      'T5-commits-faulted': 100,
      'T5-retargets': 500,
    });
  });
  it('T6 a continuation outliving its transaction cannot reopen it', () => {
    const s = swept();
    expect(theorem(s, 'T6')).toEqual({});
    reaches(s, {
      'T6-closed-enters': 1000,
      'T6-late-landings': 300,
      'T6-late-scheduled': 300,
    });
  });
  it('L1 and L3 are shown, never broken: window attribution outside slices, unwrapped late writes land', () => {
    const s = swept();
    expect(theorem(s, 'L')).toEqual({});
    reaches(s, {
      'L1-scheduled-counted-by-other': 200,
      'T1-settled-claim-unadopted': 200,
      'L3-late-unwrapped': 500,
    });
    // every body write here is recorded, so no seed is ever missing (L5 lives on the real scope)
    expect(s.stats.get('L5-born-in-hold-unrecorded')).toBeUndefined();
  });
});

describe('composition model, killed alternatives: each breaks the theorem it would weaken (600 + 600 seeds)', () => {
  const alt = (o: Partial<Options>) => swept(o, ALT_SEEDS);
  it('zone-window ownership (everything during a running body is its): cross-attributes writes and kickoffs (T1)', () => {
    const s = alt({ attribution: 'zone' });
    expect(Object.keys(theorem(s, 'T1')).sort()).toEqual([
      'T1-flight',
      'T1-write',
    ]);
  });
  it('blind snapshot restore (first-touch pre, restored always): destroys a later writer (T3)', () => {
    expect(Object.keys(theorem(alt({ restore: 'blind' }), 'T3'))).toContain(
      'T3-undid-other',
    );
  });
  it('blind snapshot guesses (each guess restores what it covered): resurrect a settled guess (T4)', () => {
    const t4 = theorem(alt({ guessRule: 'snapshot' }), 'T4');
    expect(Object.keys(t4)).toEqual(
      expect.arrayContaining(['T4-phantom', 'T4-visibility']),
    );
  });
  it('commit the fork at completion (overlay tier): writes the guess into the base (T4)', () => {
    const t4 = theorem(alt({ overlay: 'commit' }), 'T4');
    expect(Object.keys(t4)).toEqual(
      expect.arrayContaining([
        'T4-discard-writes-base',
        'T4-base-has-guess',
        'T4-no-leak',
      ]),
    );
  });
  it('last good frame (leave the faulted view on screen): shows a torn frame (T5)', () => {
    expect(
      Object.keys(theorem(alt({ boundary: 'last-good-frame' }), 'T5')),
    ).toEqual(expect.arrayContaining(['T5-torn-visible', 'T5-swap']));
  });
  it('a reader first evaluated during a hold shows the live value (the old rule): shows the body write the held page hides (T2)', () => {
    expect(Object.keys(theorem(alt({ midHold: 'live' }), 'T2'))).toContain(
      'T2-born-in-hold-shows-body-write',
    );
  });
  it('seeds walked in open order and dropped at settlement: a younger write or a committed one seeds the reader (T2)', () => {
    expect(
      Object.keys(
        theorem(
          alt({
            seedScope: 'chain',
            seedOrder: 'open',
            seedLife: 'settlement',
          }),
          'T2',
        ),
      ).sort(),
    ).toEqual(['T2-seed-after-settled-writer', 'T2-seed-cross-order']);
    expect(
      Object.keys(
        theorem(alt({ seedScope: 'chain', seedOrder: 'open' }), 'T2'),
      ),
    ).toContain('T2-seed-cross-order');
    expect(
      Object.keys(
        theorem(alt({ seedScope: 'chain', seedLife: 'settlement' }), 'T2'),
      ),
    ).toEqual(['T2-seed-after-settled-writer']);
  });
  it('the swap commits on not pending alone (the old rule): a branch mounted mid-hold commits ahead of the held tree (T5)', () => {
    expect(Object.keys(theorem(alt({ swap: 'pending' }), 'T5'))).toEqual([
      'T5-swap-under-hold',
    ]);
  });
  it('hold released by the no-async fallback: ends before the body returns or its retains release (T2)', () => {
    expect(Object.keys(theorem(alt({ hold: 'first-render' }), 'T2'))).toContain(
      'T2-hold-spans-body',
    );
  });
  it('enter that runs on a closed transaction: a late continuation reopens it (T6)', () => {
    expect(Object.keys(theorem(alt({ closedEnter: 'run' }), 'T6'))).toContain(
      'T6-closed-enter',
    );
  });
  it('hold bypass for reads only: a frame frozen over a guess keeps it after it reverted (T4)', () => {
    expect(Object.keys(theorem(alt({ bypass: 'reads' }), 'T4'))).toEqual(
      expect.arrayContaining(['T4-held-visibility', 'T4-held-phantom']),
    );
  });
  it('value comparison instead of stamps on guessed nodes: a server confirming a guess is reverted (T4)', () => {
    expect(Object.keys(theorem(alt({ detect: 'objectIs' }), 'T4'))).toContain(
      'T4-visibility',
    );
  });
});

describe('two-scope model: a page scope and a child scope inside it (1500 uniform + 1500 biased seeds)', () => {
  const both = { twoScope: true } as const;
  const OPEN_T2 = [
    'T2-2s-child-write-under-page',
    'T2-2s-first-record-before-hold',
    'T2-2s-parent-hold-ended',
    'T2-2s-seed-filtered',
    'T2-2s-seeder-dropped-rehold',
    // the one-scope witnesses, reached through the misses above (never alone in a trace)
    'T2-born-in-hold-shows-body-write',
    'T2-seed-after-settled-writer',
    'T2-seed-cross-order',
  ];

  it('KILLED per-scope seeders along the scope chain (the round-3 rule): every other theorem and limit holds; T2 misses exactly the five classes', () => {
    const s = swept({ ...both, seedScope: 'chain' });
    for (const p of ['T1', 'T3', 'T4', 'T5', 'T6', 'L', 'liveness'])
      expect([p, theorem(s, p)]).toEqual([p, {}]);
    expect(Object.keys(theorem(s, 'T2')).sort()).toEqual(OPEN_T2);
    reaches(s, {
      'T2-2s-born-page': 4000,
      'T2-2s-born-child': 2000,
      'T2-2s-born-child-inherited': 1500,
      'T2-2s-born-recorded-other-scope': 1200,
      'T2-2s-born-recorded-settled': 800,
      'T2-2s-child-keeps-seeders': 400,
      'T2-2s-child-episode-drops-kept': 100,
      'T2-2s-child-successive-episodes': 300,
      'T2-2s-page-successive-episodes': 300,
      'T5-commits-at-release': 500,
    });
  });

  it('the landed rule (one registry of recorded entries, filtered by when the reader scope started holding): every theorem holds', () => {
    const s = swept(both);
    expect(Object.fromEntries(s.bad)).toEqual({});
    // the pruned registry is checked after every step: never smaller than what readers consult,
    // never larger than the entries after the lowest held stretch start
    reaches(s, { 'T2-registry-kept': 10000 });
    reaches(s, {
      'T2-2s-born-recorded-other-scope': 1200,
      'T2-2s-born-recorded-settled': 800,
    });
  });

  it('KILLED drop seeders at the scope own count 0: a child commit under the page hold is lost', () => {
    const t2 = theorem(
      swept({ ...both, seedScope: 'chain', seedDrop: 'own0' }, ALT_SEEDS),
      'T2',
    );
    expect(Object.keys(t2)).toContain('T2-2s-seeder-dropped-own0');
  });

  it('KILLED keep seeders without the episode filter: a seed from an older episode wins', () => {
    const t2 = theorem(
      swept({ ...both, seedScope: 'chain', episodeFilter: 'off' }, ALT_SEEDS),
      'T2',
    );
    expect(Object.keys(t2)).toContain('T2-2s-stale-seed');
  });

  it('KILLED no inheritance: child and branch readers are not held by the page, the swap commits under it', () => {
    const s = swept({ ...both, inherit: 'none' }, ALT_SEEDS);
    expect(Object.keys(theorem(s, 'T2'))).toEqual(
      expect.arrayContaining(['T2-2s-unheld', 'T2-unheld-shows-body-write']),
    );
    expect(Object.keys(theorem(s, 'T5'))).toEqual(['T5-swap-under-hold']);
  });

  it('KILLED the swap watcher alone reads the page hold: the swap waits, the readers inside are not held', () => {
    const s = swept({ ...both, inherit: 'watcher' }, ALT_SEEDS);
    expect(Object.keys(theorem(s, 'T2'))).toEqual(
      expect.arrayContaining(['T2-2s-unheld', 'T2-unheld-shows-body-write']),
    );
    expect(theorem(s, 'T5')).toEqual({});
  });
});

// ─── pins ────────────────────────────────────────────────────────────────────────────────

const W = (o: Partial<Options> = {}) => new World({ ...REFERENCE, ...o });
const shown = (w: World, n: Sig) => w.display(n).v;
const heldPage = (w: World, n: Sig) => w.peekHeld(w.page[SIGS.indexOf(n)]).v;
const targets = (t: Txn) => t.log.map((e) => e.target);

describe('composition pins: T1 attribution under guess, hold and nesting noise', () => {
  it('a kickoff and a write in A slice are A only, with B open, a guess in the slice and the scope held', () => {
    for (const attribution of ['exact', 'zone'] as const) {
      const w = W({ attribution });
      const A = w.openBody('A');
      const B = w.openBody('B');
      w.enter('A', () => {
        w.guessLive('g0', 'A~1');
        w.startRes(0, 'sync');
        w.writeSig('s0');
      });
      expect(w.holding).toBe(true);
      if (attribution === 'exact') {
        expect([w.attributedEach(A)[0], w.attributedEach(B)[0]]).toEqual([
          true,
          false,
        ]);
        expect([targets(A), targets(B)]).toEqual([['s0'], []]);
        expect(w.bad.size).toBe(0);
      } else {
        expect(w.attributedEach(B)[0]).toBe(true); // the zone gives B the flight A started
        expect(targets(B)).toEqual(['s0']);
        expect([...w.bad]).toEqual(['T1-write']);
      }
    }
  });

  it('a nested start merges into the outer; another transaction entered inside the slice owns its own writes and kickoffs', () => {
    const w = W();
    const A = w.openBody('A');
    const B = w.openBody('B');
    let token = 0;
    w.enter('A', () => {
      token = w.nestedStart().token;
      w.writeSig('s1');
      w.enter('B', () => {
        w.writeSig('s0');
        w.startRes(1, 'sync');
      });
      w.startRes(2, 'sync');
    });
    expect([targets(A), targets(B)]).toEqual([['s1'], ['s0']]);
    expect(w.attributedEach(A)).toEqual([false, false, true]);
    expect(w.attributedEach(B)).toEqual([false, true, false]);
    w.settleRes(2);
    w.bodyReturn('A');
    expect(A.status).toBe('returned'); // the merged nested transaction still holds it
    w.nestedSettle('A', token);
    expect(A.outcome).toEqual({ kind: 'completed' });
    expect(w.bad.size).toBe(0);
  });

  it('a cancelled body in-slice kickoff still in flight stays unadopted: B never waits for the load A started', () => {
    const w = W();
    w.openBody('A');
    const B = w.openBody('B');
    w.enter('A', () => w.startRes(0, 'sync'));
    expect(w.attributedEach(B)[0]).toBe(false);
    w.cancel('A', 'superseded');
    expect(w.attributedEach(B)[0]).toBe(false); // the claim keeps a settled owner
    w.bodyReturn('B');
    expect(B.outcome).toEqual({ kind: 'completed' }); // B completes without A's orphaned load
    w.settleRes(0);
    expect(w.bad.size).toBe(0);
  });
});

describe('composition pins: T2 the hold brackets the body', () => {
  it('the hold spans awaits and retains; the no-async fallback would end it while the body still runs', () => {
    for (const hold of ['continuous', 'first-render'] as const) {
      const w = W({ hold });
      const A = w.openBody('A');
      w.enter('A', () => w.writeSig('s0'));
      const written = shown(w, 's0');
      w.render(); // the await: nothing in flight
      if (hold === 'first-render') {
        expect(A.status).toBe('settled');
        expect(heldPage(w, 's0')).toBe(written); // the body's write shows mid-body
        expect([...w.bad]).toEqual(['T2-hold-spans-body']);
        continue;
      }
      expect(heldPage(w, 's0')).toBe('init:s0');
      const r = w.retain('A');
      w.bodyReturn('A');
      w.render();
      expect([A.status, w.holding, heldPage(w, 's0')]).toEqual([
        'returned',
        true,
        'init:s0',
      ]);
      w.release('A', r);
      expect([A.outcome, w.holding, heldPage(w, 's0')]).toEqual([
        { kind: 'completed' },
        false,
        written,
      ]);
      expect(w.bad.size).toBe(0);
    }
  });
});

describe('composition pins: T3 abort under guesses, and the cross-path limit (L2)', () => {
  it('lost update with a guess in the way: B guesses and reconciles over A, completes, A aborts, B value stays', () => {
    for (const restore of ['owned', 'blind'] as const) {
      const w = W({ restore });
      w.openBody('A');
      w.openBody('B');
      w.enter('A', () => w.writeSig('g0'));
      w.enter('B', () => {
        w.guessLive('g0', 'B~1');
        w.writeSig('g0'); // the reconcile buries the guess
      });
      const reconciled = shown(w, 'g0');
      w.bodyReturn('B');
      w.cancel('A', 'abort');
      expect(shown(w, 'g0')).toBe(restore === 'owned' ? reconciled : 'init:g0');
    }
  });

  it('L2: x reverts, twiceX computed from it stays, under a guess on x, a foreign write on twiceX and every way A ends', () => {
    const ends: ((w: World) => void)[] = [
      (w) => w.cancel('A', 'abort'),
      (w) => w.cancel('A', 'superseded'),
      (w) => w.cancel('A', 'destroyed'),
      (w) => w.bodyThrow('A', new Error('x')),
    ];
    for (const end of ends)
      for (const foreignTwice of [false, true]) {
        const w = W();
        w.openBody('A');
        w.enter('A', () => {
          w.writeTree(['c']); // A writes x
          w.guessOverlay('c', 'A~x'); // and shows a guess over it to its facade readers
          w.guessLive('g0', 'A~g');
        });
        const x = readLeaf(w.root, 'c');
        w.openBody('B');
        w.enter('B', () => w.writeTree(['b.r'], `=2*${x}`)); // B derives twiceX from A's x
        w.bodyReturn('B');
        if (foreignTwice) w.writeTree(['b.r']);
        const twice = readLeaf(w.root, 'b.r');
        end(w);
        expect(readLeaf(w.root, 'c')).toBe('init:c');
        expect(w.facade('c')).toBe('init:c');
        expect(readLeaf(w.root, 'b.r')).toBe(twice); // not recomputed: values, not invariants
        expect(twice.includes(`=2*${x}`)).toBe(!foreignTwice);
        expect(shown(w, 'g0')).toBe('init:g0');
        expect(w.bad.size).toBe(0);
      }
  });
});

describe('composition pins: T4 both tiers, the two-order case under undo and cancellation', () => {
  it('live tier, newer body settles first (superseded mid-await, its continuation then fails to enter): readers keep the older guess', () => {
    const w = W();
    w.openBody('A');
    w.openBody('B');
    w.enter('A', () => (w.guessLive('g0', '1'), w.writeSig('s0')));
    w.enter('B', () => w.guessLive('g0', '2'));
    expect(shown(w, 'g0')).toBe('2');
    w.cancel('B', 'superseded');
    expect(() => w.enter('B', () => w.guessLive('g0', 'late'))).toThrow(
      ClosedError,
    );
    expect(shown(w, 'g0')).toBe('1');
    w.bodyReturn('A');
    expect([shown(w, 'g0'), w.holding]).toEqual(['init:g0', false]);
    expect(shown(w, 's0')).toMatch(/^A#/);
    expect(w.bad.size).toBe(0);
  });

  it('live tier, older body settles first (aborted, its other write undone): the newer guess stays, then truth, never the older guess', () => {
    const frames: string[] = [];
    const w = W();
    w.openBody('A');
    w.openBody('B');
    w.enter('A', () => (w.guessLive('g0', '1'), w.writeSig('s0')));
    w.enter('B', () => w.guessLive('g0', '2'));
    w.cancel('A', 'abort');
    frames.push(shown(w, 'g0'), shown(w, 's0'));
    w.bodyReturn('B');
    frames.push(shown(w, 'g0'));
    expect(frames).toEqual(['2', 'init:s0', 'init:g0']);
    expect(w.bad.size).toBe(0);
  });

  it('overlay tier, both orders: the facade keeps the older guess, or the newer then truth; the base never sees either', () => {
    for (const newerFirst of [true, false]) {
      const w = W();
      w.openBody('A');
      w.openBody('B');
      w.enter('A', () => w.guessOverlay('c', 'A~1'));
      w.enter('B', () => w.guessOverlay('c', 'B~2'));
      w.writeTree(['c']); // the base moves under both forks
      const moved = readLeaf(w.root, 'c');
      expect(w.facade('c')).toBe('B~2');
      if (newerFirst) w.bodyThrow('B', new Error('x'));
      else w.cancel('A', 'abort');
      expect(w.facade('c')).toBe(newerFirst ? 'A~1' : 'B~2');
      if (newerFirst) w.bodyReturn('A');
      else w.bodyReturn('B');
      expect([w.facade('c'), readLeaf(w.root, 'c')]).toEqual([moved, moved]);
      expect(w.bad.size).toBe(0);
    }
  });

  it('a user write between the reconcile and the revert wins, on completion and on abort', () => {
    for (const end of ['return', 'abort'] as const) {
      const w = W();
      w.openBody('A');
      w.enter('A', () => (w.guessLive('g0', 'g'), w.writeSig('g0')));
      w.writeSig('g0'); // the user
      const user = shown(w, 'g0');
      if (end === 'return') w.bodyReturn('A');
      else w.cancel('A', 'abort');
      expect(shown(w, 'g0')).toBe(user);
      expect(w.bad.size).toBe(0);
    }
  });

  it('a server confirming a guess with an equal value keeps it: stamps see the confirmation, Object.is does not', () => {
    for (const detect of ['stamp', 'objectIs'] as const) {
      const w = W({ detect });
      w.openBody('A');
      w.enter('A', () => w.guessLive('g0', 'on'));
      w.writeSig('g0', { v: 'on' });
      w.bodyReturn('A');
      expect(shown(w, 'g0')).toBe(detect === 'stamp' ? 'on' : 'init:g0');
    }
  });

  it('a guess as a revert-always ledger entry (no history) resurrects the older guess when the older body settles first', () => {
    const w = W({ guessRule: 'entry' });
    w.openBody('A');
    w.openBody('B');
    w.enter('A', () => w.guessLive('g0', '1'));
    w.enter('B', () => w.guessLive('g0', '2'));
    expect(w.txn('B').log[0].pre).toMatchObject({ v: '1', kind: 'guess' }); // B recorded A guess as its pre
    w.bodyReturn('A'); // A's entry is not the owner: it yields
    w.bodyReturn('B'); // B restores its pre: A's settled guess
    expect(shown(w, 'g0')).toBe('1');
    w.check();
    expect([...w.bad]).toEqual(expect.arrayContaining(['T4-phantom']));
  });
});

describe('composition pins: T5 the in-place boundary and the swap', () => {
  it('a torn frame is hidden, the instance kept, a failing retry changes only the fallback, a clean retry keeps the instance', () => {
    for (const boundary of ['hide', 'last-good-frame'] as const) {
      const w = W({ boundary });
      w.writeSig('s0');
      w.render();
      const c = w.current.content as Content;
      const inst = c.inst;
      w.writeSig('s1', { poison: true });
      w.writeSig('s0');
      w.render(); // binding 0 lands from this frame, binding 1 throws
      expect(c.dom[0].frame).not.toBe(c.dom[2].frame); // the DOM is torn
      w.check();
      if (boundary === 'last-good-frame') {
        expect([...w.bad]).toEqual(['T5-torn-visible']);
        continue;
      }
      const faulted = w.visible();
      expect(faulted).toMatch(/:fallback:hidden$/);
      w.retry(); // still poisoned
      expect(w.visible()).toBe(faulted);
      w.writeSig('s1');
      w.retry();
      expect([w.current.fault, (w.current.content as Content).inst]).toEqual([
        undefined,
        inst,
      ]);
      expect(w.visible()).not.toMatch(/fallback|hidden/);
      w.check();
      expect(w.bad.size).toBe(0);
    }
  });

  it('a poisoned write held by a transaction does not fault the held content; it faults when the hold ends', () => {
    const w = W();
    w.openBody('A');
    w.enter('A', () => w.writeSig('s0', { poison: true }));
    w.render();
    expect(w.current.fault).toBeUndefined();
    w.bodyReturn('A');
    w.render();
    expect(w.current.fault?.kind).toBe('update');
    w.check();
    expect(w.bad.size).toBe(0);
  });

  it('a branch mounted mid-hold joins the held frame, waits for the release, then faults and commits its fallback in one step', () => {
    const w = W();
    w.openBody('A');
    w.enter('A', () => w.writeSig('s0', { poison: true })); // held from the committed branch
    w.render();
    const before = w.visible();
    w.startRes(0, 'foreign');
    w.navigate(); // created mid-hold: its readers are seeded with the pre-hold value
    w.render();
    const inc = w.incoming as Branch;
    expect([inc.fault, (inc.content as Content).dom[0].v]).toEqual([
      undefined,
      'init:s0',
    ]);
    w.settleRes(0);
    w.render(); // nothing pending, but A still holds: the swap waits
    expect([w.visible(), w.incoming]).toEqual([before, inc]);
    w.bodyReturn('A'); // the hold ends
    expect(w.holding).toBe(false);
    w.render(); // the release frame: the branch faults on the revealed write and commits with its fallback
    expect([w.current, w.visible()]).toEqual([
      inc,
      expect.stringMatching(/:fallback:hidden$/),
    ]);
    expect(w.stats.get('T5-commits-at-release')).toBe(1);
    w.check();
    expect(w.bad.size).toBe(0);
  });
});

describe('composition pins: T6, L1, L3 a continuation outliving its cancellation', () => {
  it('after supersede: enter throws and runs nothing, a late return changes nothing, a late scheduled start holds nothing, an unwrapped write lands', () => {
    const w = W();
    const A = w.openBody('A');
    const B = w.openBody('B');
    w.enter('A', () => (w.writeSig('s0'), w.startRes(0, 'sync')));
    w.cancel('A', 'superseded');
    expect([shown(w, 's0'), A.outcome]).toEqual([
      'init:s0',
      { kind: 'aborted', reason: 'superseded' },
    ]);
    let ran = false;
    expect(() => w.enter('A', () => (ran = true))).toThrow(ClosedError);
    expect(ran).toBe(false);
    expect(() => w.retain('A')).toThrow(ClosedError);
    w.bodyReturn('A');
    w.bodyThrow('A', new Error('late'));
    expect([A.outcome, A.resolutions]).toEqual([
      { kind: 'aborted', reason: 'superseded' },
      1,
    ]);
    const holds = w.holdCount;
    w.startRes(1, 'scheduled'); // scheduled from A's slice, lands after A settled
    expect([w.attributedEach(A)[1], w.holdCount]).toEqual([false, holds]);
    expect(w.attributedEach(B)[1]).toBe(true); // L1: B's window counts it
    w.writeSig('s0'); // L3: the continuation writes without enter
    expect(w.display('s0').by).toBe('F');
    expect([A.log, targets(B)]).toEqual([[], []]);
    expect(w.bad.size).toBe(0);
  });

  it('L1: a kickoff scheduled after a slice is window-attributed to every open body opened before it, never to one opened after', () => {
    const w = W();
    const A = w.openBody('A');
    w.startRes(0, 'foreign');
    const B = w.openBody('B');
    w.enter('A', () => w.writeSig('s0'));
    w.startRes(1, 'scheduled');
    expect([w.attributedEach(A), w.attributedEach(B)]).toEqual([
      [true, true, false],
      [false, true, false],
    ]);
  });
});

describe('composition pins: L4 held readers over a live guess', () => {
  it('without the bypass a held reader freezes the pre-guess value; with it the reader shows the guess', () => {
    for (const bypass of ['none', 'both'] as const) {
      const w = W({ bypass });
      w.openBody('A');
      w.enter('A', () => w.guessLive('g0', 'g'));
      expect([shown(w, 'g0'), heldPage(w, 'g0')]).toEqual([
        'g',
        bypass === 'none' ? 'init:g0' : 'g',
      ]);
      w.bodyReturn('A');
      expect(heldPage(w, 'g0')).toBe('init:g0');
    }
  });

  it('a frame first taken over a guess is the truth beneath it; a reads-only bypass keeps the reverted guess', () => {
    for (const bypass of ['both', 'reads'] as const) {
      const w = W({ bypass });
      w.openBody('A');
      w.openBody('B');
      w.enter('B', () => w.guessLive('g0', 'B~1'));
      w.navigate(); // a view created mid-hold takes its first frame over the guess
      w.render();
      const r = (w.incoming ?? w.current).content?.readers[1] as Reader;
      expect(w.peekHeld(r).v).toBe('B~1');
      w.bodyThrow('B', new Error('x'));
      expect(w.holding).toBe(true); // A still holds
      expect(w.peekHeld(r).v).toBe(bypass === 'both' ? 'init:g0' : 'B~1');
    }
  });
});

describe('composition rule: a reader first evaluated during a hold is seeded from the ledger; the swap waits for the hold', () => {
  it('model: a view swapped in mid-hold shows the pre-hold value with the rest of the page and commits at the release', () => {
    for (const [midHold, swap] of [
      ['seed', 'unheld'],
      ['live', 'pending'],
    ] as const) {
      const w = W({ midHold, swap });
      w.openBody('A');
      w.enter('A', () => w.writeSig('s0'));
      const written = shown(w, 's0');
      const before = w.current;
      w.navigate();
      w.render(); // nothing in flight
      const c = (w.incoming ?? w.current).content as Content;
      if (swap === 'pending') {
        // the old rule: the swap commits after the first render, showing the write the page hides
        expect([w.current === before, heldPage(w, 's0'), c.dom[0].v]).toEqual([
          false,
          'init:s0',
          written,
        ]);
        w.check();
        expect([...w.bad].sort()).toEqual([
          'T2-born-in-hold-shows-body-write',
          'T5-swap-under-hold',
        ]);
        continue;
      }
      expect([w.current, heldPage(w, 's0'), c.dom[0].v]).toEqual([
        before,
        'init:s0',
        'init:s0',
      ]);
      w.bodyReturn('A');
      w.render();
      expect([w.current === before, heldPage(w, 's0'), c.dom[0].v]).toEqual([
        false,
        written,
        written,
      ]);
      expect(w.bad.size).toBe(0);
    }
  });

  it('two open transactions: the first recorded entry seeds the reader; an unrecorded read is live', () => {
    const w = W();
    w.openBody('A');
    w.openBody('B');
    w.enter('A', () => w.writeSig('s0'));
    const a = shown(w, 's0');
    w.enter('B', () => (w.writeSig('s0'), w.writeSig('g0')));
    w.writeSig('s1'); // foreign, unrecorded
    w.navigate();
    w.render();
    const c = (w.incoming as Branch).content as Content;
    expect(w.peekHeld(c.readers[0]).v).toBe('init:s0'); // A's pre, not B's (which is A's write)
    expect(c.dom[1].v).toBe(shown(w, 's1')); // a live binding
    expect(w.peekHeld(c.readers[1]).v).toBe('init:g0'); // B alone recorded g0
    expect(a).not.toBe(shown(w, 's0'));
    w.check();
    expect(w.bad.size).toBe(0);
  });

  it('cross-order: a younger transaction records first, the older one over it; record order seeds the pre, open order (killed) the younger write', () => {
    for (const seedOrder of ['open', 'record'] as const) {
      const w = W({
        seedOrder,
        seedScope: seedOrder === 'open' ? 'chain' : 'tree',
      });
      w.openBody('A');
      w.openBody('B');
      w.enter('B', () => w.writeSig('s0'));
      const b = shown(w, 's0');
      w.enter('A', () => w.writeSig('s0'));
      w.navigate();
      w.render();
      const r = ((w.incoming as Branch).content as Content).readers[0];
      expect(w.peekHeld(r).v).toBe(seedOrder === 'open' ? b : 'init:s0');
      w.check();
      expect([...w.bad]).toEqual(
        seedOrder === 'open' ? ['T2-seed-cross-order'] : [],
      );
    }
  });

  it('settled writer: a transaction commits inside the hold, an open one records over it; seeds kept for the hold give the pre, dropped at settlement (killed) the committed write', () => {
    for (const seedLife of ['settlement', 'hold'] as const) {
      const w = W({
        seedLife,
        seedOrder: 'record',
        seedScope: seedLife === 'settlement' ? 'chain' : 'tree',
      });
      w.openBody('A');
      w.openBody('C');
      w.enter('C', () => w.writeSig('s0'));
      const c = shown(w, 's0');
      w.bodyReturn('C'); // C commits; A still holds
      w.enter('A', () => w.writeSig('s0'));
      w.navigate();
      w.render();
      const r = ((w.incoming as Branch).content as Content).readers[0];
      expect([w.holding, heldPage(w, 's0'), w.peekHeld(r).v]).toEqual([
        true,
        'init:s0',
        seedLife === 'settlement' ? c : 'init:s0',
      ]);
      w.check();
      expect([...w.bad]).toEqual(
        seedLife === 'settlement' ? ['T2-seed-after-settled-writer'] : [],
      );
    }
  });

  it('real scope.hold: the first entry since the hold began seeds, a settled writer still seeds until the hold ends, then the registry is empty', () => {
    TestBed.runInInjectionContext(() => {
      const x = signal(0);
      const target = createTransitionScope();
      const fwd = createForwardingScope();
      fwd.setTarget(target);
      for (const scope of [target, fwd]) {
        x.set(0);
        scope.beginHold(); // the older transaction
        scope.beginHold(); // the younger one
        recordHoldEntry(x, 0); // the younger records first
        x.set(1);
        recordHoldEntry(x, 1); // then the older over it
        x.set(2);
        const cross = scope.hold(x);
        expect(cross()).toBe(0); // not the younger write

        scope.endHold(); // one settles; its entry still counts while the other holds
        const settled = scope.hold(x);
        expect([settled(), cross()]).toEqual([0, 0]);

        scope.endHold(); // no hold anywhere: the registry is cleared, readers reveal
        expect([settled(), cross(), holdRegistrySize()]).toEqual([2, 2, 0]);
        scope.beginHold();
        const next = scope.hold(x); // a new hold starts with nothing recorded: L5
        expect(next()).toBe(2);
        scope.endHold();
      }
    });
  });

  it('L5 real scope.hold: with nothing seeding it, a reader created during the hold shows the live value; one created before stays frozen', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const x = signal(0);
      const early = scope.hold(x);
      expect(early()).toBe(0);
      scope.beginHold();
      x.set(1);
      const late = scope.hold(x);
      expect([early(), late()]).toEqual([0, 1]);
      scope.endHold();
      expect([early(), late()]).toEqual([1, 1]);
    });
  });
});

describe('two-scope model pins: a reader mounted in a held scope, each class the per-scope chain misses', () => {
  const two = (seedScope: 'chain' | 'tree') => W({ twoScope: true, seedScope });
  const misses = (w: World) => (w.check(), [...w.bad].sort());

  it('covered: the page holds first, a child transaction commits under it, a reader mounted in the child shows the pre', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      const early = w.mount('s0', 'child');
      w.openBody('A', 'page');
      w.openBody('B', 'child');
      w.enter('B', () => w.writeSig('s0'));
      w.bodyReturn('B');
      expect([w.settled('B'), w.holdingOf('child')]).toEqual([true, true]);
      const late = w.mount('s0', 'child');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        'init:s0',
        'init:s0',
      ]);
      expect(misses(w)).toEqual([]);
    }
  });

  it('(e) the child held first, its commit under a later page hold: the per-scope chain (killed) filters it out', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      const early = w.mount('s0', 'child');
      w.openBody('A', 'child');
      w.enter('A', () => w.writeSig('s0'));
      const a = shown(w, 's0');
      w.openBody('B', 'page');
      w.bodyReturn('A');
      const late = w.mount('s0', 'child');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        'init:s0',
        seedScope === 'chain' ? a : 'init:s0',
      ]);
      expect(misses(w)).toEqual(
        seedScope === 'chain' ? ['T2-2s-seed-filtered'] : [],
      );
    }
  });

  it('(f) the page hold ends while the child still holds: the per-scope chain (killed) dropped the page seeders', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      const early = w.mount('s0', 'child');
      w.openBody('A', 'page');
      w.enter('A', () => w.writeSig('s0'));
      const a = shown(w, 's0');
      w.openBody('B', 'child');
      w.bodyReturn('A');
      expect([w.holdingOf('page'), w.holdingOf('child')]).toEqual([
        false,
        true,
      ]);
      const late = w.mount('s0', 'child');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        'init:s0',
        seedScope === 'chain' ? a : 'init:s0',
      ]);
      expect(misses(w)).toEqual(
        seedScope === 'chain' ? ['T2-2s-parent-hold-ended'] : [],
      );
    }
  });

  it('(g) the child holds again under the page hold: the per-scope chain (killed) dropped the kept seeders', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      const early = w.mount('s0', 'child');
      w.openBody('A', 'page');
      w.openBody('B', 'child');
      w.enter('B', () => w.writeSig('s0'));
      const b = shown(w, 's0');
      w.bodyReturn('B');
      w.openBody('C', 'child');
      const late = w.mount('s0', 'child');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        'init:s0',
        seedScope === 'chain' ? b : 'init:s0',
      ]);
      expect(misses(w)).toEqual(
        seedScope === 'chain' ? ['T2-2s-seeder-dropped-rehold'] : [],
      );
    }
  });

  it('(h) a child transaction writes under the page hold: the per-scope chain (killed) never asks the child', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      const early = w.mount('s0', 'page');
      w.openBody('A', 'page');
      w.openBody('B', 'child');
      w.enter('B', () => w.writeSig('s0'));
      const b = shown(w, 's0');
      const late = w.mount('s0', 'page');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        'init:s0',
        seedScope === 'chain' ? b : 'init:s0',
      ]);
      expect(misses(w)).toEqual(
        seedScope === 'chain' ? ['T2-2s-child-write-under-page'] : [],
      );
    }
  });

  it('(h2) a child transaction first recorded the node before the page hold: the per-scope chain (killed) never seeds from its later entry', () => {
    for (const seedScope of ['chain', 'tree'] as const) {
      const w = two(seedScope);
      w.openBody('B', 'child');
      w.enter('B', () => w.writeSig('s0'));
      const b1 = shown(w, 's0');
      const early = w.mount('s0', 'page'); // the page is not held: it shows the first write
      w.openBody('A', 'page');
      w.enter('B', () => w.writeSig('s0'));
      const b2 = shown(w, 's0');
      const late = w.mount('s0', 'page');
      expect([w.peekHeld(early).v, w.peekHeld(late).v]).toEqual([
        b1,
        seedScope === 'chain' ? b2 : b1,
      ]);
      expect(misses(w)).toEqual(
        seedScope === 'chain' ? ['T2-2s-first-record-before-hold'] : [],
      );
    }
  });
});

// ─── two scopes on the real code ─────────────────────────────────────────────────────────

/** A page scope and a child scope provided inside it, with a `startTransaction` on each. */
function realScopes() {
  const root = TestBed.inject(EnvironmentInjector);
  const pageEnv = createEnvironmentInjector([provideTransitionScope()], root);
  const childEnv = createEnvironmentInjector(
    [provideTransitionScope()],
    pageEnv,
  );
  return {
    page: runInInjectionContext(pageEnv, injectTransitionScope),
    child: runInInjectionContext(childEnv, injectTransitionScope),
    on: {
      page: runInInjectionContext(pageEnv, injectStartTransaction),
      child: runInInjectionContext(childEnv, injectStartTransaction),
    },
    envs: { page: pageEnv, child: childEnv },
    destroy: () => pageEnv.destroy(),
  };
}
/** An async body that writes in its first slice and waits for `end()`. */
function body(
  start: ReturnType<typeof injectStartTransaction>,
  first: (tx: Transaction) => void = () => undefined,
) {
  let end!: () => void;
  let tx!: Transaction;
  const ref = start(async (t) => {
    tx = t;
    first(t);
    await new Promise<void>((r) => (end = r));
  });
  return { ref, end: () => end(), tx: () => tx };
}
const flushReal = async () => {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
};

describe('two scopes on the real code: a reader mounted in a held scope against the held frame', () => {
  it('covered: the page holds first, a child transaction commits under it, a reader mounted in the child shows the pre', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const early = s.child.hold(x);
    expect(early()).toBe(0);
    const page = body(s.on.page);
    const kid = body(s.on.child, () => w.set(1));
    kid.end();
    await flushReal();
    expect([kid.ref.pending(), s.child.holding(), early()]).toEqual([
      false,
      true,
      0,
    ]);
    expect(s.child.hold(x)()).toBe(0);
    page.end();
    await flushReal();
    expect([s.page.holding(), early()]).toEqual([false, 1]);
    s.destroy();
  });

  it('(e) the child held first: its commit under a later page hold still seeds, the mounted reader shows the pre', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const early = s.child.hold(x);
    expect(early()).toBe(0);
    const kid = body(s.on.child, () => w.set(1));
    const page = body(s.on.page);
    kid.end();
    await flushReal();
    expect([kid.ref.pending(), s.child.holding(), early()]).toEqual([
      false,
      true,
      0,
    ]);
    // the held frame is 0; the child has held since before the page did
    expect(s.child.hold(x)()).toBe(0);
    page.end();
    await flushReal();
    s.destroy();
  });

  it('(f) the page hold ends while the child still holds: the page entry still seeds, the mounted reader shows the pre', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const early = s.child.hold(x);
    expect(early()).toBe(0);
    const page = body(s.on.page, () => w.set(1));
    const kid = body(s.on.child);
    page.end();
    await flushReal();
    expect([page.ref.pending(), s.page.holding(), s.child.holding()]).toEqual([
      false,
      false,
      true,
    ]);
    expect(early()).toBe(0);
    expect(s.child.hold(x)()).toBe(0);
    kid.end();
    await flushReal();
    expect(early()).toBe(1);
    s.destroy();
  });

  it('(g) the child holds again under the page hold: the earlier child entry still seeds, the mounted reader shows the pre', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const early = s.child.hold(x);
    expect(early()).toBe(0);
    const page = body(s.on.page);
    const k1 = body(s.on.child, () => w.set(1));
    k1.end();
    await flushReal();
    expect(s.child.hold(x)()).toBe(0); // kept and seeded, as covered
    const k2 = body(s.on.child); // own 0 to 1, held by the page all along
    expect([s.child.holding(), early()]).toEqual([true, 0]);
    expect(s.child.hold(x)()).toBe(0);
    k2.end();
    page.end();
    await flushReal();
    s.destroy();
  });

  it('(h) a child transaction writes under the page hold: a reader mounted in the page shows the pre', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const early = s.page.hold(x);
    expect(early()).toBe(0);
    const page = body(s.on.page);
    const kid = body(s.on.child, () => w.set(1));
    expect([s.page.holding(), early()]).toEqual([true, 0]);
    expect(s.page.hold(x)()).toBe(0);
    kid.end();
    page.end();
    await flushReal();
    s.destroy();
  });

  it('(h2) a child transaction recorded the signal before the page hold and writes it again inside it: the entry inside the hold seeds', async () => {
    const s = realScopes();
    const x = signal(0);
    const w = transactional(x);
    const kid = body(s.on.child, () => w.set(1));
    const early = s.page.hold(x); // the page is not held: it shows 1
    expect(early()).toBe(1);
    const page = body(s.on.page);
    kid.tx().enter(() => w.set(2));
    expect([s.page.holding(), early()]).toEqual([true, 1]);
    // the entry recorded inside the page hold has the page frame (1) as its pre
    expect(s.page.hold(x)()).toBe(1);
    kid.end();
    page.end();
    await flushReal();
    s.destroy();
  });
});

// ─── re-pointed: the model's traces replayed against the real implementation ────────────

/** A leaf of a store (or a store fork) by path. */
const leafAt = (st: unknown, p: Leaf) =>
  p
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], st) as {
    (): unknown;
    set(v: unknown): void;
  };

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('replay: missing');
  return v;
}
const bump = (m: Map<string, number>, k: string) =>
  m.set(k, (m.get(k) ?? 0) + 1);

type RealRes = ResourceLike & {
  readonly status: WritableSignal<ResourceStatus>;
  readonly loads: WritableSignal<number>;
};
function realRes(): RealRes {
  const status = signal<ResourceStatus>('idle');
  return {
    status,
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => true,
    loads: signal(0),
  };
}
const realOutcome = (o: TransactionOutcome | undefined): string =>
  !o ? 'none' : o.kind === 'aborted' ? `aborted:${o.reason}` : o.kind;

type RealBody = {
  readonly env: EnvironmentInjector;
  readonly start: ReturnType<typeof injectStartTransaction>;
  ref?: AsyncTransactionRef;
  tx?: Transaction;
  tracker?: () => boolean;
  gate?: { resolve(): void; reject(e: unknown): void };
  outcome?: TransactionOutcome;
};
type Replayed = {
  /** step-by-step differences, by the theorem whose state differed */
  readonly diffs: Record<'T1' | 'T2' | 'T3' | 'T4' | 'T6', string[]>;
  readonly stats: Map<string, number>;
  /** the model's own verdict on the trace */
  readonly bad: Set<string>;
};

/**
 * Runs one generated two-scope trace on the model, then drives the real objects through the same
 * steps (real `startTransaction` per body, `transactional` signals, a store-like root recorded
 * with `merge3`, fake resources with `loads`, real `scope.hold` readers created when the model
 * mounts them) and compares the state after every top-level step.
 */
async function replay(
  seed: number,
  biased: boolean,
  mode: 'plain' | 'guesses' = 'plain',
): Promise<Replayed> {
  const rec: Rec[] = [];
  const opt: Options = { ...REFERENCE, twoScope: true, replayable: mode };
  const { bad, stats } = runTrace(seed, opt, biased, rec);
  const diffs: Replayed['diffs'] = { T1: [], T2: [], T3: [], T4: [], T6: [] };
  const s = realScopes();
  const scopes = { page: s.page, child: s.child };
  const guesses = mode === 'guesses';
  // readers hold and the state compares the raw signal, or the guessable over it
  const raw = new Map<Sig, WritableSignal<string>>();
  const writers = new Map<Sig, WritableSignal<string>>();
  const names = new Map<unknown, string>();
  const gs = new Map<Sig, Guessable<string>>();
  for (const n of SIGS) {
    const sig = signal(`init:${n}`);
    if (guesses && GUESSABLE.includes(n)) {
      const g = guessable(sig);
      gs.set(n, g);
      raw.set(n, g);
      writers.set(n, g);
      names.set(recordTargetOf(g), n);
    } else {
      raw.set(n, sig);
      writers.set(n, transactional(sig));
      names.set(sig, n);
    }
  }
  // with guesses: a store whose root records itself with merge3, and its overlay
  const base = guesses
    ? TestBed.runInInjectionContext(() =>
        store(initialTree() as Record<string, any>),
      )
    : undefined;
  const overlay =
    base && TestBed.runInInjectionContext(() => optimisticStore(base));
  const root = (base ?? signal<Tree>(initialTree())) as WritableSignal<unknown>;
  if (!base)
    declareRecordOptions(root, {
      reconcile: merge3 as RecordOptions['reconcile'],
    });
  names.set(root, ROOT);
  // anything else authoritative is the store's own root signal
  const nameOf = (target: unknown) => names.get(target) ?? ROOT;
  const res = Array.from({ length: RES }, (_, i) => {
    const f = realRes();
    scopes[i === RES - 1 ? 'child' : 'page'].add(f, { suspends: false });
    return f;
  });
  const readers = new Map<number, () => string>();
  SIGS.forEach((n, i) => {
    const h = s.page.hold(must(raw.get(n)));
    h();
    readers.set(i + 1, h);
  });
  const bodies = new Map<Id, RealBody>();
  const releases = new Map<number, () => void>();
  const nests = new Map<number, () => void>();
  const body = (id: Id) => must(bodies.get(id));
  const txOf = (id: Id) => must(body(id).tx);
  const startRes = (i: number) => {
    res[i].loads.update((n) => n + 1);
    res[i].status.set('loading');
  };
  const tree = (e: Extract<RecEv, { k: 'tree' }>) => {
    let next = untracked(root) as Tree;
    e.leaves.forEach((leaf, k) => (next = writeLeaf(next, leaf, e.vs[k])));
    if (!base) recordWrite(root);
    root.set(e.leaves.length > 1 ? { ...next, a: { ...next.a } } : next);
  };

  let i = 0;
  const sliceOps = (id: Id): void => {
    for (;;) {
      const { e } = rec[i++];
      if (e.k === 'exit') {
        if (e.id !== id) throw new Error(`replay: exit ${e.id} inside ${id}`);
        return;
      }
      if (e.k === 'write') must(writers.get(e.n)).set(e.v);
      else if (e.k === 'tree') tree(e);
      else if (e.k === 'guess') txOf(e.id).guess(must(gs.get(e.n)), e.v);
      else if (e.k === 'overlay')
        leafAt(txOf(e.id).overlay(must(overlay)), e.p).set(e.v);
      else if (e.k === 'start') startRes(e.i);
      else if (e.k === 'retain') releases.set(e.r, txOf(e.id).retain());
      else if (e.k === 'nest')
        body(e.into).start(
          () => new Promise<void>((r) => nests.set(e.token, r)),
        );
      else if (e.k === 'enter') txOf(e.id).enter(() => sliceOps(e.id));
      else throw new Error(`replay: ${e.k} inside a slice`);
    }
  };

  while (i < rec.length) {
    const at = i;
    const { e } = rec[i++];
    if (e.k === 'open') {
      const enter = rec[i++].e;
      if (enter.k !== 'enter' || enter.id !== e.id)
        throw new Error('replay: open without its first slice');
      const env = createEnvironmentInjector([], s.envs[e.scope]);
      const b: RealBody = {
        env,
        start: runInInjectionContext(env, injectStartTransaction),
      };
      bodies.set(e.id, b);
      const scope = scopes[e.scope];
      b.ref = b.start(async (tx) => {
        b.tx = tx;
        b.tracker = createAttributedPending(scope, tx);
        sliceOps(e.id);
        await new Promise<void>(
          (resolve, reject) => (b.gate = { resolve, reject }),
        );
      });
      void b.ref.done.then((o) => (b.outcome = o));
    } else if (e.k === 'enter') txOf(e.id).enter(() => sliceOps(e.id));
    else if (e.k === 'enterClosed') {
      let threw = false;
      let ran = false;
      try {
        txOf(e.id).enter(() => (ran = true));
      } catch {
        threw = true;
      }
      if (!threw || ran)
        diffs.T6.push(`#${at} enter on a settled transaction ran`);
    } else if (e.k === 'write') must(writers.get(e.n)).set(e.v);
    else if (e.k === 'tree') tree(e);
    else if (e.k === 'start') startRes(e.i);
    else if (e.k === 'settle') res[e.i].status.set('resolved');
    else if (e.k === 'release') must(releases.get(e.r))();
    else if (e.k === 'nestSettle') must(nests.get(e.token))();
    else if (e.k === 'return') must(body(e.id).gate).resolve();
    else if (e.k === 'throw')
      must(body(e.id).gate).reject(new Error(`body ${e.id} failed`));
    else if (e.k === 'cancel') {
      const ref = must(body(e.id).ref);
      if (e.reason === 'abort') ref.abort();
      else if (e.reason === 'superseded') abortTransaction(ref, 'superseded');
      else body(e.id).env.destroy();
    } else if (e.k === 'mount')
      readers.set(e.rid, scopes[e.scope].hold(must(raw.get(e.n))));
    else if (e.k !== 'render') throw new Error(`replay: unexpected ${e.k}`);

    const snap = rec[i - 1].snap;
    if (!snap) throw new Error(`replay: no state after #${at} ${e.k}`);
    // readers first, at the moment the model evaluated them
    for (const [rid, v] of snap.readers ?? []) {
      bump(stats, 'replay-reader-reads');
      const got = must(readers.get(rid))();
      if (got !== v)
        diffs.T2.push(`#${at} ${e.k}: reader ${rid} real ${got} model ${v}`);
    }
    await flushReal();
    compareSnap(`#${at} ${e.k}`, snap);
    bump(stats, 'replay-steps');
  }

  function compareSnap(where: string, snap: RecSnap): void {
    for (const [n, g] of gs)
      for (const [k, got] of [
        [n, untracked(g)],
        [`truth:${n}`, untracked(g.truth)],
      ] as const)
        if (got !== snap.values[k])
          diffs.T4.push(`${where}: ${k} real ${got} model ${snap.values[k]}`);
    if (overlay)
      for (const l of LEAVES) {
        const got = untracked(leafAt(overlay.store, l));
        if (got !== snap.values[`facade:${l}`])
          diffs.T4.push(
            `${where}: facade ${l} real ${got} model ${snap.values[`facade:${l}`]}`,
          );
      }
    for (const n of SIGS)
      if (!gs.has(n) && untracked(must(raw.get(n))) !== snap.values[n])
        diffs.T3.push(
          `${where}: ${n} real ${untracked(must(raw.get(n)))} model ${snap.values[n]}`,
        );
    for (const l of LEAVES) {
      const got = readLeaf(untracked(root) as Tree, l);
      if (got !== snap.values[l])
        diffs.T3.push(`${where}: ${l} real ${got} model ${snap.values[l]}`);
    }
    for (const x of ['page', 'child'] as const)
      if (scopes[x].holding() !== snap.holding[x])
        diffs.T2.push(
          `${where}: ${x} holding real ${scopes[x].holding()} model ${snap.holding[x]}`,
        );
    for (const [id, m] of Object.entries(snap.txns)) {
      const b = body(id as Id);
      const settled = !must(b.ref).pending();
      if (settled !== m.settled)
        diffs.T6.push(
          `${where}: ${id} settled real ${settled} model ${m.settled}`,
        );
      if (m.settled) {
        if (realOutcome(b.outcome) !== m.outcome)
          diffs.T6.push(
            `${where}: ${id} outcome real ${realOutcome(b.outcome)} model ${m.outcome}`,
          );
        continue;
      }
      const p = must(b.tracker)();
      if (p !== m.pending)
        diffs.T1.push(
          `${where}: ${id} attributed real ${p} model ${m.pending}`,
        );
      const log = [
        ...new Set(
          txOf(id as Id)
            .entries()
            .filter((x) => x.kind === 'authoritative')
            .map((x) => nameOf(x.target)),
        ),
      ]
        .sort()
        .join();
      if (log !== m.log)
        diffs.T1.push(`${where}: ${id} log real [${log}] model [${m.log}]`);
    }
  }
  s.destroy();
  return { diffs, stats, bad };
}

describe('composition finding: two encodings of the undo rule', () => {
  it('record-once per body (the async model) undoes a commit that landed between two slices; per-slice entries keep it', () => {
    // async-transaction-proofs `World.write` / `restore`, verbatim in miniature
    const once = () => {
      const value = new Map([['s', 'init']]);
      const owner = new Map<string, string | null>([['s', null]]);
      const logs = new Map<
        string,
        Map<string, { pre: string; preOwner: string | null }>
      >();
      return {
        open: (id: string) => logs.set(id, new Map()),
        write: (id: string, v: string) => {
          const log = logs.get(id) as Map<
            string,
            { pre: string; preOwner: string | null }
          >;
          if (!log.has('s'))
            log.set('s', {
              pre: value.get('s') as string,
              preOwner: owner.get('s') ?? null,
            });
          value.set('s', v);
          owner.set('s', id);
        },
        commit: (id: string) => logs.get(id)?.clear(),
        abort: (id: string) => {
          for (const [k, e] of logs.get(id) ?? [])
            if (owner.get(k) === id) {
              value.set(k, e.pre);
              owner.set(k, e.preOwner);
            }
        },
        get: () => value.get('s'),
      };
    };
    const m = once();
    m.open('X');
    m.write('X', 'x1');
    m.open('Y');
    m.write('Y', 'y');
    m.commit('Y');
    m.write('X', 'x3');
    m.abort('X');
    expect(m.get()).toBe('init'); // Y's committed write is gone

    const w = W();
    w.openBody('A');
    w.openBody('B');
    w.enter('A', () => w.writeSig('s0'));
    w.enter('B', () => w.writeSig('s0'));
    const committed = shown(w, 's0');
    w.bodyReturn('B');
    w.enter('A', () => w.writeSig('s0'));
    w.cancel('A', 'abort');
    expect(shown(w, 's0')).toBe(committed);
    expect(w.bad.size).toBe(0);
  });
});

describe('RE-POINTED: two-scope model traces replayed step by step against the real code (150 uniform + 150 biased seeds)', () => {
  const N = 150;
  let all: Replayed[] | undefined;
  const runAll = async () => {
    if (all) return all;
    const out: Replayed[] = [];
    for (const biased of [false, true])
      for (let seed = 1; seed <= N; seed++)
        out.push(await replay(seed, biased));
    return (all = out);
  };
  const diffsOf = (t: keyof Replayed['diffs']) =>
    (all ?? [])
      .flatMap((r, k) => r.diffs[t].slice(0, 2).map((d) => `trace ${k}: ${d}`))
      .slice(0, 12);
  const total = (k: string) =>
    (all ?? []).reduce((n, r) => n + (r.stats.get(k) ?? 0), 0);
  const traces = (k: string) => (all ?? []).filter((r) => r.bad.has(k)).length;

  it('T1 attribution: per-transaction recorded targets and attributed pending (claims ledger, window rule, settled owner) match at every step', async () => {
    await runAll();
    expect(diffsOf('T1')).toEqual([]);
    expect([
      total('T1-starts-with-overlap') > 60,
      total('T1-nested') > 40,
      total('T1-enter-other') > 30,
      total('T1-settled-claim-unadopted') > 20,
      total('L1-scheduled-counted-by-other') > 10,
    ]).toEqual([true, true, true, true, true]);
  }, 600_000);

  it('T3 abort exactness: every signal and store leaf matches after every step (generation hand-back, later writers kept, merge3 root)', async () => {
    await runAll();
    expect(diffsOf('T3')).toEqual([]);
    expect([
      total('T3-effective-aborts') > 200,
      total('T3-yields') > 100,
    ]).toEqual([true, true]);
  }, 600_000);

  it('T2 the hold: both scopes report the model hold at every step, and every held reader (page, child, mounted mid-hold) shows what the model shows', async () => {
    await runAll();
    expect(diffsOf('T2')).toEqual([]);
    expect([
      total('replay-reader-reads') > 30_000,
      total('T2-born-in-hold') > 600,
      total('T2-2s-born-child-inherited') > 100,
      total('T2-2s-born-recorded-other-scope') > 100,
      total('T2-2s-child-keeps-seeders') > 50,
      total('T2-2s-child-successive-episodes') > 50,
    ]).toEqual([true, true, true, true, true, true]);
    // the per-scope seeder classes no longer occur: the model and the real code join the frame
    expect([
      traces('T2-2s-child-write-under-page') > 0,
      traces('T2-2s-parent-hold-ended') > 0,
      traces('T2-2s-seed-filtered') > 0,
    ]).toEqual([false, false, false]);
  }, 600_000);

  it('T6 settlement: settled flags and outcomes match at every step; enter on a settled transaction throws and runs nothing', async () => {
    await runAll();
    expect(diffsOf('T6')).toEqual([]);
    expect([
      total('T6-closed-enters') > 300,
      total('T6-late-landings') > 50,
      total('L3-late-unwrapped') > 50,
      total('replay-steps') > 15_000,
    ]).toEqual([true, true, true, true]);
  }, 600_000);
});

describe('RE-POINTED T4: composed traces with both guess tiers replayed against the real guessable, optimisticStore and transactions (150 uniform + 150 biased seeds)', () => {
  const N = 150;
  let all: Replayed[] | undefined;
  const runAll = async () => {
    if (all) return all;
    const out: Replayed[] = [];
    for (const biased of [false, true])
      for (let seed = 1; seed <= N; seed++)
        out.push(await replay(seed, biased, 'guesses'));
    return (all = out);
  };
  const diffsOf = (t: keyof Replayed['diffs']) =>
    (all ?? [])
      .flatMap((r, k) => r.diffs[t].slice(0, 2).map((d) => `trace ${k}: ${d}`))
      .slice(0, 12);
  const total = (k: string) =>
    (all ?? []).reduce((n, r) => n + (r.stats.get(k) ?? 0), 0);

  it('T4 live tier and overlay tier: every guessable display and truth and every overlay facade leaf match the model after every step', async () => {
    await runAll();
    expect(diffsOf('T4')).toEqual([]);
    // the model found no T4 violation in these traces, so the real code has none either
    expect(
      (all ?? []).filter((r) => [...r.bad].some((k) => k.startsWith('T4'))),
    ).toEqual([]);
    expect([
      total('T4-guess-shown-held') > 2000,
      total('T4-overlay-shown') > 2000,
      total('T4-burials') > 100,
      total('T4-confirmed-guess') > 10,
      total('T4-older-settles-first') > 10,
      total('T4-newer-settles-first') > 10,
      total('T3-effective-aborts') > 200,
    ]).toEqual([true, true, true, true, true, true, true]);
  }, 600_000);

  it('the other theorems with guesses in the trace: held readers over guessed nodes (frame = truth, a visible guess reads through), values, attribution and settlement all match', async () => {
    await runAll();
    expect([
      diffsOf('T2'),
      diffsOf('T3'),
      diffsOf('T1'),
      diffsOf('T6'),
    ]).toEqual([[], [], [], []]);
    expect(total('replay-reader-reads') > 30_000).toBe(true);
  }, 600_000);
});
