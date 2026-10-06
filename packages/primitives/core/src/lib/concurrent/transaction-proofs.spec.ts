/**
 * PURE MODEL + property proofs for overlapping transactions (undo with ownership) and the
 * re-enterable transaction's entry shape. No Angular in the model: a tiny ledger over plain cells
 * and one copy-on-write record tree (the store root), restored with the real `merge3`.
 *
 * Semantics under proof: abort removes THIS transaction's effect where it is still in effect and
 * yields where a later writer took over.
 *  - Every log entry is (target, pre, writer, generation, kind). An entry opens on a recording write
 *    unless the writer's latest entry for that target is still the owner, still open (same slice)
 *    and of the same kind; each entry mints a fresh generation and carries its own pre-value.
 *  - `mine` (the value the entry produced) is fixed at slice end, at settlement, or when anyone
 *    records the same target next, whichever comes first.
 *  - Abort walks the writer's entries newest-first. Signal: restore `pre` iff the target's owner is
 *    this entry AND the current value is still `mine` (one atomic step), then hand ownership back.
 *    Store root: `merge3(ancestor = mine, ours = current, theirs = pre)`, undoing this entry's diff
 *    on top of whatever is current.
 *  - A guess entry is revert-always: at commit it is undone under the same rule.
 *
 * Oracle: the IDEAL value of every atomic key (a signal, or one leaf of the tree) is the last write
 * still alive (writes of aborted writers and settled guesses are dead). Property: the ledger equals
 * the ideal, except where the restored value is itself a dead write (the resurrection LIMIT, pinned
 * below). Killed alternatives run under the same generators and are shown to violate a property.
 *
 * Stated limit: abort preserves later writers' VALUES, not cross-path invariants (merge3 records no
 * reads). Read-set validation (STM-style) is the alternative, not built.
 *
 * The model itself uses no Angular; the last two describe blocks re-run the same generators and
 * pins against the real `createTransaction`.
 */
import { signal, untracked, type WritableSignal } from '@angular/core';
import { merge3 } from '../store/fork-store';
import {
  activeTransaction,
  createTransaction,
  type RecordOptions,
  type Transaction,
} from './transaction';

export type Kind = 'authoritative' | 'guess';
export type Tree = {
  a: { p: unknown; q: unknown };
  b: { r: unknown };
  c: unknown;
};
export const LEAVES = ['a.p', 'a.q', 'b.r', 'c'] as const;
export type Leaf = (typeof LEAVES)[number];
export const SIGNALS = ['x0', 'x1', 'x2'] as const;
export const ROOT = 'root';
export type Target = (typeof SIGNALS)[number] | typeof ROOT;

export const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function readLeaf(tree: Tree, leaf: Leaf): unknown {
  const [k1, k2] = leaf.split('.') as [keyof Tree, string | undefined];
  const node = tree[k1] as Record<string, unknown>;
  return k2 === undefined ? node : node[k2];
}

/** Copy-on-write: only the edited path gets fresh references. */
export function writeLeaf(tree: Tree, leaf: Leaf, v: unknown): Tree {
  const [k1, k2] = leaf.split('.') as [keyof Tree, string | undefined];
  if (k2 === undefined) return { ...tree, [k1]: v };
  return { ...tree, [k1]: { ...(tree[k1] as object), [k2]: v } };
}

export function initialTree(): Tree {
  return {
    a: { p: 'init:a.p', q: 'init:a.q' },
    b: { r: 'init:b.r' },
    c: 'init:c',
  };
}

/** The operations a trace drives. The model below and the real transaction both implement it. */
export interface Engine {
  get(target: Target): unknown;
  set(target: Target, v: unknown): void;
  open(tx: number): void;
  slice(tx: number, body: () => void): void;
  record(tx: number, target: Target, kind: Kind): void;
  commit(tx: number, hook?: (step: number) => void): void;
  abort(tx: number, hook?: (step: number) => void): void;
}

type Entry = {
  readonly tx: number;
  readonly gen: number;
  kind: Kind;
  readonly target: Target;
  readonly pre: unknown;
  mine: unknown;
  open: boolean;
  readonly prev: Entry | undefined;
};

export type Variant =
  | 'generation' // the chosen rule
  | 'blind' // today's code: first-touch pre, restore unconditionally
  | 'single' // one first-touch entry per target, value compare only
  | 'reuse' // a guess entry reused for a later authoritative write
  | 'blind-root' // store root restored by set(pre) instead of merge3
  | 'no-owner' // value compare without the ownership half
  | 'no-compare'; // ownership without the value half

export class Ledger implements Engine {
  readonly cells = new Map<Target, unknown>();
  readonly owner = new Map<Target, Entry>();
  readonly logs = new Map<number, Entry[]>();
  readonly closed = new Set<number>();
  private readonly gens = new Map<number, number>();
  private readonly depth = new Map<number, number>();
  /** Every restore that wrote a value: (target, value). The oracle classifies them. */
  readonly restores: { target: Target; value: unknown }[] = [];

  constructor(
    readonly variant: Variant = 'generation',
    readonly guessRevertsAtCommit = true,
  ) {
    for (const s of SIGNALS) this.cells.set(s, `init:${s}`);
    this.cells.set(ROOT, initialTree());
  }

  get(t: Target) {
    return this.cells.get(t);
  }
  set(t: Target, v: unknown) {
    this.cells.set(t, v);
  }
  open(tx: number) {
    this.logs.set(tx, []);
    this.gens.set(tx, 0);
  }

  slice(tx: number, body: () => void) {
    if (this.closed.has(tx)) throw new Error('closed');
    this.depth.set(tx, (this.depth.get(tx) ?? 0) + 1);
    try {
      body();
    } finally {
      const d = (this.depth.get(tx) ?? 1) - 1;
      this.depth.set(tx, d);
      if (d === 0) for (const e of this.logs.get(tx) ?? []) this.finalize(e);
    }
  }

  private finalize(e: Entry) {
    if (!e.open) return;
    e.open = false;
    e.mine = this.cells.get(e.target);
  }

  record(tx: number, target: Target, kind: Kind) {
    if (this.closed.has(tx)) return; // the write lands unrecorded
    const log = this.logs.get(tx) as Entry[];
    const mineFor = log.filter((e) => e.target === target);
    const latest = mineFor[mineFor.length - 1];
    const v = this.variant;
    if (v === 'blind' || v === 'single') {
      if (latest) {
        latest.open = true; // 'single': mine refreshed at the end of every slice that wrote it
        return;
      }
    } else if (
      latest &&
      latest.open &&
      this.owner.get(target) === latest &&
      (latest.kind === kind || v === 'reuse')
    )
      return;
    const cur = this.owner.get(target);
    if (cur) this.finalize(cur);
    const gen = (this.gens.get(tx) ?? 0) + 1;
    this.gens.set(tx, gen);
    const e: Entry = {
      tx,
      gen,
      kind,
      target,
      pre: this.cells.get(target),
      mine: undefined,
      open: true,
      prev: cur,
    };
    log.push(e);
    this.owner.set(target, e);
  }

  /** One atomic compare-and-restore. */
  private undo(e: Entry) {
    const cur = this.cells.get(e.target);
    const v = this.variant;
    const owned = this.owner.get(e.target) === e;
    if (e.target === ROOT && v !== 'blind' && v !== 'blind-root') {
      const next = merge3(e.mine, cur, e.pre);
      if (next !== cur) {
        this.cells.set(ROOT, next);
        this.restores.push({ target: ROOT, value: next });
      }
      if (owned) this.handBack(e);
      return;
    }
    const restore =
      v === 'blind'
        ? true
        : v === 'single' || v === 'no-owner'
          ? Object.is(cur, e.mine)
          : v === 'no-compare' || (v === 'blind-root' && e.target === ROOT)
            ? owned
            : owned && Object.is(cur, e.mine);
    if (restore) {
      this.cells.set(e.target, e.pre);
      this.restores.push({ target: e.target, value: e.pre });
    }
    if (owned) this.handBack(e);
  }

  private handBack(e: Entry) {
    if (e.prev) this.owner.set(e.target, e.prev);
    else this.owner.delete(e.target);
  }

  private settle(
    tx: number,
    which: (e: Entry) => boolean,
    hook?: (step: number) => void,
  ) {
    if (this.closed.has(tx)) return;
    this.closed.add(tx);
    const log = this.logs.get(tx) ?? [];
    for (const e of log) this.finalize(e);
    let step = 0;
    hook?.(step++);
    for (let i = log.length - 1; i >= 0; i--) {
      if (which(log[i])) this.undo(log[i]);
      hook?.(step++);
    }
    this.logs.delete(tx);
  }

  commit(tx: number, hook?: (step: number) => void) {
    this.settle(
      tx,
      (e) => this.guessRevertsAtCommit && e.kind === 'guess',
      hook,
    );
  }
  abort(tx: number, hook?: (step: number) => void) {
    this.settle(tx, () => true, hook);
  }

  /** Entries currently in a writer's log (for the generation pins). */
  entries(tx: number): readonly { target: Target; gen: number; kind: Kind }[] {
    return (this.logs.get(tx) ?? []).map((e) => ({
      target: e.target,
      gen: e.gen,
      kind: e.kind,
    }));
  }
}

// ─── traces ──────────────────────────────────────────────────────────────────────────────

export type WriteOp =
  | {
      readonly t: 'sig';
      readonly target: (typeof SIGNALS)[number];
      readonly kind: Kind;
    }
  | { readonly t: 'leaf'; readonly leaf: Leaf; readonly kind: Kind }
  | { readonly t: 'replaceA'; readonly kind: Kind };

export type Step =
  | { readonly e: 'open'; readonly tx: number }
  | {
      readonly e: 'slice';
      readonly tx: number;
      readonly ops: readonly WriteOp[];
      readonly nested?: {
        readonly tx: number;
        readonly ops: readonly WriteOp[];
      };
    }
  | { readonly e: 'foreign'; readonly key: (typeof SIGNALS)[number] | Leaf }
  | { readonly e: 'commit'; readonly tx: number }
  | { readonly e: 'abort'; readonly tx: number };

export type GenOptions = { readonly guesses: boolean; readonly length: number };

export function genTrace(seed: number, opt: GenOptions): Step[] {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const kind = (): Kind =>
    opt.guesses && r() < 0.3 ? 'guess' : 'authoritative';
  const op = (): WriteOp => {
    const x = r();
    if (x < 0.45) return { t: 'sig', target: pick(SIGNALS), kind: kind() };
    if (x < 0.9) return { t: 'leaf', leaf: pick(LEAVES), kind: kind() };
    return { t: 'replaceA', kind: kind() };
  };
  const ops = () => Array.from({ length: 1 + Math.floor(r() * 3) }, op);
  const steps: Step[] = [];
  const openTx: number[] = [];
  let nextTx = 1;
  for (let i = 0; i < opt.length; i++) {
    const x = r();
    if (openTx.length === 0 && nextTx > 5) break;
    if ((openTx.length === 0 || x < 0.12) && openTx.length < 3 && nextTx <= 5) {
      openTx.push(nextTx);
      steps.push({ e: 'open', tx: nextTx++ });
    } else if (x < 0.62) {
      const tx = pick(openTx);
      const others = openTx.filter((t) => t !== tx);
      const nested =
        others.length && r() < 0.15
          ? { tx: pick(others), ops: ops() }
          : undefined;
      steps.push({ e: 'slice', tx, ops: ops(), nested });
    } else if (x < 0.75) {
      steps.push({
        e: 'foreign',
        key: r() < 0.5 ? pick(SIGNALS) : pick(LEAVES),
      });
    } else {
      const tx = pick(openTx);
      openTx.splice(openTx.indexOf(tx), 1);
      steps.push({ e: r() < 0.5 ? 'commit' : 'abort', tx });
    }
  }
  for (const tx of openTx)
    steps.push({ e: r() < 0.5 ? 'commit' : 'abort', tx });
  return steps;
}

// ─── interpreter + ideal oracle ──────────────────────────────────────────────────────────

type Key = (typeof SIGNALS)[number] | Leaf;
const KEYS: readonly Key[] = [...SIGNALS, ...LEAVES];
type Write = {
  readonly key: Key;
  readonly value: string;
  readonly tx: number | 'F';
  readonly kind: Kind;
};

export type Report = {
  readonly violations: string[];
  /** Keys that diverged from the ideal by showing a dead (resurrected) value: the stated limit. */
  resurrections: number;
  /** Aborts that changed at least one key, and aborts that yielded at least one key to a later writer. */
  effectiveAborts: number;
  yields: number;
};

export function runTrace(
  engine: Engine,
  steps: readonly Step[],
  guessRevertsAtCommit: boolean,
): Report {
  const writes: Write[] = [];
  const byValue = new Map<unknown, Write>();
  const status = new Map<number, 'open' | 'committed' | 'aborted'>();
  const report: Report = {
    violations: [],
    resurrections: 0,
    effectiveAborts: 0,
    yields: 0,
  };
  let n = 0;

  const alive = (w: Write) => {
    if (w.tx === 'F') return true;
    const s = status.get(w.tx);
    if (s === 'aborted') return false;
    return !(s === 'committed' && w.kind === 'guess' && guessRevertsAtCommit);
  };
  const actual = (k: Key): unknown =>
    (SIGNALS as readonly string[]).includes(k)
      ? engine.get(k as Target)
      : readLeaf(engine.get(ROOT) as Tree, k as Leaf);
  const ideal = (k: Key): unknown => {
    for (let i = writes.length - 1; i >= 0; i--)
      if (writes[i].key === k && alive(writes[i])) return writes[i].value;
    return `init:${k}`;
  };
  const note = (w: Write) => {
    writes.push(w);
    byValue.set(w.value, w);
  };
  const doWrite = (tx: number | 'F', key: Key, kind: Kind) => {
    const value = `${tx === 'F' ? 'F' : `T${tx}`}#${++n}`;
    note({ key, value, tx, kind });
    if ((SIGNALS as readonly string[]).includes(key))
      engine.set(key as Target, value);
    else
      engine.set(ROOT, writeLeaf(engine.get(ROOT) as Tree, key as Leaf, value));
  };
  const runOp = (tx: number, op: WriteOp) => {
    if (op.t === 'sig') {
      engine.record(tx, op.target, op.kind);
      doWrite(tx, op.target, op.kind);
      return;
    }
    engine.record(tx, ROOT, op.kind);
    if (op.t === 'leaf') return doWrite(tx, op.leaf, op.kind);
    const p = `T${tx}#${++n}`;
    const q = `T${tx}#${++n}`;
    note({ key: 'a.p', value: p, tx, kind: op.kind });
    note({ key: 'a.q', value: q, tx, kind: op.kind });
    engine.set(ROOT, { ...(engine.get(ROOT) as Tree), a: { p, q } });
  };
  const snapshot = () => new Map(KEYS.map((k) => [k, actual(k)] as const));
  const taggedBy = (v: unknown, tx: number, guessOnly = false) => {
    const w = byValue.get(v);
    return !!w && w.tx === tx && (!guessOnly || w.kind === 'guess');
  };

  steps.forEach((st, i) => {
    const where = `step ${i} (${st.e}${'tx' in st ? ` T${st.tx}` : ''})`;
    if (st.e === 'open') {
      engine.open(st.tx);
      status.set(st.tx, 'open');
    } else if (st.e === 'foreign') {
      doWrite('F', st.key, 'authoritative');
    } else if (st.e === 'slice') {
      engine.slice(st.tx, () => {
        const half = Math.ceil(st.ops.length / 2);
        st.ops.slice(0, half).forEach((op) => runOp(st.tx, op));
        const nested = st.nested;
        if (nested)
          engine.slice(nested.tx, () =>
            nested.ops.forEach((op) => runOp(nested.tx, op)),
          );
        st.ops.slice(half).forEach((op) => runOp(st.tx, op));
      });
    } else {
      const before = snapshot();
      if (st.e === 'abort') engine.abort(st.tx);
      else engine.commit(st.tx);
      status.set(st.tx, st.e === 'abort' ? 'aborted' : 'committed');
      const after = snapshot();
      let changed = false;
      for (const k of KEYS) {
        const b = before.get(k);
        const a = after.get(k);
        const guessOnly = st.e === 'commit';
        if (st.e === 'commit' && !guessRevertsAtCommit) continue;
        if (!Object.is(a, b)) {
          changed = true;
          if (!taggedBy(b, st.tx, guessOnly))
            report.violations.push(
              `${where}: ${k} held ${String(b)} (not this writer's) and became ${String(a)}`,
            );
        } else if (
          st.e === 'abort' &&
          byValue.get(b)?.tx !== st.tx &&
          writes.some((w) => w.key === k && w.tx === st.tx)
        ) {
          report.yields++;
        }
        if (taggedBy(a, st.tx, guessOnly))
          report.violations.push(
            `${where}: ${k} still holds this writer's ${String(a)}`,
          );
      }
      if (changed && st.e === 'abort') report.effectiveAborts++;
    }
    for (const k of KEYS) {
      const a = actual(k);
      if (Object.is(a, ideal(k))) continue;
      const w = byValue.get(a);
      if (w && !alive(w)) report.resurrections++;
      else
        report.violations.push(
          `${where}: ${k} = ${String(a)}, ideal ${String(ideal(k))}`,
        );
    }
  });
  return report;
}

// ─── properties under generated interleavings ────────────────────────────────────────────

const SEEDS = 4000;
const sweep = (make: () => Ledger, opt: GenOptions, guessRevert = true) => {
  const total = {
    violations: [] as string[],
    resurrections: 0,
    effectiveAborts: 0,
    yields: 0,
    failingSeeds: 0,
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = runTrace(make(), genTrace(seed, opt), guessRevert);
    if (r.violations.length) {
      total.failingSeeds++;
      if (total.violations.length < 3)
        total.violations.push(`seed ${seed}: ${r.violations[0]}`);
    }
    total.resurrections += r.resurrections;
    total.effectiveAborts += r.effectiveAborts;
    total.yields += r.yields;
  }
  return total;
};

describe('transaction overlap model: properties', () => {
  it('authoritative writes only: abort never destroys another writer, removes its own, matches the ideal', () => {
    const t = sweep(() => new Ledger('generation'), {
      guesses: false,
      length: 24,
    });
    expect(t.violations).toEqual([]);
    // non-vacuous: aborts really undo things, and really yield to later writers
    expect(t.effectiveAborts).toBeGreaterThan(SEEDS);
    expect(t.yields).toBeGreaterThan(SEEDS / 4);
  });

  it('with guesses (revert-always at commit): the same properties hold', () => {
    const t = sweep(() => new Ledger('generation'), {
      guesses: true,
      length: 24,
    });
    expect(t.violations).toEqual([]);
    expect(t.effectiveAborts).toBeGreaterThan(SEEDS);
  });

  it('the resurrection limit is real under generated traces (divergences are only dead values)', () => {
    const t = sweep(() => new Ledger('generation'), {
      guesses: true,
      length: 24,
    });
    expect(t.resurrections).toBeGreaterThan(0);
  });
});

describe('transaction overlap model: killed alternatives violate a property', () => {
  // 'no-owner' is killed by the ABA pin below: with unique values (as generated) the ownership
  // half and the value half agree, so only a writer re-landing an equal value separates them.
  const killed: Variant[] = ['blind', 'single', 'blind-root', 'no-compare'];
  for (const v of killed) {
    it(`${v}: fails under the same generators`, () => {
      const t = sweep(() => new Ledger(v), { guesses: false, length: 24 });
      expect(t.failingSeeds).toBeGreaterThan(0);
    });
  }
  it('reuse (one entry for a guess and a later authoritative write): fails once guesses are generated', () => {
    expect(
      sweep(() => new Ledger('reuse'), { guesses: false, length: 24 })
        .failingSeeds,
    ).toBe(0);
    expect(
      sweep(() => new Ledger('reuse'), { guesses: true, length: 24 })
        .failingSeeds,
    ).toBeGreaterThan(0);
  });
});

// ─── pinned counterexamples ──────────────────────────────────────────────────────────────

/** Drive a ledger with numbers instead of tags: `w(tx, target, v, kind)` = record + write in one slice. */
export function pinHarness(engine: Engine) {
  return {
    w(tx: number, target: Target, v: unknown, kind: Kind = 'authoritative') {
      engine.slice(tx, () => {
        engine.record(tx, target, kind);
        engine.set(target, v);
      });
    },
    leaf(tx: number, leaf: Leaf, v: unknown) {
      engine.slice(tx, () => {
        engine.record(tx, ROOT, 'authoritative');
        engine.set(ROOT, writeLeaf(engine.get(ROOT) as Tree, leaf, v));
      });
    },
    tree: () => engine.get(ROOT) as Tree,
  };
}

/** The pins, parameterised by an engine factory so the real transaction runs them too. */
export function definePins(
  make: (variant?: Variant) => Engine & {
    entries?(
      tx: number,
    ): readonly { gen: number; kind: Kind; target: Target }[];
  },
) {
  it('lost update (July Finding 3): B commits over A, A aborts, B survives; blind restore erases B', () => {
    for (const v of ['generation', 'blind'] as const) {
      const e = make(v);
      const h = pinHarness(e);
      e.set('x0', 1);
      e.open(1);
      h.w(1, 'x0', 2);
      e.open(2);
      h.w(2, 'x0', 3);
      e.commit(2);
      e.abort(1);
      expect(e.get('x0')).toBe(v === 'blind' ? 1 : 3);
    }
  });

  it('a commit between two slices of the same writer survives that writer abort (single-pre kills it)', () => {
    for (const v of ['generation', 'single'] as const) {
      const e = make(v);
      const h = pinHarness(e);
      e.set('x0', 1);
      e.open(1);
      h.w(1, 'x0', 2);
      e.open(2);
      h.w(2, 'x0', 3);
      e.commit(2);
      h.w(1, 'x0', 4);
      e.abort(1);
      expect(e.get('x0')).toBe(v === 'single' ? 1 : 3);
    }
  });

  it('ABA: a later committed writer re-landing an equal value keeps it (value compare alone restores)', () => {
    for (const v of ['generation', 'no-owner'] as const) {
      const e = make(v);
      const h = pinHarness(e);
      e.set('x0', 0);
      e.open(1);
      h.w(1, 'x0', 1);
      e.open(2);
      e.slice(2, () => {
        e.record(2, 'x0', 'authoritative');
        e.set('x0', 2);
        e.set('x0', 1);
      });
      e.commit(2);
      e.abort(1);
      expect(e.get('x0')).toBe(v === 'no-owner' ? 0 : 1);
    }
  });

  it('cross-path LIMIT: x reverts, twiceX computed from it stays (values, not invariants)', () => {
    const e = make();
    const h = pinHarness(e);
    e.open(1);
    h.leaf(1, 'c', 5); // A writes x
    e.open(2);
    h.leaf(2, 'b.r', (readLeaf(h.tree(), 'c') as number) * 2); // B derives twiceX from A's x
    e.commit(2);
    e.abort(1);
    expect(readLeaf(h.tree(), 'c')).toBe('init:c');
    expect(readLeaf(h.tree(), 'b.r')).toBe(10); // read-set validation would have flagged B
  });

  it('store root: paths only the aborting writer touched revert; a later writer keeps its paths and both-touched paths', () => {
    for (const v of ['generation', 'blind-root'] as const) {
      const e = make(v);
      const h = pinHarness(e);
      e.open(1);
      h.leaf(1, 'a.p', 'A');
      h.leaf(1, 'c', 'A');
      e.open(2);
      h.leaf(2, 'b.r', 'B');
      h.leaf(2, 'c', 'B');
      e.commit(2);
      e.abort(1);
      const t = h.tree();
      if (v === 'blind-root') {
        expect(t.a.p).toBe('A'); // whole-root ownership: yields everything, own write survives
        continue;
      }
      expect(t).toEqual({
        a: { p: 'init:a.p', q: 'init:a.q' },
        b: { r: 'B' },
        c: 'B',
      });
    }
  });

  it('resurrection LIMIT: both writers abort, the earlier one first; the later restores the earlier aborted value', () => {
    const e = make();
    const h = pinHarness(e);
    e.set('x0', 0);
    e.open(1);
    h.w(1, 'x0', 1);
    e.open(2);
    h.w(2, 'x0', 2);
    e.abort(1); // yields: B owns x0
    e.abort(2); // undoes its own diff: back to what it overwrote
    expect(e.get('x0')).toBe(1);
  });

  it('restore hands ownership back to the pre-value writer: X writes, Y writes, Y aborts, X aborts -> pre-X', () => {
    const e = make();
    const h = pinHarness(e);
    e.set('x0', 0);
    e.open(1);
    h.w(1, 'x0', 'X');
    e.open(2);
    h.w(2, 'x0', 'Y');
    e.abort(2); // restores X's value and X's ownership, not a fresh generation
    expect(e.get('x0')).toBe('X');
    e.abort(1);
    expect(e.get('x0')).toBe(0);
  });

  it('LIMIT: an unrecorded writer that re-lands the value this writer wrote is invisible to the rollback', () => {
    // A refetch or a plain foreign `set` confirming the same value: Object.is cannot tell it from
    // ours (an Angular signal does not even notify on an equal set), so abort restores `pre` over
    // it. Recorded writers carry generations and are not subject to this.
    const e = make();
    const h = pinHarness(e);
    e.set('x0', 0);
    e.open(1);
    h.w(1, 'x0', 5);
    e.set('x0', 5); // foreign, unrecorded, equal value
    e.abort(1);
    expect(e.get('x0')).toBe(0);

    const recorded = make();
    const r = pinHarness(recorded);
    recorded.set('x0', 0);
    recorded.open(1);
    r.w(1, 'x0', 5);
    recorded.open(2);
    r.w(2, 'x0', 5); // the same value, but recorded: a later generation owns it
    recorded.commit(2);
    recorded.abort(1);
    expect(recorded.get('x0')).toBe(5);
  });

  it('a guess and a later authoritative write by the same body get distinct entries and generations', () => {
    const e = make();
    const h = pinHarness(e);
    e.open(1);
    e.slice(1, () => {
      e.record(1, 'x0', 'guess');
      e.set('x0', 'g');
      e.record(1, 'x0', 'authoritative');
      e.set('x0', 'v');
    });
    h.w(1, 'x0', 'v2');
    const entries = e.entries?.(1) ?? [];
    expect(entries.map((x) => x.kind)).toEqual([
      'guess',
      'authoritative',
      'authoritative',
    ]);
    expect(new Set(entries.map((x) => x.gen)).size).toBe(3);
  });
}

describe('transaction overlap model: pins', () => {
  definePins((v) => new Ledger(v ?? 'generation'));
});

describe('guess entries and settlement timing (model; revert-always guesses)', () => {
  const setup = (v: Variant, body: (e: Ledger) => void) => {
    const e = new Ledger(v);
    e.set('x0', 0);
    e.open(1);
    body(e);
    return e;
  };
  const guessThenReconcile = (e: Ledger, between?: () => void) =>
    e.slice(1, () => {
      e.record(1, 'x0', 'guess');
      e.set('x0', 'g');
      between?.();
      e.record(1, 'x0', 'authoritative');
      e.set('x0', 'v');
    });

  it('a reconcile in the same slice as its guess stands at commit; a reused entry reverts it', () => {
    for (const v of ['generation', 'reuse'] as const) {
      const e = setup(v, (l) => guessThenReconcile(l));
      e.commit(1);
      expect(e.get('x0')).toBe(v === 'reuse' ? 0 : 'v');
    }
  });

  it('user write before the reconcile: the reconcile lands, the guess entry does not revert over it', () => {
    for (const v of ['generation', 'reuse'] as const) {
      const e = setup(v, (l) => guessThenReconcile(l, () => l.set('x0', 'u')));
      e.commit(1);
      expect(e.get('x0')).toBe(v === 'reuse' ? 0 : 'v');
    }
  });

  it('user write between the reconcile and the revert: the user wins', () => {
    const e = setup('generation', (l) => guessThenReconcile(l));
    e.set('x0', 'u');
    e.commit(1);
    expect(e.get('x0')).toBe('u');
  });

  it('user write inside a reentrant settlement hook, at every step of commit and of abort: the user wins', () => {
    for (const settle of ['commit', 'abort'] as const) {
      for (let at = 0; at < 3; at++) {
        const e = setup('generation', (l) => {
          l.slice(1, () => {
            l.record(1, 'x0', 'guess');
            l.set('x0', 'g');
          });
          l.slice(1, () => {
            l.record(1, 'x0', 'authoritative');
            l.set('x0', 'v');
          });
        });
        e[settle](1, (step) => {
          if (step === at) e.set('x0', 'u');
        });
        expect([settle, at, e.get('x0')]).toEqual([settle, at, 'u']);
      }
    }
  });

  it('a lone guess reverts at commit when still in effect, and yields to a later writer', () => {
    const lone = setup('generation', (l) =>
      l.slice(1, () => (l.record(1, 'x0', 'guess'), l.set('x0', 'g'))),
    );
    lone.commit(1);
    expect(lone.get('x0')).toBe(0);

    const covered = setup('generation', (l) =>
      l.slice(1, () => (l.record(1, 'x0', 'guess'), l.set('x0', 'g'))),
    );
    covered.open(2);
    pinHarness(covered).w(2, 'x0', 'B');
    covered.commit(1);
    expect(covered.get('x0')).toBe('B');
  });

  it('a closed writer cannot open a slice; a record after close is a no-op and the write lands', () => {
    const e = setup('generation', () => undefined);
    e.commit(1);
    expect(() => e.slice(1, () => undefined)).toThrow();
    e.record(1, 'x0', 'authoritative');
    e.set('x0', 'late');
    expect(e.entries(1)).toEqual([]);
    expect(e.get('x0')).toBe('late');
  });
});

// ─── the same generators and pins against the real transaction ───────────────────────────

class RealEngine implements Engine {
  readonly sigs = new Map<Target, WritableSignal<unknown>>();
  readonly txns = new Map<number, Transaction>();
  constructor() {
    for (const s of SIGNALS) this.sigs.set(s, signal<unknown>(`init:${s}`));
    this.sigs.set(ROOT, signal<unknown>(initialTree()));
  }
  get(t: Target) {
    return untracked(this.sigs.get(t) as WritableSignal<unknown>);
  }
  set(t: Target, v: unknown) {
    (this.sigs.get(t) as WritableSignal<unknown>).set(v);
  }
  open(tx: number) {
    this.txns.set(tx, createTransaction());
  }
  private tx(tx: number) {
    return this.txns.get(tx) as Transaction;
  }
  slice(tx: number, body: () => void) {
    this.tx(tx).enter(body);
  }
  record(tx: number, target: Target, kind: Kind) {
    expect(activeTransaction()).toBe(this.tx(tx)); // records go to the entered transaction
    this.tx(tx).record(this.sigs.get(target) as WritableSignal<unknown>, {
      kind,
      reconcile:
        target === ROOT ? (merge3 as RecordOptions['reconcile']) : undefined,
    });
  }
  commit(tx: number) {
    this.tx(tx).clear();
  }
  abort(tx: number) {
    this.tx(tx).restore();
  }
  entries(tx: number) {
    const byTarget = new Map([...this.sigs].map(([k, s]) => [s, k] as const));
    return this.tx(tx)
      .entries()
      .map((e) => ({
        target: byTarget.get(e.target) as Target,
        gen: e.generation,
        kind: e.kind,
      }));
  }
}

/** Drives the model and the real transaction in lockstep; every read compares them. */
class Lockstep implements Engine {
  readonly model = new Ledger('generation', false);
  readonly real = new RealEngine();
  get(t: Target) {
    const r = this.real.get(t);
    const m = this.model.get(t);
    if (t === ROOT)
      for (const l of LEAVES)
        expect(readLeaf(r as Tree, l)).toBe(readLeaf(m as Tree, l));
    else expect(r).toBe(m);
    return r;
  }
  set(t: Target, v: unknown) {
    this.model.set(t, v);
    this.real.set(t, v);
  }
  open(tx: number) {
    this.model.open(tx);
    this.real.open(tx);
  }
  slice(tx: number, body: () => void) {
    // the body runs once, inside both slices (the model's slice is pure bookkeeping)
    this.real.slice(tx, () => this.model.slice(tx, body));
  }
  record(tx: number, target: Target, kind: Kind) {
    this.model.record(tx, target, kind);
    this.real.record(tx, target, kind);
  }
  commit(tx: number) {
    this.model.commit(tx);
    this.real.commit(tx);
  }
  abort(tx: number) {
    this.model.abort(tx);
    this.real.abort(tx);
  }
}

describe('real createTransaction: generated traces, lockstep with the model', () => {
  it('matches the model at every read and satisfies the properties (guesses recorded, not reverted at commit)', () => {
    let effective = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const engine = new Lockstep();
      const r = runTrace(
        engine,
        genTrace(seed, { guesses: true, length: 24 }),
        false,
      );
      expect([seed, r.violations]).toEqual([seed, []]);
      effective += r.effectiveAborts;
    }
    expect(effective).toBeGreaterThan(1500);
  });
});

describe('real createTransaction: pins', () => {
  definePins((v) =>
    v && v !== 'generation' ? new Ledger(v) : new RealEngine(),
  );

  it('records go to the entered transaction; enter nests and restores the previous one', () => {
    const a = createTransaction();
    const b = createTransaction();
    expect(activeTransaction()).toBeNull();
    a.enter(() => {
      expect(activeTransaction()).toBe(a);
      b.enter(() => expect(activeTransaction()).toBe(b));
      a.enter(() => expect(activeTransaction()).toBe(a));
      expect(activeTransaction()).toBe(a);
    });
    expect(activeTransaction()).toBeNull();
  });

  it('enter and retain throw once closed; record is a no-op', () => {
    const x = signal(1);
    const t = createTransaction();
    t.clear();
    expect(t.closed).toBe(true);
    expect(() => t.enter(() => undefined)).toThrow('closed transaction');
    expect(() => t.retain()).toThrow('closed transaction');
    t.record(x as WritableSignal<unknown>);
    expect(t.entries()).toEqual([]);
  });

  it('abort inside a slice: open entries are fixed first, later writes in the slice land unrecorded', () => {
    const x = signal(0);
    const t = createTransaction();
    t.enter(() => {
      t.record(x as WritableSignal<unknown>);
      x.set(1);
      t.restore();
      expect(x()).toBe(0);
      activeTransaction()?.record(x as WritableSignal<unknown>);
      x.set(2);
    });
    expect(x()).toBe(2);
  });

  it('a user write from a reentrant reconcile hook during abort wins, at either restore order', () => {
    for (const hookFirst of [true, false]) {
      const x = signal<unknown>(0);
      const root = signal<unknown>({ v: 0 });
      const t = createTransaction();
      const hook = (mine: unknown, cur: unknown, pre: unknown) => {
        x.set('u');
        expect(() => t.enter(() => undefined)).toThrow();
        return merge3(mine, cur, pre);
      };
      t.enter(() => {
        const recRoot = () => (
          t.record(root, { reconcile: hook }),
          root.set({ v: 1 })
        );
        const recX = () => (t.record(x), x.set(1));
        // restore runs newest-first: recording the root last makes its hook run first
        const order = hookFirst ? [recX, recRoot] : [recRoot, recX];
        order.forEach((rec) => rec());
      });
      t.restore();
      expect([hookFirst, x(), root()]).toEqual([hookFirst, 'u', { v: 0 }]);
    }
  });

  it('a writer after a committed one restores to the committed value', () => {
    const big = { payload: new Array(1000).fill(0) };
    const x = signal<unknown>(big);
    const t = createTransaction();
    t.enter(() => (t.record(x), x.set(1)));
    t.clear();
    const u = createTransaction();
    u.enter(() => (u.record(x), x.set(2)));
    u.restore();
    expect(x()).toBe(1); // u restores its own pre, the committed value
  });
});

describe('LIMIT, generated: unrecorded equal-value confirmations are invisible to the rollback', () => {
  it('model and real agree: abort restores pre over a foreign write that re-landed our value', () => {
    for (const make of [() => new Ledger(), () => new RealEngine()] as const) {
      for (let seed = 1; seed <= 300; seed++) {
        const r = mulberry32(seed);
        const e: Engine = make();
        const target = SIGNALS[Math.floor(r() * SIGNALS.length)];
        const ours = `T1#${seed}`;
        e.set(target, 'pre');
        e.open(1);
        pinHarness(e).w(1, target, ours);
        const confirmations = 1 + Math.floor(r() * 3);
        for (let i = 0; i < confirmations; i++) e.set(target, ours); // a refetch landing the same value
        e.abort(1);
        expect([seed, e.get(target)]).toEqual([seed, 'pre']);
      }
    }
  });
});
