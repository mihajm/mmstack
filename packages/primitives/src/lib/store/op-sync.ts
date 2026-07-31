import {
  effect,
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  forkStore,
  merge3,
  type Fork,
  type ForkStoreOptions,
} from './fork-store';
import {
  compareHlc,
  compareTotal,
  createHlcClock,
  type Hlc,
  type HlcClock,
} from './hlc';
import {
  applyOps,
  diffOps,
  invertBatch,
  opLog,
  type OpLogDriver,
  type StoreOp,
} from './op-log';
import { isOpaque } from './opaque';
import { isRecord } from './predicates';
import type { WritableSignalStore } from './types';

/**
 * Wire protocol version. Version 2 ops carry `cites` + `epoch` (the dot-citation register).
 * Version 3 changes MATERIALIZATION semantics, not shape: grafts descend through plain arrays
 * (per-index ops materialize instead of silently dropping) and the documented drop rule is
 * enforced for non-plain ancestors — so a v2 replica and a v3 replica CANNOT converge on the
 * same op set, which is exactly what the version fence exists to make loud. Envelopes from
 * other versions are dropped loudly, and the tab-sync join protocol refuses to pair mismatched
 * peers: versions are never silently mixed, in shape OR in meaning.
 */
export const OP_PROTO_VERSION = 3;

type Key = string | number;

/**
 * A dot: the globally-unique identity of one op at one path, the emitting replica (`origin`)
 * plus its clock stamp. Origins are unique per replica and their clocks are monotone, so a dot
 * never collides. Citing a dot means "I observed this write and am replacing it".
 */
export type Dot = { readonly origin: string; readonly hlc: Hlc };

/**
 * A frozen observation point: the set of writes a replica had seen at a moment in time, captured
 * cheaply as a monotone sequence marker. Stamping emission against a frontier makes an op cite the
 * siblings that were live THEN, not the ones live now, so an edit made against stale knowledge (a
 * fork committed after the base moved on) stays a concurrent sibling instead of superseding writes
 * it never observed.
 */
export type DotFrontier = { readonly seq: number };

/**
 * A wire op: a structural {@link StoreOp} plus the causal metadata the register needs.
 * `cites` lists the sibling dot(s) the writer observed at the op's path when it wrote;
 * exactly those get superseded; a write nobody cited stays live as a concurrent sibling.
 * `epoch` is the op's precedence term: stamped at emission as the max of the cited dots'
 * epochs and the writer's own prior epoch at this path (monotone per writer per path), +1
 * for an authority-bumped write. `prev` (on the underlying op) stays purely an inversion
 * hint for undo/rebase and plays no role in convergence.
 */
export type SyncOp = StoreOp & {
  readonly cites: readonly Dot[];
  readonly epoch: number;
};

/**
 * The wire/journal record. `writer` is an opaque principal pseudonym (natural identity never
 * enters the envelope); `origin` identifies the emitting replica. All ops in one envelope share
 * the envelope stamp, and an envelope carries at most one op per path, so `(origin, hlc)` is a
 * unique dot per path register.
 */
export type OpEnvelope = {
  readonly proto: number;
  readonly origin: string;
  readonly writer: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly policyVersion: number;
  readonly ops: readonly SyncOp[];
};

const CONFLICT_BRAND = '~mmstackConflict';

/**
 * A preserved (jj-style) conflict: every concurrent write survives as data, sync never blocks,
 * and resolution is just a later write (which cites all surviving dots and collapses the set).
 * `siblings` holds every live top-precedence value, winner first; a concurrent delete surfaces
 * as `undefined`. `mine`/`theirs` alias the first two entries, the shape two-sided reconcile
 * seams (fork rebase) produce and consume. String-branded so it survives structured clone.
 */
export type Conflicted<T = unknown> = {
  readonly [CONFLICT_BRAND]: true;
  readonly siblings: readonly T[];
  readonly mine: T;
  readonly theirs: T;
  readonly ancestor?: T;
};

export function isConflicted<T = unknown>(
  value: unknown,
): value is Conflicted<T> {
  return typeof value === 'object' && value !== null && CONFLICT_BRAND in value;
}

const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
};
const isCleanId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !hasControlChar(v);
const isFiniteHlc = (h: unknown): boolean =>
  !!h &&
  typeof h === 'object' &&
  Number.isFinite((h as { p?: unknown }).p) &&
  Number.isFinite((h as { l?: unknown }).l);

/**
 * Deterministic, total well-formedness check for a received envelope. Returns a short reason
 * string when the envelope must be rejected WHOLE, or `null` when it is well-formed. It reads only
 * the envelope (no clock, no local state), so every replica accepts or rejects a given envelope
 * identically. This validates SHAPE, not authority: it closes malformed input (control characters
 * in an id or path segment that could forge a path-key separator, a non-integer version, an unknown
 * op kind, a negative epoch, forged cites, a root delete, two ops racing on one path). Authority and
 * access control stay at the relay; direct peer-to-peer rooms are trust-full for authority, so this
 * shape check is a peer's only line against a malformed neighbor.
 */
export function validateEnvelope(env: OpEnvelope): string | null {
  if (!env || typeof env !== 'object') return 'envelope';
  if (!isCleanId(env.origin)) return 'origin';
  if (!isCleanId(env.writer)) return 'writer';
  if (!isFiniteHlc(env.hlc)) return 'hlc';
  if (!Number.isInteger(env.version) || env.version <= 0) return 'version';
  if (!Array.isArray(env.ops)) return 'ops';
  const seenPaths = new Set<string>();
  for (const op of env.ops) {
    if (!op || typeof op !== 'object') return 'op';
    if (op.kind !== 'set' && op.kind !== 'delete' && op.kind !== 'clear')
      return 'kind';
    if (!Array.isArray(op.path)) return 'path';
    for (const seg of op.path) {
      if (typeof seg === 'string' && hasControlChar(seg)) return 'path-control';
      if (seg === '__proto__') return 'path-proto';
    }
    if (op.path.length === 0 && op.kind !== 'set') return 'root-op';
    const epoch = (op as SyncOp).epoch;
    if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch < 0)
      return 'epoch';
    const cites = (op as SyncOp).cites;
    if (!Array.isArray(cites)) return 'cites';
    for (const c of cites) {
      if (
        !c ||
        typeof c !== 'object' ||
        !isCleanId((c as Dot).origin) ||
        !isFiniteHlc((c as Dot).hlc)
      ) {
        return 'cites';
      }
    }
    // one op per path per envelope: a dot is (origin, hlc), so two ops on one path in one envelope
    // would share a dot and break the register's per-origin bookkeeping. Segments with control
    // characters are already rejected above, so this join is unambiguous.
    const key = op.path.map(String).join(String.fromCharCode(0x1f));
    if (seenPaths.has(key)) return 'dup-path';
    seenPaths.add(key);
  }
  return null;
}

export type MergeContext = {
  readonly path: readonly Key[];
};

/**
 * Resolves a concurrent set-vs-set collision. Called with a deterministic argument order
 * (`mine` = the side winning the total order) so every peer computes the same value.
 */
export type MergeFn = (
  ancestor: unknown,
  mine: unknown,
  theirs: unknown,
  ctx: MergeContext,
) => unknown;

export type MergePolicyEntry = {
  /** `'todos.*.title'` or a segment array; `'*'` matches exactly one segment. */
  readonly path: string | readonly Key[];
  readonly merge: MergeFn;
};

export const lww: MergeFn = (_ancestor, mine) => mine;

export const mergeThree: MergeFn = (ancestor, mine, theirs) =>
  merge3(ancestor, mine, theirs);

export const preserve: MergeFn = (ancestor, mine, theirs) =>
  ({
    [CONFLICT_BRAND]: true,
    siblings: [mine, theirs],
    mine,
    theirs,
    ancestor,
  }) satisfies Conflicted;

/**
 * Identity-aware array merge: reconciles two concurrent versions of
 * an array item-wise by a user-provided identity, instead of last-writer-wins on the whole
 * array. Items are matched by key; per-item fields merge via `merge3` against the ancestor
 * item; items added on either side survive; an item removed on either side and unedited on
 * the other stays removed. Item ORDER follows `mine` (the total-order winner), with `theirs`-
 * only additions appended, and arrays still TRAVEL as whole-value sets. For a list whose elements
 * move and edit concurrently, model it as a keyed container (a record of elements ordered by
 * `posBetween`) instead: `insertElement`/`moveElement`/`removeElement` write per element, so a
 * reorder and a concurrent edit both survive and elements travel one at a time.
 */
export function keyedArray(
  identity: (item: unknown) => unknown,
  opt?: { item?: MergeFn },
): MergeFn {
  const mergeItem: MergeFn = opt?.item ?? mergeThree;
  return (ancestor, mine, theirs, ctx) => {
    if (!Array.isArray(mine) || !Array.isArray(theirs)) {
      return mine; // type conflict → total-order winner, like lww
    }
    const anc = Array.isArray(ancestor) ? ancestor : [];
    const byKey = (arr: readonly unknown[]) => {
      const map = new Map<unknown, unknown>();
      for (const item of arr) map.set(identity(item), item);
      return map;
    };
    const ancMap = byKey(anc);
    const mineMap = byKey(mine);
    const theirsMap = byKey(theirs);

    const out: unknown[] = [];
    for (const item of mine) {
      const key = identity(item);
      const other = theirsMap.get(key);
      const base = ancMap.get(key);
      if (theirsMap.has(key)) {
        out.push(
          structuralEq(item, other) ? item : mergeItem(base, item, other, ctx),
        );
      } else if (!ancMap.has(key) || !structuralEq(item, base)) {
        out.push(item); // added by mine, or edited by mine while theirs removed it → keep
      }
      // else: theirs removed it and mine left it untouched → stays removed
    }
    for (const item of theirs) {
      const key = identity(item);
      if (mineMap.has(key)) continue;
      if (!ancMap.has(key) || !structuralEq(item, ancMap.get(key))) {
        out.push(item); // added by theirs, or edited by theirs while mine removed it → keep
      }
    }
    return out;
  };
}

type CompiledPolicy = {
  readonly segments: readonly string[];
  readonly merge: MergeFn;
};

function compilePolicies(
  entries: readonly MergePolicyEntry[],
): CompiledPolicy[] {
  return entries.map((e) => ({
    segments:
      typeof e.path === 'string' ? e.path.split('.') : e.path.map(String),
    merge: e.merge,
  }));
}

function matchSegments(
  segments: readonly string[],
  path: readonly Key[],
): boolean {
  if (segments.length !== path.length) return false;
  for (let i = 0; i < path.length; i++) {
    if (segments[i] !== '*' && segments[i] !== String(path[i])) return false;
  }
  return true;
}

function policyFor(
  policies: readonly CompiledPolicy[],
  path: readonly Key[],
): MergeFn {
  for (const p of policies) {
    if (matchSegments(p.segments, path)) return p.merge;
  }
  return lww;
}

const SEP = ''; // unit separator: keeps joined path keys prefix-unambiguous
const keyOf = (path: readonly Key[]): string => path.map(String).join(SEP);

function structuralEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (
      !structuralEq(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * One retained concurrent write at a path. The register keeps at most one sibling per origin
 * (a replica's newer op replaces its own older one) plus a per-origin supersession watermark,
 * so state stays bounded by the concurrent-writer count, not the op count.
 */
export type SyncSibling = {
  readonly kind: 'set' | 'delete' | 'clear';
  /** The written value for a `set`; absent for `delete`/`clear`. */
  readonly value?: unknown;
  /** The emitter's inversion hint, kept for value-merging folds; irrelevant to convergence. */
  readonly prev?: unknown;
  readonly writer: string;
  readonly origin: string;
  readonly hlc: Hlc;
  readonly epoch: number;
};

/**
 * What a fold decided for a path: a value to graft, a key removal, or `clear` (the register
 * abstains and the value at that path comes from the nearest ancestor write instead).
 */
export type FoldResult =
  | { readonly kind: 'set'; readonly value: unknown }
  | { readonly kind: 'delete' }
  | { readonly kind: 'clear' };

/**
 * A conflict-resolution fold over the live sibling set of one path register. Called with the
 * full set of causally-maximal concurrent writes; must be a pure function of that SET (never
 * of arrival order); then the materialized value converges on every peer by construction.
 *
 * A custom fold MUST keep `epoch` as its outermost comparison (prefer max-epoch siblings
 * unconditionally, as {@link compareSiblings} does). The epoch exists to retire stale values: a
 * long-partitioned replica can resurface an old write that nothing ever cited, and without the
 * epoch gate a fold that ranks it high would snap the value backwards. Folding a lower-epoch
 * sibling's content into the result reopens exactly that hazard.
 */
export type FoldFn = (
  siblings: readonly SyncSibling[],
  ctx: MergeContext,
) => FoldResult;

export type FoldPolicyEntry = {
  /** `'todos.*.title'` or a segment array; `'*'` matches exactly one segment. */
  readonly path: string | readonly Key[];
  readonly fold: FoldFn;
};

const kindClass = (k: SyncSibling['kind']): number => (k === 'clear' ? 0 : 1);

/**
 * The register's total order: max by `(epoch, kind-class, hlc, writer, origin)`, where `set`
 * and `delete` outrank `clear` at equal epoch. Epoch first makes an authority bump decisive
 * regardless of clocks (and closes stale-value resurrection); the kind-class tier makes a
 * concurrent edit's survival of a subtree replace categorical rather than a clock race; origin
 * last keeps the order strict when two replicas share a writer and a stamp.
 */
export function compareSiblings(a: SyncSibling, b: SyncSibling): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const kc = kindClass(a.kind) - kindClass(b.kind);
  if (kc !== 0) return kc;
  const byTotal = compareTotal(a.hlc, a.writer, b.hlc, b.writer);
  if (byTotal !== 0) return byTotal;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
}

const maxSibling = (siblings: readonly SyncSibling[]): SyncSibling =>
  siblings.reduce((a, b) => (compareSiblings(a, b) >= 0 ? a : b));

/** Last-writer-wins over the live sibling set: the {@link compareSiblings} maximum, as-is. */
export const defaultFold: FoldFn = (siblings) => {
  const winner = maxSibling(siblings);
  return winner.kind === 'set'
    ? { kind: 'set', value: winner.value }
    : { kind: winner.kind };
};

// preserve on the register seam: every top-precedence live sibling survives as data. A delete
// competes as a value (it may surface inside the conflict as `undefined`); lower-epoch siblings
// never surface (the epoch gate stays outermost).
const preserveFold: FoldFn = (siblings) => {
  const winner = maxSibling(siblings);
  if (winner.kind === 'clear') return { kind: 'clear' };
  const top = siblings.filter(
    (s) => s.epoch === winner.epoch && s.kind !== 'clear',
  );
  if (top.length === 1) {
    return top[0].kind === 'set'
      ? { kind: 'set', value: top[0].value }
      : { kind: 'delete' };
  }
  const ordered = [...top].sort((a, b) => compareSiblings(b, a));
  const values = ordered.map((s) => (s.kind === 'set' ? s.value : undefined));
  const conflicted: Conflicted = {
    [CONFLICT_BRAND]: true,
    siblings: values,
    mine: values[0],
    theirs: values[1],
    ancestor: ordered[1].prev,
  };
  return { kind: 'set', value: conflicted };
};

// A two-sided MergeFn generalized to N siblings: reduce over the canonically-ordered
// top-precedence set, winner first, each step merging the next sibling against its own `prev`
// as the ancestor. The iteration order is a pure function of the set, so the result converges
// even for merges that are not associative (the reason pairwise-at-arrival diverged).
const mergeFold = (merge: MergeFn): FoldFn => {
  return (siblings, ctx) => {
    const ordered = [...siblings].sort((a, b) => compareSiblings(b, a));
    const winner = ordered[0];
    if (winner.kind !== 'set') return { kind: winner.kind };
    let acc = winner.value;
    for (let i = 1; i < ordered.length; i++) {
      const s = ordered[i];
      if (s.kind !== 'set' || s.epoch !== winner.epoch) continue;
      acc = merge(s.prev, acc, s.value, ctx);
    }
    return { kind: 'set', value: acc };
  };
};

/**
 * Per-path register state, serializable: the live + superseded siblings and the per-origin
 * supersession watermarks. This is what a snapshot ships, never a folded value: a
 * joiner seeded with only a value cannot supersede or be superseded correctly afterwards.
 */
export type RegisterCheckpoint = {
  readonly path: readonly Key[];
  readonly siblings: readonly SyncSibling[];
  readonly water: Readonly<Record<string, Hlc>>;
};

export type ConvergingApply = {
  /**
   * Fold an envelope into the per-path registers and return the materialization deltas the
   * local store must apply: plain `set`/`delete` ops (never `clear`), `[]` when no fold
   * winner changed. Pass `local: true` for envelopes this peer emitted itself: registered,
   * nothing returned, unless `reconcile: true` is also set, which registers the op locally AND
   * returns the fold delta (a fork commit lands as a concurrent sibling, so the store must move to
   * the fold winner rather than the raw committed value). Pass `frontier` to reject ops at or below
   * a pruned horizon, so a straggler older than compacted state can never resurrect.
   */
  ingest(
    env: OpEnvelope,
    opt?: { local?: boolean; reconcile?: boolean; frontier?: Hlc },
  ): StoreOp[];
  /**
   * Stamp locally-diffed ops for emission: each op cites the live dots at its path and adopts
   * `max(observed epoch, own prior epoch at the path)`, plus 1 per path when `bump` is set (an
   * authority override). A `set`/`delete` at a path additionally expands into one `clear` per
   * live descendant register (the observed-remove half of a subtree replace), so a concurrent
   * descendant edit this replica never saw stays live and survives the replace. Pass `frontier` to
   * cite only the siblings observed as of that point (a fork committing what it saw when it forked),
   * so mid-flight writes stay concurrent instead of being superseded.
   */
  stamp(
    ops: readonly StoreOp[],
    opt?: { bump?: boolean; frontier?: DotFrontier },
  ): SyncOp[];
  /** Capture the current observation frontier, for later scoped emission; O(1). */
  captureFrontier(): DotFrontier;
  /** The live (causally-maximal) siblings at a path: the emission-frontier read. */
  liveAt(path: readonly Key[]): readonly SyncSibling[];
  /**
   * Deepest-live-wins materialization of the whole tree from the current register state: the
   * root register's fold value with every live descendant fold grafted on. This is what a
   * replica's root reads after loading a checkpoint, so a joiner given only register state
   * (never a folded value) can derive its root through its OWN fold configuration.
   */
  materialize(): unknown;
  /** Serializable register state for a snapshot/seed checkpoint. */
  checkpoint(): RegisterCheckpoint[];
  /** Merge checkpointed register state in (idempotent; call after `reset()` on hydrate). */
  load(registers: readonly RegisterCheckpoint[]): void;
  /**
   * Drop settled state at or below the stability frontier: superseded siblings and their
   * watermarks, plus a register whose only live winner is a below-frontier tombstone once nothing
   * else still materializes its key (no live descendant register, no live ancestor `set` value
   * holding it), so state stays bounded under key churn. Never changes a fold above the frontier;
   * pair with `ingest`'s `frontier` so pruned ops are rejected on re-delivery.
   */
  prune(frontier: Hlc): void;
  /** Drop all registers (snapshot compaction / rehydration boundary). Emission epoch floors survive. */
  reset(): void;
};

type PathReg = {
  readonly path: readonly Key[];
  readonly siblings: Map<string, SyncSibling>;
  readonly water: Map<string, Hlc>;
  /** signature of the current live set, the cheap change detector. */
  sig: string;
  /** the last fold result: what the store currently materializes for this path. */
  result?: FoldResult;
};

const isPlainArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && !isOpaque(v);

/**
 * The graft-side container admission. MUST equal `diffNode`'s descent set (plain records and
 * plain non-opaque arrays) and `applyAt`'s copy set: emission, incremental apply and
 * checkpoint materialization decide "container or leaf" identically, or a checkpoint-seeded
 * replica and an incrementally-applied one disagree about the same op set.
 */
const isContainer = (v: unknown): v is Record<string, unknown> =>
  isPlainArray(v) || isRecord(v);

/**
 * The unsequenced-topology convergence core: a dot-citation multi-value register per path.
 * An op supersedes exactly the sibling dots it cites; uncited concurrent writes stay live; a
 * pluggable fold resolves the live set at read. Both the live set and any pure fold over it
 * are functions of the delivered op SET, so any arrival order of the same envelopes (split,
 * duplicated, cites-before-ops) yields the same state.
 */
export function createConvergingApply(opt?: {
  policies?: readonly MergePolicyEntry[];
  /** Per-path custom folds; take precedence over the `policies` mapping. */
  folds?: readonly FoldPolicyEntry[];
  /** The local replica id: lets loaded checkpoints restore this replica's emission epoch floors. */
  origin?: string;
}): ConvergingApply {
  const registers = new Map<string, PathReg>();
  // per-path floor of this replica's own emitted epochs: monotone, survives reset() so a
  // rehydrated replica can never re-emit below an epoch it already exposed
  const floors = new Map<string, number>();
  // monotone ingest counter + the seq at which each live sibling arrived (keyed pathKey → origin).
  // captureFrontier() reads the counter in O(1); a frontier-scoped stamp cites only siblings at or
  // below the captured seq. Side-mapped so the public sibling/checkpoint shapes stay unchanged.
  let ingestSeq = 0;
  const seqs = new Map<string, Map<string, number>>();
  const setSeq = (key: string, origin: string, seq: number): void => {
    let sm = seqs.get(key);
    if (!sm) seqs.set(key, (sm = new Map()));
    sm.set(origin, seq);
  };
  const policies = compilePolicies(opt?.policies ?? []);
  const customFolds = (opt?.folds ?? []).map((e) => ({
    segments:
      typeof e.path === 'string' ? e.path.split('.') : e.path.map(String),
    fold: e.fold,
  }));

  const foldFor = (path: readonly Key[]): FoldFn => {
    for (const f of customFolds) {
      if (matchSegments(f.segments, path)) return f.fold;
    }
    const merge = policyFor(policies, path);
    if (merge === lww) return defaultFold;
    if (merge === preserve) return preserveFold;
    return mergeFold(merge);
  };

  const regAt = (path: readonly Key[]): PathReg => {
    const key = keyOf(path);
    let reg = registers.get(key);
    if (!reg) {
      reg = { path, siblings: new Map(), water: new Map(), sig: '' };
      registers.set(key, reg);
    }
    return reg;
  };

  const liveOf = (reg: PathReg): SyncSibling[] => {
    const out: SyncSibling[] = [];
    for (const [o, s] of reg.siblings) {
      const w = reg.water.get(o);
      if (!w || compareHlc(s.hlc, w) > 0) out.push(s);
    }
    return out.sort((a, b) =>
      a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0,
    );
  };

  const liveObserved = (
    reg: PathReg,
    frontier: DotFrontier | undefined,
  ): SyncSibling[] => {
    const live = liveOf(reg);
    if (!frontier) return live;
    const sm = seqs.get(keyOf(reg.path));
    return live.filter((s) => (sm?.get(s.origin) ?? 0) <= frontier.seq);
  };

  const sigOf = (live: readonly SyncSibling[]): string =>
    JSON.stringify(
      live.map((s) => [s.origin, s.hlc.p, s.hlc.l, s.epoch, s.kind]),
    );

  /** Recompute the fold cache; true iff the materialized result meaningfully changed. */
  const refresh = (reg: PathReg): boolean => {
    const live = liveOf(reg);
    const sig = sigOf(live);
    if (sig === reg.sig) return false;
    reg.sig = sig;
    const next = live.length
      ? foldFor(reg.path)(live, { path: reg.path })
      : undefined;
    const prev = reg.result;
    const same =
      prev === next ||
      (!!prev &&
        !!next &&
        prev.kind === next.kind &&
        (prev.kind !== 'set' ||
          next.kind !== 'set' ||
          Object.is(prev.value, next.value) ||
          structuralEq(prev.value, next.value)));
    if (same) return false; // keep the previous result object: reference identity is the contract
    reg.result = next;
    return true;
  };

  const descendantsOf = (key: string): PathReg[] => {
    const out: PathReg[] = [];
    for (const [k, r] of registers) {
      if (k === key) continue;
      if (key === '' ? k !== '' : k.startsWith(key + SEP)) out.push(r);
    }
    return out.sort(
      (a, b) =>
        a.path.length - b.path.length ||
        (keyOf(a.path) < keyOf(b.path) ? -1 : 1),
    );
  };

  /** Does `value` still hold a key at `rel` (present, not merely undefined)? */
  const holdsKey = (value: unknown, rel: readonly Key[]): boolean => {
    let cur = value;
    for (const seg of rel) {
      if (
        cur === null ||
        typeof cur !== 'object' ||
        !Object.hasOwn(cur, String(seg))
      ) {
        return false;
      }
      cur = (cur as Record<string, unknown>)[String(seg)];
    }
    return true;
  };

  const tombstoneDroppable = (key: string, reg: PathReg): boolean => {
    for (const [k, other] of registers) {
      if (k === key) continue;
      if (k.startsWith(key + SEP)) {
        if (liveOf(other).length > 0) return false;
      } else if (key.startsWith(k === '' ? '' : k + SEP)) {
        const rel = reg.path.slice(other.path.length);
        for (const s of liveOf(other)) {
          if (s.kind === 'set' && holdsKey(s.value, rel)) return false;
        }
      }
    }
    return true;
  };

  /** Nearest ancestor register that contributes a value or a deletion (clears abstain). */
  const nearestContributing = (path: readonly Key[]): PathReg | undefined => {
    for (let len = path.length - 1; len >= 0; len--) {
      const reg = registers.get(keyOf(path.slice(0, len)));
      if (reg?.result && reg.result.kind !== 'clear') return reg;
    }
    return undefined;
  };

  const graft = (
    tree: unknown,
    rel: readonly Key[],
    res: FoldResult,
  ): unknown => {
    if (!isContainer(tree)) return tree;
    const head = String(rel[0]);

    if (head === '__proto__') return tree;
    const copyOf = (): Record<string, unknown> =>
      (isPlainArray(tree) ? tree.slice() : { ...tree }) as Record<
        string,
        unknown
      >;
    if (rel.length === 1) {
      if (res.kind === 'delete') {
        if (!Object.hasOwn(tree, head)) return tree;
        const copy = copyOf();

        delete copy[head];
        return copy;
      }
      const copy = copyOf();
      copy[head] = (res as { value: unknown }).value;
      return copy;
    }
    if (!Object.hasOwn(tree, head)) {
      const vivified: Record<string, unknown> | unknown[] =
        typeof rel[1] === 'number' ? [] : {};
      const copy = copyOf();
      copy[head] = graft(vivified, rel.slice(1), res);
      return copy;
    }
    const child = graft(tree[head], rel.slice(1), res);
    if (child === tree[head]) return tree;
    const copy = copyOf();
    copy[head] = child;
    return copy;
  };

  /** Would a value at `rel` under `value` materialize, per the graft rules? */
  const graftable = (value: unknown, rel: readonly Key[]): boolean => {
    let cur = value;
    for (let i = 0; i < rel.length - 1; i++) {
      if (!isContainer(cur) || !Object.hasOwn(cur, String(rel[i])))
        return false;
      cur = cur[String(rel[i])];
    }
    return isContainer(cur);
  };

  /**
   * Whether a value at `path` materializes: every contributing ancestor register down the
   * chain must be a `set` whose value composes containers to the next one. The drop rule is
   * checked against the WHOLE chain, since a graft fine under its nearest ancestor can still drop
   * at a scalar further up.
   */
  const shows = (path: readonly Key[]): boolean => {
    let holder: PathReg | undefined;
    for (let len = 0; len < path.length; len++) {
      const reg = registers.get(keyOf(path.slice(0, len)));
      if (!reg?.result || reg.result.kind === 'clear') continue;
      if (holder) {
        const hres = holder.result;
        if (!hres || hres.kind !== 'set') return false;
        if (!graftable(hres.value, reg.path.slice(holder.path.length))) {
          return false;
        }
      }
      holder = reg;
    }
    if (!holder) return true; // nothing above constrains → vivify semantics
    const hres = holder.result;
    if (!hres || hres.kind !== 'set') return false;
    return graftable(hres.value, path.slice(holder.path.length));
  };

  /** Deepest-live-wins subtree value: the register's fold value with every live descendant fold grafted on. */
  const materializeAt = (base: PathReg): unknown => {
    const res = base.result;
    let tree: unknown = res && res.kind === 'set' ? res.value : undefined;
    for (const d of descendantsOf(keyOf(base.path))) {
      const r = d.result;
      if (!r || r.kind === 'clear') continue;
      if (!shows(d.path)) continue; // dropped under a deleted/scalar ancestor (matches applied deltas)
      tree = graft(tree, d.path.slice(base.path.length), r);
    }
    return tree;
  };

  type Changed = { reg: PathReg; before: FoldResult | undefined };

  const deltas = (changed: Changed[]): StoreOp[] => {
    changed.sort(
      (a, b) =>
        a.reg.path.length - b.reg.path.length ||
        (keyOf(a.reg.path) < keyOf(b.reg.path) ? -1 : 1),
    );
    const out: StoreOp[] = [];
    const regions: string[] = [];
    const covered = (key: string): boolean =>
      regions.some(
        (r) => key === r || (r === '' ? true : key.startsWith(r + SEP)),
      );

    for (const { reg, before } of changed) {
      const key = keyOf(reg.path);
      if (covered(key)) continue;
      const res = reg.result;

      if (!res || res.kind === 'clear') {
        // the register now abstains: re-materialize the nearest ancestor region it cleared out of
        if (!reg.path.length) continue;
        const anc = nearestContributing(reg.path);
        const ares = anc?.result;
        if (!anc || !ares || ares.kind !== 'set' || !shows(anc.path)) continue;
        out.push({ kind: 'set', path: anc.path, next: materializeAt(anc) });
        regions.push(keyOf(anc.path));
        continue;
      }

      if (!shows(reg.path)) continue; // dropped by the type-change rule or a deleted parent

      if (res.kind === 'delete') {
        if (!reg.path.length) continue; // a root delete is meaningless
        out.push({
          kind: 'delete',
          path: reg.path,
          prev: before?.kind === 'set' ? before.value : undefined,
        });
      } else {
        out.push({ kind: 'set', path: reg.path, next: materializeAt(reg) });
      }
      regions.push(key);
    }
    return out;
  };

  return {
    ingest: (env, o) => {
      const touched = new Map<string, Changed>();
      const seq = ++ingestSeq;

      for (const op of env.ops) {
        if (o?.frontier && compareHlc(env.hlc, o.frontier) <= 0) continue;

        if (!op.path.length && op.kind !== 'set') continue;
        const reg = regAt(op.path);
        const key = keyOf(op.path);
        if (!touched.has(key)) touched.set(key, { reg, before: reg.result });

        const sop = op as SyncOp;
        for (const c of sop.cites ?? []) {
          // a self-citation (the op citing its own dot) would born-dead the write; ignore it
          if (c.origin === env.origin && compareHlc(c.hlc, env.hlc) === 0)
            continue;
          const cur = reg.water.get(c.origin);
          if (!cur || compareHlc(c.hlc, cur) > 0)
            reg.water.set(c.origin, c.hlc);
        }
        const best = reg.siblings.get(env.origin);
        if (!best || compareHlc(env.hlc, best.hlc) > 0) {
          const sib: {
            -readonly [K in keyof SyncSibling]: SyncSibling[K];
          } = {
            kind: op.kind,
            writer: env.writer,
            origin: env.origin,
            hlc: env.hlc,
            epoch: sop.epoch ?? 0,
          };
          if (op.kind === 'set') sib.value = op.next;
          if (op.kind !== 'clear' && Object.hasOwn(op, 'prev')) {
            sib.prev = (op as { prev?: unknown }).prev;
          }
          reg.siblings.set(env.origin, sib);
          setSeq(key, env.origin, seq);
        }

        if (o?.local && (sop.epoch ?? 0) > 0) {
          floors.set(key, Math.max(floors.get(key) ?? 0, sop.epoch as number));
        }
      }

      const changed: Changed[] = [];
      for (const c of touched.values()) {
        if (refresh(c.reg)) changed.push(c);
      }
      if ((o?.local && !o?.reconcile) || !changed.length) return [];
      return deltas(changed);
    },

    stamp: (ops, o) => {
      const out: SyncOp[] = [];
      const bump = o?.bump ? 1 : 0;
      const frontier = o?.frontier;
      const epochFor = (key: string, live: readonly SyncSibling[]): number => {
        let e = floors.get(key) ?? 0;
        for (const s of live) if (s.epoch > e) e = s.epoch;
        return e + bump;
      };
      for (const op of ops) {
        const key = keyOf(op.path);
        const reg = registers.get(key);
        const live = reg ? liveObserved(reg, frontier) : [];
        out.push({
          ...op,
          cites: live.map((s) => ({ origin: s.origin, hlc: s.hlc })),
          epoch: epochFor(key, live),
        } as SyncOp);
        if (op.kind === 'clear') continue;
        for (const d of descendantsOf(key)) {
          if (d.result?.kind === 'clear') continue; // already abstaining
          const dlive = liveObserved(d, frontier);
          if (!dlive.length) continue;
          out.push({
            kind: 'clear',
            path: d.path,
            cites: dlive.map((s) => ({ origin: s.origin, hlc: s.hlc })),
            epoch: epochFor(keyOf(d.path), dlive),
          });
        }
      }
      return out;
    },

    captureFrontier: () => ({ seq: ingestSeq }),

    liveAt: (path) => {
      const reg = registers.get(keyOf(path));
      return reg ? liveOf(reg) : [];
    },

    materialize: () => {
      const root = registers.get('');
      const res = root?.result;
      let tree: unknown = res && res.kind === 'set' ? res.value : undefined;
      for (const d of descendantsOf('')) {
        const r = d.result;
        if (!r || r.kind === 'clear') continue;
        if (!shows(d.path)) continue; // dropped under a deleted/scalar ancestor (matches applied deltas)
        if (tree === undefined) tree = {}; // vivify: deeper registers materialize without a root write
        tree = graft(tree, d.path, r);
      }
      return tree;
    },

    checkpoint: () => {
      const out: RegisterCheckpoint[] = [];
      for (const reg of registers.values()) {
        out.push({
          path: reg.path,
          siblings: [...reg.siblings.values()],
          water: Object.fromEntries(reg.water),
        });
      }
      return out;
    },

    load: (regs) => {
      const seq = ++ingestSeq;
      for (const r of regs) {
        const reg = regAt(r.path);
        const key = keyOf(r.path);
        for (const s of r.siblings) {
          const cur = reg.siblings.get(s.origin);
          if (!cur || compareHlc(s.hlc, cur.hlc) > 0) {
            reg.siblings.set(s.origin, s);
            setSeq(key, s.origin, seq);
          }
        }
        for (const [o, h] of Object.entries(r.water)) {
          const cur = reg.water.get(o);
          if (!cur || compareHlc(h, cur) > 0) reg.water.set(o, h);
        }
        if (opt?.origin) {
          const own = reg.siblings.get(opt.origin);
          if (own) {
            floors.set(key, Math.max(floors.get(key) ?? 0, own.epoch));
          }
        }
        refresh(reg);
      }
    },

    prune: (frontier) => {
      for (const [key, reg] of [...registers]) {
        const sm = seqs.get(key);
        for (const [o, s] of [...reg.siblings]) {
          const w = reg.water.get(o);
          if (
            compareHlc(s.hlc, frontier) <= 0 &&
            w &&
            compareHlc(s.hlc, w) <= 0
          ) {
            reg.siblings.delete(o);
            sm?.delete(o);
          }
        }
        for (const [o, h] of [...reg.water]) {
          if (compareHlc(h, frontier) <= 0) reg.water.delete(o);
        }
        if (reg.siblings.size === 0 && reg.water.size === 0) {
          registers.delete(key);
          seqs.delete(key);
          floors.delete(key);
        }
      }
      const byDepth = [...registers.entries()].sort(
        (a, b) => b[1].path.length - a[1].path.length,
      );
      for (const [key, reg] of byDepth) {
        const live = liveOf(reg);
        if (
          live.length === 1 &&
          live[0].kind === 'delete' &&
          reg.siblings.size === 1 &&
          compareHlc(live[0].hlc, frontier) <= 0 &&
          tombstoneDroppable(key, reg)
        ) {
          registers.delete(key);
          seqs.delete(key);
          floors.delete(key);
        }
      }
    },

    reset: () => {
      registers.clear();
      seqs.clear();
    },
  };
}

function getAtPath(root: unknown, path: readonly Key[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<Key, unknown>)[seg];
  }
  return cur;
}

export type RebaseResult<T = unknown> = {
  root: T;
  /** Pending batches re-based onto the remote state, `prev`s refreshed. */
  pending: StoreOp[][];
};

/**
 * The shared rebase routine: invert pending, apply remote, re-apply
 * pending through the merge policies. Pure — branching's `rebase()` and the sequenced relay
 * client both call this.
 */
export function rebaseOps<T>(
  root: T,
  pending: readonly (readonly StoreOp[])[],
  remote: readonly StoreOp[],
  policies?: readonly MergePolicyEntry[],
): RebaseResult<T> {
  const compiled = compilePolicies(policies ?? []);

  let base: unknown = root;
  for (let i = pending.length - 1; i >= 0; i--) {
    base = applyOps(base, invertBatch(pending[i]));
  }
  base = applyOps(base, remote);

  const rebased: StoreOp[][] = [];
  for (const batch of pending) {
    const next: StoreOp[] = [];
    for (const op of batch) {
      if (op.kind === 'clear') {
        next.push(op); // a register intent, not a value change: passes through untouched
        continue;
      }
      const cur = getAtPath(base, op.path);
      if (op.kind === 'delete') {
        next.push({ kind: 'delete', path: op.path, prev: cur });
      } else if (cur === undefined) {
        next.push({ kind: 'set', path: op.path, next: op.next });
      } else if (Object.hasOwn(op, 'prev') && !structuralEq(op.prev, cur)) {
        const merge = policyFor(compiled, op.path);
        const resolved = merge(op.prev, op.next, cur, { path: op.path });
        next.push({ kind: 'set', path: op.path, next: resolved, prev: cur });
      } else {
        next.push({ kind: 'set', path: op.path, next: op.next, prev: cur });
      }
    }
    base = applyOps(base, next);
    rebased.push(next);
  }

  return { root: base as T, pending: rebased };
}

/**
 * A per-path-policy `ForkStrategy` for `forkStore`: a three-way reconcile built from the
 * shared rebase (invert mine → apply theirs' delta → re-apply mine through the policies).
 * Paths only one side touched resolve like `merge3`; paths BOTH touched go through the
 * matching {@link MergePolicyEntry} (`lww` default — fork wins, matching `'fine'`; or
 * `mergeThree` / `preserve` / custom). Same copy-on-write contract as `'fine'`.
 */
export function policyStrategy<T>(
  policies: readonly MergePolicyEntry[],
): (ancestor: T, mine: T, theirs: T) => T {
  return (ancestor, mine, theirs) =>
    rebaseOps(
      mine,
      [diffOps(ancestor, mine)],
      diffOps(ancestor, theirs),
      policies,
    ).root;
}

export type OpSyncOptions = {
  /** Opaque principal pseudonym — provided by the app, never minted here. */
  readonly writer: string;
  readonly origin?: string;
  readonly policyVersion?: number;
  readonly policies?: readonly MergePolicyEntry[];
  /** Per-path custom register folds; take precedence over the `policies` mapping. */
  readonly folds?: readonly FoldPolicyEntry[];
  readonly clock?: HlcClock;
  readonly injector?: Injector;
  readonly driver?: OpLogDriver;
  /** A version gap from a known origin (missed envelopes) — the resync hook. */
  readonly onGap?: (origin: string, expected: number, got: number) => void;
  /** A received envelope rejected as malformed by {@link validateEnvelope}, with the reason. */
  readonly onReject?: (env: OpEnvelope, reason: string) => void;
};

/**
 * A peer-state checkpoint: the current root as the materialization base, the per-path register
 * state (siblings + watermarks), and the per-origin version watermark. Register state rides
 * along because a value alone is not enough to join a room: a peer hydrated from a bare value
 * cannot tell a late straggler from a live concurrent write, so an already-superseded op would
 * resurrect on it while every established peer keeps ignoring it.
 */
export type OpSyncCheckpoint<T = unknown> = {
  readonly root: T;
  readonly registers: readonly RegisterCheckpoint[];
  readonly wm: Readonly<Record<string, number>>;
};

/**
 * A {@link Fork} of a synced store. Everything a plain fork does, plus `rebase()`. Committing it
 * cites only the dots the fork observed when it was created (or last rebased), so an edit that
 * landed on the base mid-flight stays a concurrent sibling and the configured fold decides between
 * them; an approval click never silently discards a concurrent write.
 */
export type SyncedFork<T> = Fork<T> & {
  /**
   * Re-observe the base: a following `commit()` cites the dots visible NOW, so the fork's edits
   * supersede everything currently on the base (the reviewed-and-apply step). Keeps the staged
   * edits; only advances what the next commit claims to have seen.
   */
  rebase(): void;
};

export type OpSync<T = unknown> = {
  readonly origin: string;
  /** Locally-emitted envelopes, ready for a transport. */
  subscribe(cb: (env: OpEnvelope) => void): () => void;
  /** Converging apply of a remote envelope (echo-free; own-origin envelopes are ignored). */
  receive(env: OpEnvelope): void;
  /** Synchronously emit any pending local delta now. */
  flush(): void;
  /**
   * Run `fn` and emit the writes it makes as authority-bumped ops: each written path gets
   * epoch `max(observed at that path) + 1`, and a bumped subtree replace bumps every path it
   * clears, so concurrent edits under it lose the fold instead of surviving. Scoped and
   * synchronous: writes before/after emit normally. WHO may bump is admission policy at the
   * transport/relay, not merge semantics; the register accepts any well-formed epoch.
   */
  override(fn: () => void): void;
  /**
   * Capture the current observation frontier: the set of writes this peer has seen right now, as a
   * cheap marker. Pair with {@link commitScope} to emit later against what was observed then (the
   * fork-commit seam); {@link syncedFork} wires both together.
   */
  captureFrontier(): DotFrontier;
  /**
   * Run `fn` and stamp the writes it makes against `frontier` rather than the current register
   * state, so they cite only the siblings observed as of that frontier. A write against a stale
   * frontier lands as a concurrent sibling (the fold decides) instead of superseding writes it
   * never saw. Scoped and synchronous, like {@link override}.
   */
  commitScope(frontier: DotFrontier, fn: () => void): void;
  /** Per-origin latest versions — the handshake watermark. */
  watermark(): Record<string, number>;
  /** The full checkpoint (root + register state + watermark), for answering a peer's hello. */
  snapshot(): OpSyncCheckpoint<T>;
  /**
   * Emit the CURRENT root as a root-set envelope: the fresh-room seed of the relay contract.
   * In a fresh room nothing was observed, so the op carries no cites and no clears; on a
   * non-fresh instance it behaves as a whole-root replace (cites the root register's live
   * dots and clears observed descendant registers).
   */
  seed(): void;
  /**
   * Replace local state with a peer's checkpoint, atomically (one notification wave): adopt
   * its root, load its register state, and fold its watermark. Local envelopes the checkpoint
   * doesn't cover (per its watermark) are re-applied on top, so writes made before hydration
   * are never silently lost; the next emitted version continues past the folded watermark.
   * Pass `pending` (a durable outbox) to rebase from it instead of the bounded in-memory recent
   * ring, so an offline burst larger than that ring is not dropped from the rebase.
   */
  hydrate(state: OpSyncCheckpoint<T>, pending?: readonly OpEnvelope[]): void;
  /**
   * Re-inject a persisted local outbox on boot, WITHOUT minting new versions: each envelope is
   * applied to the store (echo-free), registered as a local winner, and handed to subscribers so a
   * transport can resend the unacknowledged tail VERBATIM under its recorded origin (idempotent at
   * receivers). Envelopes are accepted regardless of origin; their versions track per recorded
   * origin. `highWater` is that origin's emit high-water (>= every `env.version`, including any acked
   * then dropped from a debounced outbox), so a resent tail never re-mints below what the room may
   * have sequenced. This instance mints on its OWN origin: pass a fresh per-boot origin and new
   * writes start clean, so two clones of one outbox resend an identical tail (a duplicate) yet their
   * new writes land on distinct origins and never collide. Call on a FRESH instance, before any
   * `receive`/`hydrate` — restoring onto already-ingested remote winners would wrongly let a stale
   * local op override them.
   */
  restore(envs: readonly OpEnvelope[], highWater?: number): void;
  /**
   * Reclaim settled register state at or below a stability frontier: superseded siblings, their
   * watermarks, and lone tombstones nothing still materializes. Never changes the current value, so
   * it is safe to call whenever a transport learns the frontier has advanced (a straggler below it
   * is rejected at ingest, so nothing can resurrect). Without it, per-path register state grows with
   * every path ever written; with it, state stays bounded by what is live above the frontier.
   */
  prune(frontier: Hlc): void;
  destroy(): void;
};

function generateOrigin(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).substring(2);
}

/**
 * Wires a copy-on-write signal (a `store` root) to the op protocol: local writes emit
 * stamped envelopes (citing the sibling dots they observed), received envelopes fold in
 * through the converging register. The unsequenced-topology client core that
 * `tabSync(store)` and P2P transports build on.
 */
const RECENT_LOCAL_CAP = 64;

export function opSync<T extends object>(
  source: WritableSignal<T>,
  opt: OpSyncOptions,
): OpSync<T> {
  const origin = opt.origin ?? generateOrigin();
  const clock = opt.clock ?? createHlcClock();
  const conv = createConvergingApply({
    policies: opt.policies,
    folds: opt.folds,
    origin,
  });
  const subscribers = new Set<(env: OpEnvelope) => void>();
  const versions = new Map<string, number>();
  const recentLocal: OpEnvelope[] = [];
  let prunedFrontier: Hlc | undefined;

  const resolvedInjector = opt.driver
    ? null
    : (opt.injector ?? inject(Injector));

  const log = opLog(
    source,
    opt.driver
      ? { origin, driver: opt.driver }
      : { origin, injector: resolvedInjector as Injector },
  );

  const canDefer = !opt.driver;
  const outbox: OpEnvelope[] = [];
  let receiving = false;
  let bumping = false;
  // set while a synced fork's commit is emitting: freezes emission cites to what the fork observed
  let scopeFrontier: DotFrontier | undefined;

  // a signal the drain reaction tracks; bumping it schedules an outbox drain for the next tick
  const drainTick = signal(0);
  const scheduleDrain = (): void => drainTick.update((v) => v + 1);

  const notify = (env: OpEnvelope): void => {
    for (const cb of [...subscribers]) cb(env);
  };
  const drainOutbox = (): void => {
    for (const env of outbox.splice(0)) notify(env);
  };

  const emitLocal = (ops: readonly StoreOp[]): void => {
    const frontier = scopeFrontier;
    const stamped = conv.stamp(ops, { bump: bumping, frontier });
    const nextVersion = (versions.get(origin) ?? 0) + 1;
    const env: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      origin,
      writer: opt.writer,
      version: nextVersion,
      hlc: clock.next(),
      policyVersion: opt.policyVersion ?? 0,
      ops: stamped,
    };
    versions.set(origin, nextVersion);
    if (frontier) {
      // a fork commit: its ops are concurrent siblings (they cite only the fork-time frontier), so
      // move the store to the fold winner rather than leaving the raw committed value in place
      const reconciled = conv.ingest(env, { local: true, reconcile: true });
      if (reconciled.length) log.apply(reconciled);
    } else {
      conv.ingest(env, { local: true });
    }
    recentLocal.push(env);
    if (recentLocal.length > RECENT_LOCAL_CAP) recentLocal.shift();
    // mid-receive, or a drain still owed → queue (frozen stamp verbatim) instead of emitting now
    if (canDefer && (receiving || outbox.length)) {
      outbox.push(env);
      scheduleDrain();
      return;
    }
    notify(env);
  };

  const unsub = log.subscribe((batch) => emitLocal(batch.ops));

  // fires on the tick after `scheduleDrain`: emits frozen local envelopes outside any receive frame
  const drainRun = (): void => {
    drainTick();
    untracked(drainOutbox);
  };
  const drainRef = canDefer
    ? effect(drainRun, { injector: resolvedInjector as Injector })
    : null;

  return {
    origin,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    receive: (env) => {
      if (env.origin === origin) return;
      if (env.proto !== OP_PROTO_VERSION) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/primitives] dropped envelope with proto ${env.proto} (expected ${OP_PROTO_VERSION}: ops must carry cites + epoch; emitters from another protocol version are rejected rather than silently mixed)`,
          );
        }
        return;
      }
      const reason = validateEnvelope(env);
      if (reason !== null) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/primitives] dropped malformed envelope (${reason}) from origin ${String(env.origin)}`,
          );
        }
        opt.onReject?.(env, reason);
        return;
      }

      if (prunedFrontier && compareHlc(env.hlc, prunedFrontier) <= 0) return;
      const known = versions.get(env.origin);
      if (known !== undefined && env.version <= known) return; // duplicate/covered — idempotent
      if (known !== undefined && env.version !== known + 1) {
        opt.onGap?.(env.origin, known + 1, env.version);
      }
      versions.set(env.origin, env.version);
      receiving = true;
      try {
        log.flush();
        clock.observe(env.hlc);
        const ops = conv.ingest(env);
        if (ops.length) log.apply(ops);
      } finally {
        receiving = false;
      }
    },
    flush: () => {
      drainOutbox();
      log.flush();
    },
    override: (fn) => {
      log.flush(); // earlier pending writes emit un-bumped
      bumping = true;
      try {
        fn();
        log.flush();
      } finally {
        bumping = false;
      }
    },
    captureFrontier: () => {
      log.flush(); // fold pending base writes in first, so they count as observed
      return conv.captureFrontier();
    },
    commitScope: (frontier, fn) => {
      log.flush(); // earlier pending writes emit against the live frontier, not this one
      scopeFrontier = frontier;
      try {
        fn();
        log.flush(); // stamp + register the scoped writes now, while the frontier is frozen
      } finally {
        scopeFrontier = undefined;
      }
    },
    watermark: () => Object.fromEntries(versions),
    prune: (frontier) => {
      if (!prunedFrontier || compareHlc(frontier, prunedFrontier) > 0) {
        prunedFrontier = frontier;
      }
      conv.prune(frontier);
    },
    snapshot: () => {
      log.flush();
      return {
        root: untracked(source),
        registers: conv.checkpoint(),
        wm: Object.fromEntries(versions),
      };
    },
    seed: () => {
      log.flush();
      emitLocal([{ kind: 'set', path: [], next: untracked(source) }]);
    },
    hydrate: (state, pending) => {
      log.flush();

      const source = pending ?? recentLocal;
      const toReplay = source.filter(
        (e) => e.version > (state.wm?.[e.origin] ?? 0),
      );
      conv.reset();
      conv.load(state.registers ?? []);

      const deltas: StoreOp[] = [];
      for (const e of toReplay) {
        deltas.push(...conv.ingest(e, { local: true, reconcile: true }));
      }
      log.apply([
        { kind: 'set', path: [], next: applyOps(state.root, deltas) },
      ]);
      for (const [o, v] of Object.entries(state.wm ?? {})) {
        versions.set(o, Math.max(versions.get(o) ?? 0, v));
      }
    },
    restore: (envs, highWater) => {
      let tailOrigin: string | undefined;
      for (const env of envs) {
        clock.observe(env.hlc); // keep the clock ≥ restored stamps before any future mint
        log.apply(env.ops); // reflect the offline edit in the store, echo-free
        conv.ingest(env, { local: true }); // register as a local winner (survives a reconnect merge)
        recentLocal.push(env);
        if (recentLocal.length > RECENT_LOCAL_CAP) recentLocal.shift();
        versions.set(
          env.origin,
          Math.max(versions.get(env.origin) ?? 0, env.version),
        );
        tailOrigin = env.origin;
        notify(env); // hand to the transport to resend the unacknowledged tail
      }
      if (highWater != null && tailOrigin != null) {
        versions.set(
          tailOrigin,
          Math.max(versions.get(tailOrigin) ?? 0, highWater),
        );
      }
    },
    destroy: () => {
      drainOutbox(); // don't silently drop frozen-but-unsent local writes
      unsub();
      subscribers.clear();
      drainRef?.destroy();
      log.destroy();
    },
  };
}

/**
 * Fork a synced store for isolated edits (an agent branch, a staged review), keeping the correct
 * emission semantics on commit. The fork observes the base as it was when this call ran; committing
 * emits its diff citing only those observed dots, so an edit that landed on the base mid-flight
 * stays a concurrent sibling and the configured fold decides between them, rather than the commit
 * overwriting a write it never saw. `rebase()` re-observes the base (a following commit then
 * supersedes what is visible now, the reviewed-and-apply step). Pass the same `store` and `sync`
 * that are wired together; the fork is a plain {@link Fork} otherwise, so `forkStore` itself stays
 * sync-agnostic.
 */
export function syncedFork<T extends Record<string, any>>(
  sync: OpSync,
  store: WritableSignalStore<T>,
  opt?: ForkStoreOptions<T>,
): SyncedFork<T> {
  let frontier = sync.captureFrontier();
  const f = forkStore(store, opt);
  return {
    store: f.store,
    ops: f.ops,
    commit: () => sync.commitScope(frontier, () => f.commit()),
    discard: () => {
      f.discard();
      frontier = sync.captureFrontier();
    },
    rebase: () => {
      frontier = sync.captureFrontier();
    },
  };
}
