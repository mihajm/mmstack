import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyOps, diffOps, invertBatch, type StoreOp } from './op-log';
import { isOpaque } from './opaque';
import {
  createConvergingApply,
  keyedArray,
  lww,
  mergeThree,
  rebaseOps,
  OP_PROTO_VERSION,
  type MergeFn,
  type MergePolicyEntry,
  type OpEnvelope,
  validateEnvelope,
} from './op-sync';

// K-diff P1: the pure model + theorems (`~/Desktop/ab-docs/_mmstack-kdiff-charter.md` §3, §4 P1).
// Every reference below is VERIFIER-OWNED and written from the charter prose: its own structural
// equality, its own three-way merge, its own positional fold (K4′) and its own keyed reconcile
// with duplicate correspondence (K5). The only copy of subject code is `frozenIndexDiff`, a frozen
// copy of `diffNode` at `a716e055` (the K2 baseline; never updated). The register under test is the
// REAL `createConvergingApply`; the references are installed into it as merge policies, which is
// how the default fold behaves after P2a.
//
// Tags: `[PIN K…]` a law clause pinned by example; `[PROVEN→impl]` a property over the real register
// or real `diffOps`; `[PROVEN]` a property of a verifier-owned reference alone; `[PREMISE]` a
// witness of today's behaviour (not a law); `[FINDING]` a witness the charter prose does not
// predict (see the impl log). House meaning (proof-first protocol §3): `[PROVEN]` is an EXECUTABLE
// assertion over a model, checked on bounded generated inputs — strong evidence, not a machine-
// checked proof. The one hand argument in this file is the multiplicity lemma above the identity
// theorem.
//
// NON-COVERAGE (what the model abstracts, deliberately):
// - clocks and epochs beyond stamping: siblings share epoch 0 and the total order is the HLC `p` a
//   scenario assigns; authority bumps are not generated;
// - opaque values, `-0` and `NaN` (out of the JSON-fidelity domain per `wireValueViolation`),
//   sparse arrays, `undefined` values, non-plain prototypes;
// - the `added` policy (unit mode leaves it unchanged; `diff-leaves.model.spec.ts` owns it);
// - N-sibling reduce beyond 4 writers; a missing `prev` is pinned, not generated;
// - the fork path (`merge3`, `policyStrategy`); `rebaseOps` only as the selective-undo route (F8);
// - transports that preserve aliasing (structured clone): deliveries are JSON round trips, the
//   unaliased worst case for any reference-based merge; value-pure references are indifferent;
// - checkpoint reload of descendant registers (the descendant characterization is incremental only);
// - protocol-version admission (P2a bumps `OP_PROTO_VERSION`; this model never pins its value).
//
// LAWS as restated in charter §11 + §12 (GATE P1 amendments, astra round 1):
// - SCOPE (F2): the preservation laws (K4′ outcomes, K5 survival, the identity theorem) are stated for
//   siblings SHARING an ancestor. Across a causal gap (one sibling observed a write the other did not;
//   each is merged against ITS OWN `prev`) the declared law is convergence + the exact winner-first
//   reduce over the live siblings with their own `prev`s; preservation is not promised (`[PIN causal]`).
// - PRECONDITION (F5): K4 holds for an array register with NO contributing descendant registers.
//   Per-slot registers from v3 traffic graft AFTER the unit fold; the first unit `set` at the path
//   clears them (`stamp` expands clears) and the bound holds again (`[PIN K4 descendants]`).
// - K4′ guard acceptance (F6; the "vanished" form, §14.11 ruling 1): positional merging is accepted
//   when all three are arrays of equal length AND no changed slot (on either side) structurally equals
//   ANOTHER ancestor slot whose own value ALSO changed (the value left its source slot). Every pure move
//   still fires; a copy or a duplicate-edit does not; equal-valued swaps are invisible (benign); a false
//   positive degrades to lww. Outcomes are
//   stated for two siblings; for N ≥ 3 a sibling failing a guard is skipped (`acc` kept). Identity-
//   blind by design: a reorder that also edits every moved element folds by slot (PREMISE-1), and
//   replacement vs edit merges `id` as a field (PREMISE-3); `keyedArray`/keyed containers are the remedy.
// - K4 order: the winner's order for identities no sibling removed; an identity re-admitted by a later
//   sibling's edit after an earlier sibling's removal is appended. "Missing `prev` ⇒ lww" means the
//   MERGED sibling's `prev`; the winner's is never read. Explicit `lww` stays whole-value (F7).
// - K5 clause (4) COALESCES (F4): concurrent additions of one duplicate identity fold to ONE item per
//   pair (mine's body unless equal); a lower-ranked different body is discarded, deliberately.
// - K7: every merge the register ships decides "unchanged" by structural equality (a pure function of
//   VALUES); `merge3` keeps its reference contract for forks only. Array CONFLICTS are atomic, but the
//   unchanged-side rules still apply at array paths (F3): `merge3Ref([1],[1],[2])` = `[2]`.
// - Coalescing (§14.11 ruling 4, law B): a continuous run of local writes is ONE logical write P→N; its
//   undo is the net change merged against the present (`undoRef(N, P, C)`); a run whose composite is a
//   structural no-op is dropped; a remote write inside a run splits it.
// - K6 (F1): a unit batch is valid traffic under `validateEnvelope`; the materialization change is
//   fenced by a protocol bump (P2a), not asserted here.

type Key = string | number;
type Rec = Record<string, unknown>;

const NUM_RUNS = 300;

// ---------------------------------------------------------------------------------------------
// Verifier-owned primitives
// ---------------------------------------------------------------------------------------------

const isPlainRec = (v: unknown): v is Rec => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isList = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * Structural equality, the §14.6 domain: primitives by `Object.is`; plain arrays by length + index
 * (holes ≡ `undefined`); plain records by own enumerable keys, presence-aware; everything else
 * (Date, Map, Set, class instances, functions, typed arrays) by reference only.
 */
function structEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isList(a) || isList(b)) {
    if (!isList(a) || !isList(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!structEq(a[i], b[i])) return false;
    return true;
  }
  if (isPlainRec(a) && isPlainRec(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b, k) || !structEq(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

const ABSENT: unique symbol = Symbol('absent');
type Slot = unknown | typeof ABSENT;
const field = (r: Rec, k: string): Slot =>
  Object.hasOwn(r, k) ? r[k] : ABSENT;
const same = (a: Slot, b: Slot): boolean =>
  a === ABSENT || b === ABSENT ? a === b : structEq(a, b);

/**
 * Three-way merge by VALUE (§3 K4′: "records key-wise, leaves mine-wins"; arrays atomic): a side
 * structurally equal to the ancestor is unchanged and yields to the other; both changed ⇒ plain
 * records merge key by key (presence included), anything else ⇒ mine. Pure in values: no
 * reference shortcut, so an author holding shared references and a peer holding wire copies agree.
 */
function merge3Ref(anc: Slot, mine: Slot, theirs: Slot): Slot {
  if (same(mine, theirs) || same(mine, anc)) return theirs;
  if (same(theirs, anc)) return mine;
  if (isPlainRec(anc) && isPlainRec(mine) && isPlainRec(theirs)) {
    const out: Rec = {};
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    for (const k of keys) {
      const v = merge3Ref(field(anc, k), field(mine, k), field(theirs, k));
      if (v !== ABSENT) out[k] = v;
    }
    return out;
  }
  return mine;
}

// ---------------------------------------------------------------------------------------------
// K2 baseline: a FROZEN copy of `diffNode` as of `a716e055` (`op-log.ts:116–163`), default
// options (`added` absent). Never updated: it is the byte-for-byte contract of `arrays: 'index'`.
// ---------------------------------------------------------------------------------------------

const frozenIsRecord = (value: unknown): value is Rec => {
  if (value === null || typeof value !== 'object' || isOpaque(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const frozenIsPlainArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && !isOpaque(v);

function frozenDiffNode(
  prev: unknown,
  next: unknown,
  path: readonly Key[],
  ops: StoreOp[],
  lengthRule = true,
): void {
  if (Object.is(prev, next)) return;
  if (frozenIsRecord(prev) && frozenIsRecord(next)) {
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key))
        ops.push({ kind: 'delete', path: [...path, key], prev: prev[key] });
    }
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(prev, key)) {
        ops.push({ kind: 'set', path: [...path, key], next: next[key] });
      } else {
        frozenDiffNode(prev[key], next[key], [...path, key], ops, lengthRule);
      }
    }
    return;
  }
  if (frozenIsPlainArray(prev) && frozenIsPlainArray(next)) {
    if (prev.length === next.length || !lengthRule) {
      // `!lengthRule` is the K2 NEUTER only: descend over the longer side
      const n = Math.max(prev.length, next.length);
      for (let i = 0; i < n; i++)
        frozenDiffNode(prev[i], next[i], [...path, i], ops, lengthRule);
      return;
    }
    ops.push({ kind: 'set', path, prev, next });
    return;
  }
  ops.push({ kind: 'set', path, prev, next });
}

function frozenIndexDiff(
  prev: unknown,
  next: unknown,
  lengthRule = true,
): StoreOp[] {
  const ops: StoreOp[] = [];
  frozenDiffNode(prev, next, [], ops, lengthRule);
  return ops;
}

// ---------------------------------------------------------------------------------------------
// K1 reference: unit mode. Records and leaves exactly as today; two plain arrays with different
// references compare structurally: equal ⇒ nothing, else ONE `set` with `prev` and `next`.
// ---------------------------------------------------------------------------------------------

function unitNode(
  prev: unknown,
  next: unknown,
  path: readonly Key[],
  ops: StoreOp[],
): void {
  if (Object.is(prev, next)) return;
  if (frozenIsRecord(prev) && frozenIsRecord(next)) {
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key))
        ops.push({ kind: 'delete', path: [...path, key], prev: prev[key] });
    }
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(prev, key))
        ops.push({ kind: 'set', path: [...path, key], next: next[key] });
      else unitNode(prev[key], next[key], [...path, key], ops);
    }
    return;
  }
  if (frozenIsPlainArray(prev) && frozenIsPlainArray(next)) {
    if (!structEq(prev, next)) ops.push({ kind: 'set', path, prev, next });
    return;
  }
  ops.push({ kind: 'set', path, prev, next });
}

function unitDiff(prev: unknown, next: unknown): StoreOp[] {
  const ops: StoreOp[] = [];
  unitNode(prev, next, [], ops);
  return ops;
}

// ---------------------------------------------------------------------------------------------
// K4′ reference: the positional three-way fold, WHEN SAFE (§3 K4′ verbatim). `guards` exist for
// the NEUTERS only (the default is the law).
// ---------------------------------------------------------------------------------------------

type PositionalGuards = {
  readonly moved?: boolean;
  /** apply the moved guard to `mine` too (default). `false` = the undo merge (F8 ruling B′): `mine`
   * is my own inverse, whose forward write may itself have been a reorder; only OTHERS' moves count. */
  readonly movedMine?: boolean;
  /** The §14.11 LAW (default false only so the pre-refinement guard stays constructible): fire only if the value LEFT its source slot (`side[j] ≠ anc[j]`),
   * so a copy or a duplicate-edit no longer reads as a move; every pure move still does. */
  readonly vanished?: boolean;
  readonly equalLength?: boolean;
};

/** A slot whose new value differs from `anc[i]` but structurally equals some `anc[j]`, `j ≠ i`
 * (with `vanished`: and that source slot changed too, `side[j] ≠ anc[j]`). */
function movedAgainst(
  anc: readonly unknown[],
  side: readonly unknown[],
  vanished = false,
): boolean {
  for (let i = 0; i < side.length; i++) {
    if (i < anc.length && structEq(side[i], anc[i])) continue;
    for (let j = 0; j < anc.length; j++)
      if (
        j !== i &&
        structEq(side[i], anc[j]) &&
        (!vanished || j >= side.length || !structEq(side[j], anc[j]))
      )
        return true;
  }
  return false;
}

function positionalWith(guards: PositionalGuards = {}) {
  const checkMoved = guards.moved ?? true;
  const checkLength = guards.equalLength ?? true;
  const checkMovedMine = guards.movedMine ?? true;
  const vanished = guards.vanished ?? false;
  return (anc: unknown, mine: unknown, theirs: unknown): unknown => {
    if (!isList(anc) || !isList(mine) || !isList(theirs)) return mine;
    if (
      checkLength &&
      (anc.length !== mine.length || anc.length !== theirs.length)
    )
      return mine;
    if (
      checkMoved &&
      ((checkMovedMine && movedAgainst(anc, mine, vanished)) ||
        movedAgainst(anc, theirs, vanished))
    )
      return mine;
    // per slot (over mine's length: under the equal-length guard all three agree); `Array.from`
    // visits holes too, so structurally equal inputs (hole ≡ undefined) give equal outputs
    return Array.from(mine, (m, i) => {
      const a: Slot = i < anc.length ? anc[i] : ABSENT;
      const t: Slot = i < theirs.length ? theirs[i] : ABSENT;
      if (same(m, a)) return t === ABSENT ? m : t;
      if (same(t, a)) return m;
      const v = merge3Ref(a, m, t);
      return v === ABSENT ? m : v;
    });
  };
}

/** The guard configuration the model runs under: the "vanished" form, the LAW since §14.11 ruling 1. */
const POSITIONAL_GUARDS: PositionalGuards = { vanished: true };
/** The pre-refinement guard (any changed slot equal to another ancestor slot fires), kept for the pins
 * whose story is "the pre-refinement guard gave …". */
const preRefinement = positionalWith();
const positionalRef = positionalWith(POSITIONAL_GUARDS);
/** The selective-undo merge (F8, ruling B′): `undoRef(N, P, C)` — anc = my forward `next`, mine = my
 * inverse's target `P`, theirs = the current value. Equal length required; OTHERS moved since `N` ⇒
 * lww (my inverse whole); else per slot, both changed ⇒ `merge3Ref`. */
const undoRef = positionalWith({ movedMine: false, vanished: true });
const asMerge =
  (f: (anc: unknown, mine: unknown, theirs: unknown) => unknown): MergeFn =>
  (anc, mine, theirs) =>
    f(anc, mine, theirs);

// ---------------------------------------------------------------------------------------------
// K5 reference: `keyedArray(identity)` from its documented semantics (`op-sync.ts:305–315` doc
// text: items matched by key, fields merge three-way against the ancestor item, additions on either
// side survive, an item removed on one side and unedited on the other stays removed, order follows
// mine with theirs-only items appended) PLUS K5 duplicate correspondence by VALUE (charter §3 K5 +
// §11, P1b ruling): ONE pairing rule per side — (1) occurrences structurally equal to an ancestor
// occurrence pair with it, in order; (2) the leftovers pair IN ORDER up to the smaller count (the
// immutable-update convention, at any counts); (3) the surplus ancestor occurrences are removed, the
// surplus new ones are additions; mine↔theirs through the shared ancestor occurrence; (4) additions
// of one identity on both sides pair with each other by the same rule (equal first, then in order),
// a pair is one item (mine, three-way against no ancestor), the longer side's surplus stay
// additions. Blind spot (stated): at unequal counts with nothing structurally equal, in-order pairing
// can merge an edit onto the wrong occurrence field-wise — the price of no identity for duplicates. Items merge by VALUE (`merge3Ref`, law K7), never `merge3`.
// Written before re-reading `keyedArray`'s body (oracle authorship rule).
// ---------------------------------------------------------------------------------------------

type Pairing = 'value' | 'reference'; // 'reference' is the K5 NEUTER only

/**
 * Pairs one side's occurrences of an identity with the ancestor's (K5 clauses 1–3; clause 4 reuses
 * it with theirs' additions in the ancestor seat). Returns, per side occurrence (index into `side`),
 * the ancestor occurrence index it pairs with, or -1 (added).
 */
/** Identity equality = the `Map`/`Set` key equality (SameValueZero): `NaN` is one identity (astra r3 A3). */
const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (a !== a && b !== b);

function pairOccurrences(
  anc: readonly unknown[],
  side: readonly unknown[],
  pairing: Pairing,
): number[] {
  const out = side.map(() => -1);
  const taken = anc.map(() => false);
  const eq =
    pairing === 'value' ? structEq : (a: unknown, b: unknown) => a === b;
  // (1) structurally equal to an ancestor occurrence ⇒ pair, in order
  for (let s = 0; s < side.length; s++) {
    for (let a = 0; a < anc.length; a++) {
      if (!taken[a] && eq(side[s], anc[a])) {
        out[s] = a;
        taken[a] = true;
        break;
      }
    }
  }
  // (2) the leftovers pair in order up to the smaller count; (3) the surplus stays unpaired
  // (ancestor side: removed; new side: added)
  const restS = out.flatMap((a, s) => (a === -1 ? [s] : []));
  const restA = taken.flatMap((t, a) => (t ? [] : [a]));
  restS.slice(0, restA.length).forEach((s, k) => (out[s] = restA[k]));
  return out;
}

function keyedArrayWith(
  identity: (item: unknown) => unknown,
  pairing: Pairing = 'value',
) {
  return (anc: unknown, mine: unknown, theirs: unknown): unknown => {
    if (!isList(mine) || !isList(theirs)) return mine; // type conflict ⇒ mine
    const A = isList(anc) ? anc : []; // OPEN-P1-3: a non-array ancestor reads as empty
    const ids = new Set<unknown>([...A, ...mine, ...theirs].map(identity));
    // per identity: mine occurrence index → ancestor occurrence (or -1) and theirs likewise
    const mineToAnc = new Map<number, { id: unknown; a: number }>();
    const theirsToAnc = new Map<number, { id: unknown; a: number }>();
    // clause (4): a mine addition ↔ the theirs addition of the same identity it pairs with
    const addPair = new Map<number, number>();
    const pairedTheirsAdds = new Set<number>();
    const uniqueMatch = new Map<
      unknown,
      { m?: number; t?: number; a?: number }
    >();
    for (const id of ids) {
      const ai = A.flatMap((x, i) =>
        sameValueZero(identity(x), id) ? [i] : [],
      );
      const mi = mine.flatMap((x, i) =>
        sameValueZero(identity(x), id) ? [i] : [],
      );
      const ti = theirs.flatMap((x, i) =>
        sameValueZero(identity(x), id) ? [i] : [],
      );
      if (ai.length <= 1 && mi.length <= 1 && ti.length <= 1) {
        // the documented unique path: matched by key, across all three sides
        uniqueMatch.set(id, { a: ai[0], m: mi[0], t: ti[0] });
        continue;
      }
      const pm = pairOccurrences(
        ai.map((i) => A[i]),
        mi.map((i) => mine[i]),
        pairing,
      );
      const pt = pairOccurrences(
        ai.map((i) => A[i]),
        ti.map((i) => theirs[i]),
        pairing,
      );
      mi.forEach((m, k) =>
        mineToAnc.set(m, { id, a: pm[k] === -1 ? -1 : ai[pm[k]] }),
      );
      ti.forEach((t, k) =>
        theirsToAnc.set(t, { id, a: pt[k] === -1 ? -1 : ai[pt[k]] }),
      );
      // (4) the unpaired additions of this identity on BOTH sides pair with each other: equal
      // first, then in order; a pair is one item; the longer side's surplus are additions
      const mAdds = mi.filter((_, k) => pm[k] === -1);
      const tAdds = ti.filter((_, k) => pt[k] === -1);
      const pa = pairOccurrences(
        tAdds.map((i) => theirs[i]),
        mAdds.map((i) => mine[i]),
        pairing,
      );
      pa.forEach((t, k) => {
        if (t === -1) return;
        addPair.set(mAdds[k], tAdds[t]);
        pairedTheirsAdds.add(tAdds[t]);
      });
    }
    const theirsByAnc = new Map<number, number>();
    for (const [t, { a }] of theirsToAnc) if (a !== -1) theirsByAnc.set(a, t);
    const mineByAnc = new Map<number, number>();
    for (const [m, { a }] of mineToAnc) if (a !== -1) mineByAnc.set(a, m);

    const out: unknown[] = [];
    const keep = (a: Slot, m: Slot, t: Slot): void => {
      // both present ⇒ three-way; one side absent ⇒ that side removed it: survives iff the
      // other side edited it (edit beats removal); no ancestor ⇒ an addition, survives
      if (m !== ABSENT && t !== ABSENT) out.push(merge3Ref(a, m, t));
      else if (m !== ABSENT) {
        if (a === ABSENT || !structEq(m, a)) out.push(m);
      } else if (t !== ABSENT) {
        if (a === ABSENT || !structEq(t, a)) out.push(t);
      }
    };
    for (let m = 0; m < mine.length; m++) {
      const id = identity(mine[m]);
      const u = uniqueMatch.get(id);
      if (u) {
        keep(
          u.a === undefined ? ABSENT : A[u.a],
          mine[m],
          u.t === undefined ? ABSENT : theirs[u.t],
        );
        continue;
      }
      const a = mineToAnc.get(m)?.a ?? -1;
      const t = a === -1 ? addPair.get(m) : theirsByAnc.get(a);
      keep(
        a === -1 ? ABSENT : A[a],
        mine[m],
        t === undefined ? ABSENT : theirs[t],
      );
    }
    for (let t = 0; t < theirs.length; t++) {
      const id = identity(theirs[t]);
      const u = uniqueMatch.get(id);
      if (u) {
        if (u.m === undefined)
          keep(u.a === undefined ? ABSENT : A[u.a], ABSENT, theirs[t]);
        continue;
      }
      const a = theirsToAnc.get(t)?.a ?? -1;
      if (pairedTheirsAdds.has(t)) continue; // clause (4): folded into its mine partner
      if (a === -1 || !mineByAnc.has(a))
        keep(a === -1 ? ABSENT : A[a], ABSENT, theirs[t]);
    }
    return out;
  };
}

const idOf = (x: unknown): unknown => (isPlainRec(x) ? x['id'] : x);
const keyedArrayRef = keyedArrayWith(idOf);

// ---------------------------------------------------------------------------------------------
// Generators (verifier-owned): element records with ids from a small alphabet (duplicates and
// re-use happen), optional nested record and nested scalar array; scalar arrays; copy-on-write
// edits over a base.
// ---------------------------------------------------------------------------------------------

const IDS = ['a', 'b', 'c', 'd', 'e'] as const;
const TS = ['A', 'B', 'C'] as const;

const elementArb = fc.record(
  {
    id: fc.constantFrom(...IDS),
    t: fc.constantFrom(...TS),
    n: fc.nat(4),
    sub: fc.record({ x: fc.nat(4) }),
    tags: fc.array(fc.nat(4), { maxLength: 3 }),
  },
  { requiredKeys: ['id', 't', 'n'] },
);
const recordArrayArb = fc.array(elementArb, { maxLength: 6 });
const scalarArrayArb = fc.array(fc.nat(4), { maxLength: 6 });
const anyArrayArb = fc.oneof(recordArrayArb, scalarArrayArb);

const EDIT_KINDS = [
  'field', // immutable field edit of slot i (fresh object, same id)
  'swap', // reorder keeping references
  'rotate',
  'shuffle',
  'reorderFresh', // reorder via fresh objects (map to clones)
  'insert',
  'remove',
  'replace', // replace at k with a fresh id
  'dupRef', // duplicate an occurrence: the same reference twice
  'dupClone', // duplicate an occurrence: a clone with the same id
  'nestedRec', // nested-record field edit
  'nestedArr', // nested-array edit
  'delKey', // delete a non-id key of slot i (presence change)
  'moveRewrite', // swap i, j and edit BOTH moved elements (the K4′ guard's blind spot)
] as const;
type EditKind = (typeof EDIT_KINDS)[number];
type Edit = { kind: EditKind; i: number; j: number; v: number };

const editArb = (kinds: readonly EditKind[] = EDIT_KINDS): fc.Arbitrary<Edit> =>
  fc.record({
    kind: fc.constantFrom(...kinds),
    i: fc.nat(11),
    j: fc.nat(11),
    v: fc.nat(999),
  });

const clone = <T>(v: T): T => structuredClone(v);
/** A wire copy: JSON drops aliasing (`prev` and `next` of one op no longer share subtrees). */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const freshT = (v: number): string => [...TS, 'w0', 'w1', 'w2'][v % 6];

const other = <T>(want: T, cur: unknown, alt: T): T =>
  want === cur ? alt : want;

function freshElement(like: unknown, v: number, notId?: unknown): unknown {
  if (!isPlainRec(like) && like !== undefined) {
    const x = v % 5;
    return x === notId ? (x + 1) % 5 : x;
  }
  let id: string = IDS[v % IDS.length];
  if (id === notId) id = IDS[(v + 1) % IDS.length];
  return { id, t: freshT(v >> 3), n: v % 5 };
}

/** One copy-on-write edit: untouched slots keep their references (the store contract). */
function applyEdit(arr: readonly unknown[], e: Edit): unknown[] {
  const out = arr.slice();
  const len = out.length;
  const i = len ? e.i % len : 0;
  const j = len ? e.j % len : 0;
  switch (e.kind) {
    case 'field': {
      if (!len) return out;
      const el = out[i];
      // always a CHANGE: a fresh node never equals what it replaces (honest copy-on-write)
      out[i] = isPlainRec(el)
        ? e.v % 2
          ? {
              ...el,
              t: other(freshT(e.v >> 1), el['t'], freshT((e.v >> 1) + 1)),
            }
          : { ...el, n: other((e.v >> 1) % 5, el['n'], ((e.v >> 1) + 1) % 5) }
        : other(e.v % 5, el, (e.v + 1) % 5);
      return out;
    }
    case 'swap':
      if (len) [out[i], out[j]] = [out[j], out[i]];
      return out;
    case 'rotate':
      return len ? [...out.slice(i), ...out.slice(0, i)] : out;
    case 'shuffle': {
      let s = e.v + 1;
      for (let k = len - 1; k > 0; k--) {
        s = (s * 1103515245 + 12345) % 2147483648;
        const r = s % (k + 1);
        [out[k], out[r]] = [out[r], out[k]];
      }
      return out;
    }
    case 'reorderFresh': {
      const fresh = out.map(clone);
      if (len) [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
      return fresh;
    }
    case 'insert':
      out.splice(e.i % (len + 1), 0, freshElement(out[0], e.v));
      return out;
    case 'remove':
      if (len) out.splice(i, 1);
      return out;
    case 'replace':
      if (len) out[i] = freshElement(out[i], e.v, idOf(out[i]));
      return out;
    case 'dupRef':
      if (len) out.splice(e.j % (len + 1), 0, out[i]);
      return out;
    case 'dupClone':
      if (len) out.splice(e.j % (len + 1), 0, clone(out[i]));
      return out;
    case 'nestedRec': {
      const el = out[i];
      if (len && isPlainRec(el)) {
        const cur = isPlainRec(el['sub']) ? el['sub']['x'] : undefined;
        out[i] = { ...el, sub: { x: other(e.v % 5, cur, (e.v + 1) % 5) } };
      }
      return out;
    }
    case 'nestedArr': {
      const el = out[i];
      if (len && isPlainRec(el)) {
        const tags = isList(el['tags']) ? (el['tags'] as number[]) : [];
        out[i] = {
          ...el,
          tags:
            e.v % 2 || !tags.length
              ? [...tags, e.v % 5]
              : tags.map((x) => (x + 1) % 5),
        };
      }
      return out;
    }
    case 'delKey': {
      const el = out[i];
      if (len && isPlainRec(el)) {
        const keys = Object.keys(el).filter((k) => k !== 'id');
        if (keys.length) {
          const copy: Rec = { ...el };
          delete copy[keys[e.v % keys.length]];
          out[i] = copy;
        }
      }
      return out;
    }
    case 'moveRewrite': {
      if (len < 2 || i === j) return out;
      [out[i], out[j]] = [out[j], out[i]];
      const swapped = applyEdit(out, { kind: 'field', i, j: 0, v: e.v });
      return applyEdit(swapped, { kind: 'field', i: j, j: 0, v: e.v + 1 });
    }
  }
}

const applyEdits = (
  base: readonly unknown[],
  edits: readonly Edit[],
): unknown[] =>
  edits.reduce<unknown[]>((acc, e) => applyEdit(acc, e), base.slice());

const writerEditsArb = (kinds?: readonly EditKind[]) =>
  fc.array(editArb(kinds), { minLength: 1, maxLength: 4 });

// ---------------------------------------------------------------------------------------------
// The scenario harness over the REAL register (generalizes `k-diff.premise.spec.ts` `replica()`):
// base + N writers, each stamped by its own register seeded with the base, then every envelope
// (the base included, plus duplicates) delivered to every replica in a shuffled order as a WIRE
// COPY (a JSON round trip, exact on this domain: no aliasing survives, as on a WebSocket), so
// authors hold shared references and peers hold unaliased copies.
// ---------------------------------------------------------------------------------------------

type Emission = 'unit' | 'index';
type Root = { todos: unknown[] };

const envelope = (
  origin: string,
  p: number,
  ops: OpEnvelope['ops'],
): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: origin,
  version: 1,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});

function replica(origin: string, policies?: readonly MergePolicyEntry[]) {
  const conv = createConvergingApply({ policies, origin });
  let root: unknown = {};
  return {
    origin,
    receive(env: OpEnvelope): void {
      root = applyOps(root, conv.ingest(wire(env)));
    },
    emit(ops: StoreOp[], p: number): OpEnvelope {
      const env = envelope(origin, p, conv.stamp(ops));
      root = applyOps(root, ops);
      conv.ingest(env, { local: true });
      return env;
    },
    folded: () => root as Root,
    state: () => conv.materialize() as Root,
    liveUnder: (path: readonly Key[]) => conv.liveUnder(path),
  };
}

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

type Scenario = {
  readonly base: unknown[];
  readonly writers: readonly (readonly Edit[])[];
  /** writer k's HLC `p` rank (a permutation): the total order, highest wins */
  readonly rank: readonly number[];
  readonly orderSeed: number;
};

const scenarioArb = (
  baseArb: fc.Arbitrary<unknown[]> = anyArrayArb,
  kinds?: readonly EditKind[],
): fc.Arbitrary<Scenario> =>
  fc
    .tuple(baseArb, fc.integer({ min: 2, max: 4 }), fc.nat(1 << 30))
    .chain(([base, n, orderSeed]) =>
      fc.record({
        base: fc.constant(base),
        writers: fc.array(writerEditsArb(kinds), {
          minLength: n,
          maxLength: n,
        }),
        rank: fc.shuffledSubarray(
          Array.from({ length: n }, (_, k) => k),
          { minLength: n, maxLength: n },
        ),
        orderSeed: fc.constant(orderSeed),
      }),
    );

type Run = {
  /** each writer's whole array as it wrote it (its own copy of what it observed, edited) */
  readonly arrays: readonly unknown[][];
  /** each writer's `prev`: its own materialized array just before writing (the base unless it observed) */
  readonly prevs: readonly unknown[][];
  /** LIVE writers (emitted, and observed by no emitting writer), in the total order, winner first */
  readonly ordered: readonly number[];
  readonly states: readonly Root[];
  readonly folded: readonly Root[];
};

function run(
  sc: Scenario,
  emission: Emission,
  policies?: readonly MergePolicyEntry[],
): Run {
  return runArrays(
    sc,
    (own, k) => applyEdits(own, sc.writers[k]),
    policies,
    emission,
  );
}

/**
 * `run` with each writer's array produced by `write(ownCopy, k)`. `observes[k]` (causal DAGs, F2):
 * writers `j < k` whose envelopes writer `k` receives BEFORE writing, so its `prev` is what it then
 * materializes and its real `stamp` cites their dots (superseding them).
 */
function runArrays(
  sc: Scenario,
  write: (own: unknown[], k: number) => unknown[],
  policies?: readonly MergePolicyEntry[],
  emission: Emission = 'unit',
  observes: readonly (readonly number[])[] = [],
): Run {
  const baseEnv = envelope('BASE', 1, [
    { kind: 'set', path: ['todos'], next: sc.base, cites: [], epoch: 0 },
  ]);
  const writers = sc.writers.map((_, k) => replica(`W${k}`, policies));
  const observer = replica('O', policies);
  const envs: (OpEnvelope | null)[] = [];
  const prevs: unknown[][] = [];
  const arrays = sc.writers.map((_, k) => {
    const w = writers[k];
    w.receive(baseEnv);
    for (const j of observes[k] ?? []) {
      const e = envs[j];
      if (e) w.receive(e);
    }
    const own = w.folded().todos; // the writer's own copy: its edits share references with it
    prevs.push(own);
    const mine = write(own, k);
    const ops =
      emission === 'unit'
        ? unitDiff({ todos: own }, { todos: mine })
        : diffOps({ todos: own }, { todos: mine });
    envs.push(ops.length ? w.emit(ops, 10 * (sc.rank[k] + 1)) : null);
    return mine;
  });
  const rand = mulberry32(sc.orderSeed);
  for (const r of [...writers, observer]) {
    const foreign = envs.filter(
      (e): e is OpEnvelope => e !== null && e.origin !== r.origin,
    );
    const dups = foreign.filter(() => rand() < 0.3);
    for (const e of shuffled([baseEnv, ...foreign, ...dups], rand))
      r.receive(e);
  }
  const superseded = new Set(
    envs.flatMap((e, k) =>
      e ? (observes[k] ?? []).filter((j) => envs[j]) : [],
    ),
  );
  const ordered = envs
    .map((e, k) => (e && !superseded.has(k) ? k : -1))
    .filter((k) => k !== -1)
    .sort((x, y) => sc.rank[y] - sc.rank[x]);
  const all = [...writers, observer];
  return {
    arrays,
    prevs,
    ordered,
    states: all.map((r) => r.state()),
    folded: all.map((r) => r.folded()),
  };
}

/**
 * The winner-first reduce the register documents (`mergeFold`), over verifier-owned merges: the live
 * siblings in the total order, each merged against ITS OWN `prev` (the base unless it observed).
 */
function expectedReduce(
  sc: Scenario,
  r: Run,
  merge: (anc: unknown, mine: unknown, theirs: unknown) => unknown,
): unknown[] {
  if (!r.ordered.length) return sc.base;
  let acc: unknown = r.arrays[r.ordered[0]];
  for (const k of r.ordered.slice(1)) acc = merge(r.prevs[k], acc, r.arrays[k]);
  return acc as unknown[];
}

/** Convergence + apply-parity, asserted for every run. */
function expectConverged(r: Run): unknown[] {
  const first = r.states[0];
  for (let i = 0; i < r.states.length; i++) {
    expect(structEq(r.states[i], first), `replica ${i} state diverged`).toBe(
      true,
    );
    expect(
      structEq(r.folded[i], r.states[i]),
      `replica ${i} applyOps fold ≠ materialize`,
    ).toBe(true);
  }
  return first.todos;
}

const idBag = (arr: readonly unknown[]): string =>
  JSON.stringify(arr.map((x) => JSON.stringify(idOf(x))).sort());
const isWritersArray = (
  r: Run,
  out: readonly unknown[],
  base: readonly unknown[],
): boolean =>
  r.arrays.some((a) => structEq(a, out)) ||
  (!r.ordered.length && structEq(out, base));

// ---------------------------------------------------------------------------------------------
// Root pairs for the diff laws: a root holding the edited array plus untouched / edited siblings.
// ---------------------------------------------------------------------------------------------

const pairArb = fc
  .tuple(anyArrayArb, writerEditsArb(), scalarArrayArb, fc.boolean(), fc.nat(2))
  .map(([base, edits, tags, editMeta, s]) => {
    const prev = { todos: base, meta: { tags, s }, k: 1 };
    const next = {
      ...prev,
      todos: applyEdits(base, edits),
      meta: editMeta
        ? { ...prev.meta, tags: applyEdits(tags, edits) }
        : prev.meta,
    };
    return { prev, next };
  });

function getAt(root: unknown, path: readonly Key[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<Key, unknown>)[seg];
  }
  return cur;
}

/** K1 shape: no op reaches beneath an array; an op AT a both-array path is one changed `set`. */
function unitShapeViolation(
  prev: unknown,
  next: unknown,
  ops: readonly StoreOp[],
): string | null {
  for (const op of ops) {
    for (let d = 0; d < op.path.length; d++) {
      const pre = op.path.slice(0, d);
      if (isList(getAt(prev, pre)) || isList(getAt(next, pre)))
        return `op beneath an array at ${JSON.stringify(op.path)}`;
    }
    const p = getAt(prev, op.path);
    const n = getAt(next, op.path);
    if (isList(p) && isList(n)) {
      if (
        op.kind !== 'set' ||
        !Object.hasOwn(op, 'prev') ||
        op.prev !== p ||
        op.next !== n
      )
        return `array op at ${JSON.stringify(op.path)} is not one set carrying prev and next`;
      if (structEq(p, n))
        return `equal arrays emitted at ${JSON.stringify(op.path)}`;
    }
  }
  return null;
}

describe('K1 — unit mode (reference `unitDiff`)', () => {
  it(`[PROVEN] shape law + round trip over generated pairs (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        const ops = unitDiff(prev, next);
        expect(unitShapeViolation(prev, next, ops)).toBeNull();
        expect(structEq(applyOps(prev, ops), next)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN] echo freedom: a rebuilt-but-equal root (every array a fresh copy) emits nothing (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        expect(unitDiff(prev, clone(prev))).toEqual([]);
        expect(unitDiff(next, clone(next))).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K1] a same-length reorder is ONE set with prev and next; today it is per index', () => {
    const prev = { arr: ['a', 'b'] };
    const next = { arr: ['b', 'a'] };
    expect(unitDiff(prev, next)).toStrictEqual([
      { kind: 'set', path: ['arr'], prev: prev.arr, next: next.arr },
    ]);
    expect(diffOps(prev, next)).toStrictEqual([
      { kind: 'set', path: ['arr', 0], prev: 'a', next: 'b' },
      { kind: 'set', path: ['arr', 1], prev: 'b', next: 'a' },
    ]);
  });

  it('[PIN K1] a nested array inside a unit is covered by it; an array replacing a scalar is one unit', () => {
    const prev = { arr: [{ id: 'a', tags: [1] }], x: 1 as unknown };
    const next = { arr: [{ id: 'a', tags: [2] }], x: [1] };
    expect(unitDiff(prev, next)).toStrictEqual([
      { kind: 'set', path: ['arr'], prev: prev.arr, next: next.arr },
      { kind: 'set', path: ['x'], prev: 1, next: [1] },
    ]);
  });
});

describe('K2 — index mode ≡ today (real `diffOps` vs the frozen copy)', () => {
  it(`[PROVEN→impl] diffOps(prev, next) toStrictEqual frozenIndexDiff(prev, next) (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        expect(diffOps(prev, next)).toStrictEqual(frozenIndexDiff(prev, next));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// K4 — the integrity theorem under unit emission (lww, no policy) + the index-mode negative control
// ---------------------------------------------------------------------------------------------

const premise2: Scenario = {
  // the two-partial-swaps case of `k-diff.premise.spec.ts` PREMISE-2, as a generated scenario
  base: [
    { id: 'a', t: 'A', n: 0 },
    { id: 'b', t: 'B', n: 0 },
    { id: 'c', t: 'C', n: 0 },
  ],
  writers: [
    [{ kind: 'swap', i: 0, j: 1, v: 0 }],
    [{ kind: 'swap', i: 1, j: 2, v: 0 }],
  ],
  rank: [0, 1],
  orderSeed: 7,
};

/** The soup predicate: the converged id-multiset is that of NO writer's array (nor the base's). */
const isSoup = (
  r: Run,
  out: readonly unknown[],
  base: readonly unknown[],
): boolean =>
  idBag(out) !== idBag(base) && !r.arrays.some((a) => idBag(a) === idBag(out));

describe('K4 — lww under unit emission: one writer verbatim', () => {
  it(`[PROVEN→impl] explicit \`lww\`: converged array structEq SOME writer's array; all replicas equal; applyOps fold ≡ materialize (${NUM_RUNS} runs) — since P2a the NO-POLICY default is positional (K4′), so this theorem names its policy`, () => {
    fc.assert(
      fc.property(scenarioArb(), (sc) => {
        const r = run(sc, 'unit', [{ path: ['todos'], merge: lww }]);
        const out = expectConverged(r);
        expect(isWritersArray(r, out, sc.base)).toBe(true);
        // and precisely the total-order winner's
        if (r.ordered.length)
          expect(structEq(out, r.arrays[r.ordered[0]])).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PREMISE] negative control: under INDEX emission some scenarios converge to an id-multiset of NO writer; PREMISE-2 is one', () => {
    const samples = fc.sample(
      scenarioArb(recordArrayArb, ['swap', 'rotate', 'shuffle', 'field']),
      {
        numRuns: NUM_RUNS,
        seed: 20261018,
      },
    );
    let soup = 0;
    for (const sc of samples) {
      const r = run(sc, 'index');
      const out = expectConverged(r); // index mode still CONVERGES — on slot soup
      if (isSoup(r, out, sc.base)) soup++;
    }
    expect(soup).toBeGreaterThan(0);
    const r2 = run(premise2, 'index');
    const out2 = expectConverged(r2);
    expect(isSoup(r2, out2, premise2.base)).toBe(true);
    expect(out2.map(idOf)).toEqual(['b', 'c', 'b']); // `b` twice, `a` gone (premise sorts ids)
    // the same scenario under unit emission is the winner's array, whole
    const u2 = run(premise2, 'unit');
    expect(expectConverged(u2)).toEqual(u2.arrays[1]);
  });
});

// ---------------------------------------------------------------------------------------------
// K4′ — positional three-way WHEN SAFE, installed as the policy at the array path of the REAL
// register (how the default fold behaves after P2a)
// ---------------------------------------------------------------------------------------------

const positionalPolicy = (f = positionalRef): MergePolicyEntry[] => [
  { path: ['todos'], merge: asMerge(f) },
];

/** The second disjunct of K4′ (c), a PROVENANCE BOUND (F9): NECESSARY, not a characterization — the
 * exact-reduce assertion is the characterization. The winner kept the length and moved nothing, and
 * every converged slot is sourced from the base slot or the slot of some writer that kept the length
 * and moved nothing (records field-wise; it iterates OUTPUT keys only, so a dropped key passes it —
 * `requiredKeysMissing` closes that). Writers that moved or changed the length source nothing. */
function slotSourced(a: Slot, vs: readonly Slot[], o: Slot): boolean {
  if (same(o, a) || vs.some((v) => same(o, v))) return true;
  if (!isPlainRec(o) || !isPlainRec(a) || !vs.every(isPlainRec)) return false;
  return Object.keys(o).every((k) =>
    slotSourced(
      field(a, k),
      (vs as Rec[]).map((v) => field(v, k)),
      o[k],
    ),
  );
}
/**
 * Presence (F9, RECURSIVE since P1f): for a same-length result, every key present in the base slot AND
 * in the same slot of every same-length writer (nobody deleted it) must be present in the converged
 * slot, and likewise inside every nested plain record all of those sources hold.
 */
function missingKey(
  srcs: readonly unknown[],
  o: unknown,
  at: string,
): string | null {
  if (!srcs.every(isPlainRec)) return null;
  const required = Object.keys(srcs[0] as Rec).filter((k) =>
    srcs.every((x) => Object.hasOwn(x as Rec, k)),
  );
  for (const k of required) {
    if (!isPlainRec(o) || !Object.hasOwn(o, k))
      return `${at} lost required key ${k}`;
    const deeper = missingKey(
      srcs.map((x) => (x as Rec)[k]),
      o[k],
      `${at}.${k}`,
    );
    if (deeper) return deeper;
  }
  return null;
}
function requiredKeysMissing(
  sc: Scenario,
  r: Run,
  out: readonly unknown[],
): string | null {
  if (out.length !== sc.base.length) return null;
  const ws = r.arrays.filter((w) => w.length === sc.base.length);
  for (let i = 0; i < out.length; i++) {
    const miss = missingKey(
      [sc.base[i], ...ws.map((w) => w[i])],
      out[i],
      `slot ${i}`,
    );
    if (miss) return miss;
  }
  return null;
}
function provenanceBound(
  sc: Scenario,
  r: Run,
  out: readonly unknown[],
): boolean {
  const safe = (w: readonly unknown[]) =>
    w.length === sc.base.length &&
    !movedAgainst(sc.base, w, POSITIONAL_GUARDS.vanished);
  if (!r.ordered.length || !safe(r.arrays[r.ordered[0]])) return false;
  const ws = r.ordered.map((k) => r.arrays[k]).filter(safe);
  if (out.length !== sc.base.length) return false;
  return out.every((o, i) =>
    slotSourced(
      sc.base[i],
      ws.map((w) => w[i]),
      o,
    ),
  );
}

/** Distinct-slot field edits with values no base slot holds (so no edit reads as a move). */
const distinctSlotEditsArb = fc
  .tuple(
    fc.array(elementArb, { minLength: 2, maxLength: 6 }),
    fc.integer({ min: 2, max: 4 }),
    fc.nat(1 << 30),
  )
  .filter(([base, n]) => base.length >= n)
  .chain(([base, n, orderSeed]) =>
    fc.record({
      base: fc.constant(base as unknown[]),
      slots: fc.shuffledSubarray(
        base.map((_, i) => i),
        { minLength: n, maxLength: n },
      ),
      rank: fc.shuffledSubarray(
        Array.from({ length: n }, (_, k) => k),
        { minLength: n, maxLength: n },
      ),
      orderSeed: fc.constant(orderSeed),
    }),
  );

/** Writer k sets `patch(k)` on its slot: a scenario built from explicit per-writer arrays. */
function runPatched(
  base: readonly unknown[],
  patches: readonly { slot: number; patch: Rec }[],
  rank: readonly number[],
  orderSeed: number,
  merge = positionalRef,
): { r: Run; out: unknown[] } {
  // encode each patch as a writer whose single edit is applied below via a custom array
  const sc: Scenario = {
    base: base.slice(),
    writers: patches.map(() => []),
    rank,
    orderSeed,
  };
  const r = runArrays(
    sc,
    (own, k) => {
      const out = own.slice();
      out[patches[k].slot] = {
        ...(own[patches[k].slot] as Rec),
        ...patches[k].patch,
      };
      return out;
    },
    positionalPolicy(merge),
  );
  return { r, out: expectConverged(r) };
}

describe('K4′ — positional three-way when safe (positionalRef as the array policy, real register)', () => {
  it(`[PROVEN→impl] (a) writers field-editing DISTINCT slots: every edit survives (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(distinctSlotEditsArb, ({ base, slots, rank, orderSeed }) => {
        const patches = slots.map((slot, k) => ({
          slot,
          patch: { t: `X${k}` },
        }));
        const { out } = runPatched(base, patches, rank, orderSeed);
        const expected = base.slice();
        for (const { slot, patch } of patches)
          expected[slot] = { ...(base[slot] as Rec), ...patch };
        expect(structEq(out, expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] (b) two writers editing DIFFERENT fields of the SAME slot: both fields survive (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(distinctSlotEditsArb, ({ base, slots, rank, orderSeed }) => {
        // writers 0 and 1 share slots[0]; writers ≥ 2 edit their own distinct slots
        const patches = slots.map((slot, k) =>
          k === 0
            ? { slot, patch: { t: 'X0' } }
            : k === 1
              ? { slot: slots[0], patch: { n: 7 } }
              : { slot, patch: { t: `X${k}` } },
        );
        const { out } = runPatched(base, patches, rank, orderSeed);
        const expected = base.slice();
        expected[slots[0]] = { ...(base[slots[0]] as Rec), t: 'X0', n: 7 };
        for (const { slot, patch } of patches.slice(2))
          expected[slot] = { ...(base[slot] as Rec), ...patch };
        expect(structEq(out, expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] (c)+(d) any scenario: replicas equal; converged ≡ the winner-first positional reduce; and it is SOME writer's array OR within the provenance bound (per-slot merge of same-length unmoved arrays) — the soup predicate can only hold in the second disjunct; every key nobody deleted is present (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(scenarioArb(), (sc) => {
        const r = run(sc, 'unit', positionalPolicy());
        const out = expectConverged(r);
        expect(structEq(out, expectedReduce(sc, r, positionalRef))).toBe(true);
        const d1 = isWritersArray(r, out, sc.base);
        const d2 = provenanceBound(sc, r, out);
        // outside the per-slot disjunct no soup (implied by D1 when the law holds; this is the
        // line the moved-guard NEUTER turns red), then the disjunction itself
        if (!d2)
          expect(
            isSoup(r, out, sc.base),
            'soup outside the per-slot disjunct',
          ).toBe(false);
        expect(d1 || d2).toBe(true);
        expect(requiredKeysMissing(sc, r, out)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] (c′) shape-only scenarios — every writer's array is a PERMUTATION of the base or has a different length (reorders, inserts, removes, duplications; a remove + insert that keeps the length is a replacement and excluded): the soup predicate is FALSE in every run; PREMISE-2 folds to the winner whole (${NUM_RUNS} runs)`, () => {
    const p2 = run(premise2, 'unit', positionalPolicy());
    const out2 = expectConverged(p2);
    expect(
      isSoup(p2, out2, premise2.base),
      'PREMISE-2 soup under the positional fold',
    ).toBe(false);
    expect(out2).toEqual(p2.arrays[1]);
    const shapeOnly: EditKind[] = [
      'swap',
      'rotate',
      'shuffle',
      'reorderFresh',
      'insert',
      'remove',
      'dupRef',
      'dupClone',
    ];
    fc.assert(
      fc.property(scenarioArb(anyArrayArb, shapeOnly), (sc) => {
        const r = run(sc, 'unit', positionalPolicy());
        fc.pre(
          r.arrays.every(
            (w) => w.length !== sc.base.length || idBag(w) === idBag(sc.base),
          ),
        );
        const out = expectConverged(r);
        expect(isSoup(r, out, sc.base), 'soup').toBe(false);
        expect(isWritersArray(r, out, sc.base)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const tripleArb = (baseArb: fc.Arbitrary<unknown[]> = anyArrayArb) =>
  fc
    .tuple(baseArb, writerEditsArb(), writerEditsArb())
    .map(([base, e1, e2]) => ({
      base,
      mine: applyEdits(base, e1),
      theirs: applyEdits(base, e2),
    }));

describe('K4′ — purity, the false positive, the missing prev, and what the guard cannot see', () => {
  it(`[PROVEN] (e) replica independence: the fold of shared-reference siblings ≡ the fold of deep clones (author vs peer) (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(tripleArb(), ({ base, mine, theirs }) => {
        const author = positionalRef(base, mine, clone(theirs)); // mine shares references with base
        const peer = positionalRef(clone(base), clone(mine), clone(theirs));
        expect(structEq(author, peer)).toBe(true);
        expect(structEq(positionalRef(base, mine, theirs), peer)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN] (e′) same-slot edits (field, nested record, nested array at slot 0): author form ≡ peer form (${NUM_RUNS} runs)`, () => {
    const slotKinds: EditKind[] = ['field', 'nestedRec', 'nestedArr'];
    const slot0 = fc.array(
      fc.record({
        kind: fc.constantFrom(...slotKinds),
        i: fc.constant(0),
        j: fc.constant(0),
        v: fc.nat(999),
      }),
      { minLength: 1, maxLength: 3 },
    );
    fc.assert(
      fc.property(
        fc.array(elementArb, { minLength: 1, maxLength: 3 }),
        slot0,
        slot0,
        (base, e1, e2) => {
          const mine = applyEdits(base, e1);
          const theirs = applyEdits(base, e2);
          const author = positionalRef(base, mine, wire(theirs));
          const peer = positionalRef(wire(base), wire(mine), wire(theirs));
          expect(structEq(author, peer)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K4′ e] both sides changed one slot, mine a field and theirs a nested array: both survive for the author AND for a peer', () => {
    const base = [{ id: 'a', t: 'A', tags: [1] }];
    const mine = [{ ...base[0], t: 'A2' }]; // shares `tags` with base
    const theirs = [{ ...base[0], tags: [1, 2] }];
    const expected = [{ id: 'a', t: 'A2', tags: [1, 2] }];
    expect(positionalRef(base, mine, wire(theirs))).toEqual(expected);
    expect(positionalRef(wire(base), wire(mine), wire(theirs))).toEqual(
      expected,
    );
  });

  it('[PIN K4′ fp] the pre-refinement false positive: [1,1,2] → [1,2,2] (a copy of slot 2 into slot 1) vs a concurrent slot-0 edit ⇒ both survive, [0,2,2], either winner; the pre-refinement guard gave the winner whole', () => {
    for (const rank of [
      [0, 1],
      [1, 0],
    ]) {
      const sc: Scenario = {
        base: [1, 1, 2],
        writers: [[], []],
        rank,
        orderSeed: 3,
      };
      const r = runArrays(
        sc,
        (own, k) => (k === 0 ? [own[0], 2, own[2]] : [0, own[1], own[2]]),
        positionalPolicy(),
      );
      const out = expectConverged(r);
      expect(out).toEqual([0, 2, 2]); // the copy is not a move: per slot
      const [w, l] =
        rank[0] > rank[1]
          ? [
              [1, 2, 2],
              [0, 1, 2],
            ]
          : [
              [0, 1, 2],
              [1, 2, 2],
            ];
      expect(preRefinement([1, 1, 2], w, l)).toEqual(w); // the pre-refinement guard: the winner, whole
    }
  });

  it("[PIN K4′ g] a merged sibling with NO prev folds lww (the winner whole); the winner's own prev is never read", () => {
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    const fold = (dropPrevOf: 'W' | 'L'): unknown[] => {
      const W = replica('W', positionalPolicy());
      const L = replica('L', positionalPolicy());
      const baseEnv = envelope('BASE', 1, [
        { kind: 'set', path: ['todos'], next: base, cites: [], epoch: 0 },
      ]);
      W.receive(baseEnv);
      L.receive(baseEnv);
      const set = (
        own: unknown[],
        next: unknown[],
        drop: boolean,
      ): StoreOp[] =>
        drop
          ? [{ kind: 'set', path: ['todos'], next }]
          : [{ kind: 'set', path: ['todos'], prev: own, next }];
      const ownW = W.folded().todos;
      const ownL = L.folded().todos;
      const eW = W.emit(
        set(
          ownW,
          [{ ...(ownW[0] as Rec), t: 'A2' }, ownW[1]],
          dropPrevOf === 'W',
        ),
        20,
      );
      const eL = L.emit(
        set(
          ownL,
          [ownL[0], { ...(ownL[1] as Rec), t: 'B2' }],
          dropPrevOf === 'L',
        ),
        10,
      );
      W.receive(eL);
      L.receive(eW);
      expect(structEq(W.state(), L.state())).toBe(true);
      return W.state().todos;
    };
    expect(fold('L')).toEqual([
      { id: 'a', t: 'A2' },
      { id: 'b', t: 'B' },
    ]); // lww: the winner W
    expect(fold('W')).toEqual([
      { id: 'a', t: 'A2' },
      { id: 'b', t: 'B2' },
    ]); // L's prev present ⇒ merges
    expect(positionalRef(undefined, [1], [2])).toEqual([1]);
  });

  it('[PIN K4′ condition] edit vs reorder is one side whole only WHEN the moved elements are otherwise unchanged: a reorder that also edits every moved element folds by slot, so a concurrent slot edit lands on the WRONG element (PREMISE-1 returns; keyed containers are the remedy)', () => {
    const base = [
      { id: 'a', t: 'A', n: 0 },
      { id: 'b', t: 'B', n: 0 },
    ];
    const sc: Scenario = {
      base,
      writers: [[], []],
      rank: [0, 1],
      orderSeed: 5,
    };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [
              { ...(own[1] as Rec), n: 1 },
              { ...(own[0] as Rec), n: 1 },
            ] // swap + touch both (a `pos` field)
          : [{ ...(own[0] as Rec), t: 'A2' }, own[1]], // edit `a` at slot 0; this writer wins
      positionalPolicy(),
    );
    const out = expectConverged(r);
    expect(out).toEqual([
      { id: 'b', t: 'A2', n: 1 },
      { id: 'a', t: 'A', n: 1 },
    ]); // a's edit on b
  });

  it('[PIN K4′ replace] K4′ is identity-blind: replacement vs edit at the same slot merges `id` as a field, so the edit lands on the replacement (PREMISE-3 returns)', () => {
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    const sc: Scenario = {
      base,
      writers: [[], []],
      rank: [0, 1],
      orderSeed: 9,
    };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [{ id: 'z', t: 'Z' }, own[1]]
          : [{ ...(own[0] as Rec), t: 'A2' }, own[1]],
      positionalPolicy(),
    );
    expect(expectConverged(r)).toEqual([
      { id: 'z', t: 'A2' },
      { id: 'b', t: 'B' },
    ]);
  });

  it('[COVERAGE] (c) is not vacuous: both disjuncts occur alone over the generator', () => {
    let d1Only = 0;
    let d2Only = 0;
    for (const sc of fc.sample(scenarioArb(), {
      numRuns: NUM_RUNS,
      seed: 42,
    })) {
      const r = run(sc, 'unit', positionalPolicy());
      const out = expectConverged(r);
      const d1 = isWritersArray(r, out, sc.base);
      const d2 = provenanceBound(sc, r, out);
      if (d1 && !d2) d1Only++;
      if (d2 && !d1) d2Only++;
    }
    expect(d1Only).toBeGreaterThan(0);
    expect(d2Only).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// K5 — keyedArray duplicates by VALUE correspondence
// ---------------------------------------------------------------------------------------------

const realKeyed = keyedArray(idOf);
const callReal = (a: unknown, m: unknown, t: unknown): unknown =>
  realKeyed(a, m, t, { path: ['todos'] });
const hasDupIds = (...arrs: (readonly unknown[])[]): boolean =>
  arrs.some(
    (a) => new Set(a.map((x) => JSON.stringify(idOf(x)))).size !== a.length,
  );
const keyedPolicy = (
  f: (a: unknown, m: unknown, t: unknown) => unknown = keyedArrayRef,
) => [{ path: ['todos'], merge: asMerge(f) }];

const honestKinds: readonly EditKind[] = EDIT_KINDS.filter(
  (k) => k !== 'reorderFresh' && k !== 'dupClone' && k !== 'dupRef',
);
const idKey = (x: unknown): string => JSON.stringify(idOf(x));
const count = (arr: readonly unknown[], id: string): number =>
  arr.filter((x) => idKey(x) === id).length;

describe('K5 — keyedArray duplicates by value correspondence', () => {
  it('[WAS] pre-K-diff keyedArray and keyedArrayRef DIFFERED on the smallest duplicate triple (every mine duplicate merged against the one theirs occurrence: the `byKey` collapse); since P3 the production policy equals the reference', () => {
    const x = { id: 'a', t: 'A', n: 0 };
    const anc = [x];
    const mine = [x, x]; // mine duplicated `x` (the same reference twice)
    const theirs = [{ ...x, n: 1 }]; // theirs edited `x`
    expect(callReal(anc, mine, theirs)).toEqual([{ ...x, n: 1 }, x]); // P3 ≡ ref (pre-K-diff: [{…x,n:1},{…x,n:1}] — the edit landed twice)
    expect(keyedArrayRef(anc, mine, theirs)).toEqual([{ ...x, n: 1 }, x]); // the copy is an addition
  });

  it(`[PROVEN→impl] they AGREE on every duplicate-free triple of honest copy-on-write edits (${NUM_RUNS} runs)`, () => {
    let checked = 0;
    fc.assert(
      fc.property(
        fc
          .tuple(
            anyArrayArb,
            writerEditsArb(honestKinds),
            writerEditsArb(honestKinds),
          )
          .map(([base, e1, e2]) => ({
            base,
            mine: applyEdits(base, e1),
            theirs: applyEdits(base, e2),
          })),
        ({ base, mine, theirs }) => {
          fc.pre(!hasDupIds(base, mine, theirs));
          checked++;
          expect(
            structEq(
              callReal(base, mine, theirs),
              keyedArrayRef(base, mine, theirs),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(checked).toBeGreaterThan(NUM_RUNS / 3);
  });

  it('[PIN K5.1] a structurally equal occurrence pairs with its ancestor occurrence: the §3 counter-case folds identically for the author (shared refs) and a peer (clones)', () => {
    const p = { id: 'a', t: 'P' };
    const q = { id: 'a', t: 'Q' };
    const anc = [p, q];
    const mine = [{ ...q, t: 'Q2' }, p]; // `p` the same object, `q` edited into a fresh `q'`
    const theirs = [{ ...p, t: 'P3' }, q]; // theirs edited `p`
    const expected = [
      { id: 'a', t: 'Q2' },
      { id: 'a', t: 'P3' },
    ]; // each edit on its own occurrence
    expect(keyedArrayRef(anc, mine, theirs)).toEqual(expected);
    expect(keyedArrayRef(wire(anc), wire(mine), wire(theirs))).toEqual(
      expected,
    );
  });

  it('[PIN K5.2] remaining occurrences pair IN ORDER at equal counts (the immutable-update convention)', () => {
    const anc = [
      { id: 'a', t: '1' },
      { id: 'a', t: '2' },
    ];
    const mine = [
      { id: 'a', t: '1m' },
      { id: 'a', t: '2m' },
    ];
    const theirs = [{ id: 'a', t: '1', n: 5 }, anc[1]];
    expect(keyedArrayRef(anc, mine, theirs)).toEqual([
      { id: 'a', t: '1m', n: 5 },
      { id: 'a', t: '2m' },
    ]);
  });

  it('[PIN K5.2–3] unequal counts: leftovers pair in order up to the smaller count (`9` is the edit of `1`), the ancestor surplus (`2`) is removed', () => {
    const anc = [
      { id: 'a', t: '1' },
      { id: 'a', t: '2' },
    ];
    const mine = [{ id: 'a', t: '9' }]; // nothing equal ⇒ `9` pairs with `1` (in order); `2` removed
    expect(keyedArrayRef(anc, mine, anc)).toEqual([{ id: 'a', t: '9' }]);
    // theirs edited the occurrence mine removed (`2`) ⇒ edit beats removal, appended (theirs order)
    const theirs = [anc[0], { id: 'a', t: '2e' }];
    expect(keyedArrayRef(anc, mine, theirs)).toEqual([
      { id: 'a', t: '9' },
      { id: 'a', t: '2e' },
    ]);
  });

  it('[PIN K5 multiplicity] as VALUES: [x,x]→[x] is one removal; [x]→[x,x] one addition; [x,x,y]→[y,x,x] a reorder', () => {
    expect(keyedArrayRef([1, 1], [1], [1, 1])).toEqual([1]);
    expect(keyedArrayRef([1], [1, 1], [1])).toEqual([1, 1]);
    expect(keyedArrayRef([1, 1, 2], [2, 1, 1], [1, 1, 2])).toEqual([2, 1, 1]);
    // the survivor of [x,x]→[x] pairs with the FIRST ancestor occurrence: theirs' edit of the second is kept
    expect(
      keyedArrayRef(
        [{ id: 'a' }, { id: 'a' }],
        [{ id: 'a' }],
        [{ id: 'a' }, { id: 'a', t: 'e' }],
      ),
    ).toEqual([{ id: 'a' }, { id: 'a', t: 'e' }]);
  });

  it(`[PROVEN] replica independence: author form (mine shares references with prev) ≡ peer form (wire copies) (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(tripleArb(), ({ base, mine, theirs }) => {
        const author = keyedArrayRef(base, mine, wire(theirs));
        const peer = keyedArrayRef(wire(base), wire(mine), wire(theirs));
        expect(structEq(author, peer)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** A writer's occurrences of `id` as a value bag (canonical JSON, sorted). */
const bagOf = (a: readonly unknown[], id: string): string[] =>
  a
    .filter((x) => idKey(x) === id)
    .map((x) => JSON.stringify(canon(x)))
    .sort();
const canon = (v: unknown): unknown =>
  isList(v)
    ? v.map(canon)
    : isPlainRec(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;
/** `sup` contains every item of `sub` (multiset inclusion). */
const superBag = (sup: readonly string[], sub: readonly string[]): boolean =>
  sub.length === 0 || strictSubBag(sub, [...sup, '\u0000']);
/** `sub` is a strict sub-bag of `sup` (multiset inclusion, fewer items). */
const strictSubBag = (
  sub: readonly string[],
  sup: readonly string[],
): boolean => {
  if (sub.length >= sup.length) return false;
  const left = [...sup];
  return sub.every((x) => {
    const i = left.indexOf(x);
    if (i === -1) return false;
    left.splice(i, 1);
    return true;
  });
};

/**
 * Identity-level K4 clauses for EVERY id (charter §11). Multiplicity: no id more often than some
 * writer wrote it. Unique ids (≤ 1 occurrence in the base and every writer): touched (edited or
 * added) ⇒ survives; removed and untouched elsewhere ⇒ gone; untouched by all ⇒ survives.
 * Multiplicity is UNCONDITIONAL, over writers' arrays (a reduce accumulator is not a writer).
 * Duplicate ids, per OCCURRENCE COUNT: some writer raised the count AND no writer dropped a base
 * occurrence ⇒ at least the base count survives (a removal of an occurrence nobody edited sticks,
 * whatever equal-valued additions race it: `[PIN K5 count]`);
 * every writer that touched it only removed occurrences ⇒ below the base count. What the
 * count clause cannot say: WHICH occurrence survives (the K5 pins say that).
 */
/*
 * MULTIPLICITY LEMMA (hand argument, F9). Claim: one `keyedArrayRef(anc, mine, theirs)` step yields,
 * per identity x, at most max(m, t) items, where m, t are x's occurrence counts in mine and theirs,
 * for ANY ancestor. With the canonical reduce (acc₁ = the winner; acc_{i+1} = step(prev_s, acc_i, s))
 * induction gives count(out, x) ≤ max over writers' arrays of count(w, x).
 * Injectivity. Every output item of identity x is pushed for exactly one occurrence of x in mine (the
 * mine loop pushes at most one item per occurrence) or in theirs (the theirs loop likewise), and a
 * theirs occurrence pushes nothing when its ancestor partner or clause-4 partner is in mine. No item
 * comes from an ancestor occurrence alone. A merged item keeps identity x (all inputs carry x). Hence
 * ≤ m + t outright.
 * Tight bound. The unique path (all counts ≤ 1) gives ≤ 1, and 0 when m = t = 0. Duplicate path: per side
 * X, let E_X = the ancestor occurrences rule (1) pairs (unedited partners), R_X = the rest in POSITION
 * order, L_X = X's leftovers. Rule (2) pairs L_X with a PREFIX F_X of R_X. A leftover partner is an
 * EDIT: a leftover equal to an untaken ancestor occurrence would have been taken by rule (1). Let
 * add_X = max(0, |L_X| − |R_X|) and P_X = E_X ∪ F_X. Fact: add_X > 0 ⇒ P_X = every ancestor occurrence.
 * The output count is
 *   |P_M ∩ P_T| (merged)  +  |{α ∈ P_M∖P_T : mine edited α}|  +  |{α ∈ P_T∖P_M : theirs edited α}|
 *   + add_M + add_T − min(add_M, add_T)   (clause (4) folds min(add_M, add_T) pairs).
 * Unedited one-sided survivors are removals (gone), so only F-occurrences survive one-sidedly.
 * Case add_M > 0 and add_T > 0: P_M = P_T = all a occurrences ⇒ a + max(add_M, add_T) = max(m, t).
 * Case add_M > 0 = add_T: P_T ⊆ P_M = all ⇒ ≤ |P_M| + add_M = m (symmetric for add_T > 0 = add_M).
 * Case add_M = add_T = 0: suppose α ∈ F_M∖P_T and β ∈ F_T∖P_M. Then β ∉ P_M, so β ∈ R_M∖F_M, and
 * F_M is a prefix of R_M, so pos(α) < pos(β). Symmetrically α ∈ R_T∖F_T and β ∈ F_T, so
 * pos(β) < pos(α). Contradiction. So one of the two one-sided survivor sets is empty, say theirs; then
 * the count ≤ |P_M| = m (add_M = 0). Otherwise ≤ |P_T| = t. ∎
 * The prefix fact is load-bearing: the "all-or-nothing leftovers" neuter (old clause 2/3) breaks it and
 * the unconditional multiplicity clause goes red. The order clause is outside this lemma.
 */
/** Coverage counter: duplicate ids on which the multiplicity clause actually ran. */
let multiplicityCheckedDup = 0;

function identityViolation(
  sc: Scenario,
  r: Run,
  out: readonly unknown[],
): string | null {
  const ws = r.ordered.map((k) => r.arrays[k]);
  const all = [sc.base, ...ws];
  const ids = new Set([...all.flat(), ...out].map(idKey));
  const unique = [...ids].filter((id) => all.every((a) => count(a, id) <= 1));
  const at = (a: readonly unknown[], id: string) =>
    a.find((x) => idKey(x) === id);
  for (const id of ids) {
    if (!unique.includes(id)) multiplicityCheckedDup++;
    const max = Math.max(...r.arrays.map((a) => count(a, id)));
    if (count(out, id) > max)
      return `${id}: ${count(out, id)} occurrences, no writer wrote more than ${max}`;
  }
  for (const id of ids) {
    if (unique.includes(id)) continue;
    const b = count(sc.base, id);
    const baseBag = bagOf(sc.base, id);
    const touching = ws.filter(
      (w) => JSON.stringify(bagOf(w, id)) !== JSON.stringify(baseBag),
    );
    // raised ⇒ ≥ base count WHEN no writer dropped a base occurrence (every writer's bag contains the
    // base bag): the ruled condition; `[PIN K5 count]` is the case without it
    const keepsBase = ws.every((w) => superBag(bagOf(w, id), baseBag));
    if (ws.some((w) => count(w, id) > b) && keepsBase && count(out, id) < b)
      return `${id}: a writer raised the count above ${b}, none dropped one, but only ${count(out, id)} survive`;
    if (
      touching.length &&
      touching.every((w) => strictSubBag(bagOf(w, id), baseBag)) &&
      count(out, id) >= b
    )
      return `${id}: every touching writer only removed, yet ${count(out, id)} ≥ ${b} survive`;
  }
  for (const id of unique) {
    const b = at(sc.base, id);
    const removed = b !== undefined && ws.some((w) => at(w, id) === undefined);
    const touched = ws.some((w) => {
      const v = at(w, id);
      return v !== undefined && (b === undefined || !structEq(v, b));
    });
    const survives = count(out, id) > 0;
    if (touched && !survives)
      return `${id} kept/edited/added by a writer but gone`;
    if (!touched && removed && survives)
      return `${id} removed and untouched elsewhere but present`;
    if (!touched && !removed && b !== undefined && !survives)
      return `${id} untouched by all but gone`;
  }
  // order: the winner's unique ids that NO writer removed come first, in the winner's order. (An id
  // the winner kept, an earlier-reduced sibling removed and a later one edited survives APPENDED:
  // `[PIN K4 order]`, charter §11.)
  if (ws.length) {
    const win = ws[0]
      .map(idKey)
      .filter(
        (id) =>
          unique.includes(id) &&
          count(out, id) > 0 &&
          ws.every((w) => count(w, id) > 0),
      );
    const head = out
      .slice(0, ws[0].length)
      .map(idKey)
      .filter((id) => win.includes(id));
    if (JSON.stringify(head) !== JSON.stringify(win))
      return `order: winner ${win} vs head ${head}`;
  }
  return null;
}

describe("K5 / K4 — keyedArrayRef as the policy in the REAL register; what today's keyedArray loses on a wire", () => {
  it(`[PROVEN→impl] identity-level theorem over unit scenarios, ALL ids: no id more often than some writer wrote it; unique ids — touched survive, removed-and-untouched gone, winner order first; duplicate ids by occurrence COUNT only (raised with no base occurrence dropped ⇒ ≥ base count, only-removed ⇒ < base count; the count cannot say WHICH occurrence); replicas equal; fold ≡ reduce (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(scenarioArb(recordArrayArb), (sc) => {
        const r = run(sc, 'unit', keyedPolicy());
        const out = expectConverged(r);
        expect(structEq(out, expectedReduce(sc, r, keyedArrayRef))).toBe(true);
        expect(identityViolation(sc, r, out)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
    expect(multiplicityCheckedDup).toBeGreaterThan(0); // the duplicate clause is not vacuous
  });

  it('[PIN K5.4] the unpaired additions of one identity on both sides pair with each other: both writers duplicating `x` fold to `[x, x]`; two writers making the same slot edit `2→0` on `[2,0,1,2]` fold to length 4', () => {
    const x = { id: 'a', t: 'A' };
    const sc: Scenario = {
      base: [x],
      writers: [[], []],
      rank: [0, 1],
      orderSeed: 11,
    };
    const r = runArrays(sc, (own) => [own[0], own[0]], keyedPolicy()); // both duplicate `x`
    expect(expectConverged(r)).toEqual([x, x]); // each writer wrote `a` twice
    const sc2: Scenario = {
      base: [2, 0, 1, 2],
      writers: [[], []],
      rank: [0, 1],
      orderSeed: 12,
    };
    const r2 = runArrays(sc2, (own) => [0, ...own.slice(1)], keyedPolicy());
    const out2 = expectConverged(r2);
    expect(out2).toHaveLength(4);
    expect(out2).toEqual([0, 0, 1, 2]);
  });

  it("[PIN K5.4 bodies] clause (4) pairs additions EQUAL-FIRST, then in order, and COALESCES each pair to mine's body: astra F4 P,Q vs R,S,Q ⇒ [P, Q, S]; sides swapped ⇒ [R, S, Q]; reordered equal additions ⇒ mine's order, no copy", () => {
    const x = (v: string) => ({ id: 'x', v });
    const [P, Q, R, S] = [x('P'), x('Q'), x('R'), x('S')];
    // A (mine, winner) [P, Q] vs B (theirs) [R, S, Q] over base []: Q↔Q by value, then P↔R in order
    // (R discarded: coalesced into mine's P), S is theirs' surplus addition
    expect(keyedArrayRef([], [P, Q], [R, S, Q])).toEqual([P, Q, S]);
    expect(keyedArrayRef([], [R, S, Q], [P, Q])).toEqual([R, S, Q]);
    expect(keyedArrayRef([], [Q, P], [P, Q])).toEqual([Q, P]);
    // in the register, both orders of the total order
    for (const [rank, expected] of [
      [
        [1, 0],
        [P, Q, S],
      ],
      [
        [0, 1],
        [R, S, Q],
      ],
    ] as const) {
      const sc: Scenario = {
        base: [],
        writers: [[], []],
        rank: [...rank],
        orderSeed: 43,
      };
      const r = runArrays(
        sc,
        (_own, k) => (k === 0 ? [P, Q] : [R, S, Q]),
        keyedPolicy(),
      );
      expect(expectConverged(r)).toEqual(expected);
    }
  });

  it('[PIN K5 count] a removal of an occurrence nobody edited sticks, whatever equal-valued additions race it: base [x,x], A writes [x,x,x], B writes [] ⇒ [x] (the count clause holds WHEN no writer dropped a base occurrence)', () => {
    const x = { id: 'a', t: 'A' };
    const sc: Scenario = {
      base: [x, x],
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 23,
    };
    const r = runArrays(
      sc,
      (own, k) => (k === 0 ? [own[0], own[1], own[0]] : []),
      keyedPolicy(),
    );
    expect(expectConverged(r)).toEqual([x]); // both base occurrences removed-and-untouched, A's addition kept
  });

  it('[PIN K5 multiplicity-2] one side makes an edit, the other the SAME edit plus a new occurrence: leftovers pair in order up to the smaller count, so no edit loses its ancestor and the identity appears twice, as the loser wrote it', () => {
    const b = { id: 'b', t: 'B', n: 2 };
    const sc: Scenario = {
      base: [b],
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 29,
    };
    const fresh = { id: 'b', t: 'w0', n: 1 };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [{ ...(own[0] as Rec), n: 0 }] // winner: edits b
          : [fresh, { ...(own[0] as Rec), n: 0 }], // loser: a new `b` first, then the SAME edit
      keyedPolicy(),
    );
    const out = expectConverged(r);
    expect(out).toHaveLength(2);
    // the stated blind spot: nothing equals the ancestor, so the loser's leftovers pair IN ORDER and
    // `fresh` (first) is read as the edit of `b`, merging field-wise with the winner's edit
    expect(out).toEqual([
      { id: 'b', t: 'w0', n: 0 },
      { id: 'b', t: 'B', n: 0 },
    ]);
    // the loser writing the edit FIRST pairs it with the ancestor: [b′, bnew] exactly
    const r2 = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [{ ...(own[0] as Rec), n: 0 }]
          : [{ ...(own[0] as Rec), n: 0 }, fresh],
      keyedPolicy(),
    );
    expect(expectConverged(r2)).toEqual([{ id: 'b', t: 'B', n: 0 }, fresh]);
  });

  it('[WAS K5-wire] pre-K-diff keyedArray over a JSON wire DROPPED a concurrent NESTED-ARRAY edit the winner never touched (merge3 decided "unchanged" by reference; peers hold copies); since K7 the production policy keeps it', () => {
    const base = [
      { id: 'a', t: 'A', tags: [1] },
      { id: 'b', t: 'B' },
    ];
    const sc: Scenario = {
      base,
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 13,
    };
    const write = (own: unknown[], k: number): unknown[] =>
      k === 0
        ? [own[1], own[0]] // the winner reorders, keeping references
        : [{ ...(own[0] as Rec), tags: [1, 2] }, own[1]]; // the loser edits a.tags
    const today = expectConverged(
      runArrays(sc, write, [{ path: ['todos'], merge: keyedArray(idOf) }]),
    );
    expect(today).toEqual([
      { id: 'b', t: 'B' },
      { id: 'a', t: 'A', tags: [1, 2] },
    ]); // K7: kept (pre-K-diff: tags [1] — the edit was lost everywhere)
    const ref = expectConverged(runArrays(sc, write, keyedPolicy()));
    expect(ref).toEqual([
      { id: 'b', t: 'B' },
      { id: 'a', t: 'A', tags: [1, 2] },
    ]); // value semantics keep it
  });
});

describe('K4 — the N-sibling order clause', () => {
  it("[PIN K4 order] winner's order for ids no sibling removed; an id the winner kept, an earlier-reduced sibling removed and a later one edited is re-admitted APPENDED", () => {
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    // total order: W0 (winner) > W1 > W2; W1 removes `a`, W2 edits `a`
    const sc: Scenario = {
      base,
      writers: [[], [], []],
      rank: [2, 1, 0],
      orderSeed: 17,
    };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [own[0], { ...(own[1] as Rec), t: 'B0' }]
          : k === 1
            ? [own[1]]
            : [{ ...(own[0] as Rec), t: 'A2' }, own[1]],
      keyedPolicy(),
    );
    expect(expectConverged(r)).toEqual([
      { id: 'b', t: 'B0' },
      { id: 'a', t: 'A2' },
    ]);
  });
});

describe('K6 — unit batches are valid traffic (grammar unchanged; the materialization change is fenced by the proto bump)', () => {
  it(`[PROVEN→impl] every unit-mode batch is valid traffic: validateEnvelope accepts it (the protocol VALUE is P2a's bump, F1; not pinned here) (${NUM_RUNS} runs; the premise and array-graft specs are run beside this one at the gate)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        const ops = unitDiff(prev, next).map((op) => ({
          ...op,
          cites: [],
          epoch: 0,
        }));
        expect(validateEnvelope(envelope('X', 2, ops))).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('K7 — merges are functions of values', () => {
  // a whole-RECORD write (as a fork commit or any `set` of a record value emits): one register at
  // ['doc'] holding both siblings, each merged against its own `prev`
  const runDoc = (merge: MergeFn): unknown => {
    const base = { t: 'A', tags: [1] };
    const policies = [{ path: ['doc'], merge }];
    const baseEnv = envelope('BASE', 1, [
      { kind: 'set', path: ['doc'], next: base, cites: [], epoch: 0 },
    ]);
    const W = replica('W', policies);
    const L = replica('L', policies);
    const O = replica('O', policies);
    for (const r of [W, L, O]) r.receive(baseEnv);
    const own = (r: typeof W) => (r.folded() as unknown as { doc: Rec }).doc;
    const ow = own(W);
    const ol = own(L);
    const eW = W.emit(
      [{ kind: 'set', path: ['doc'], prev: ow, next: { ...ow, t: 'A2' } }],
      20,
    ); // winner: field `t`
    const eL = L.emit(
      [{ kind: 'set', path: ['doc'], prev: ol, next: { ...ol, tags: [1, 2] } }],
      10,
    ); // loser: nested array
    W.receive(eL);
    L.receive(eW);
    O.receive(eL);
    O.receive(eW);
    const states = [W, L, O].map((r) => r.state());
    for (const st of states) expect(structEq(st, states[0])).toBe(true);
    return (states[0] as unknown as { doc: unknown }).doc;
  };

  it('[WAS mergeThree-wire] pre-K-diff `mergeThree` over a JSON wire: the winner edits `t`, the loser edits the nested array `tags` of the same record ⇒ the `tags` edit was lost on EVERY replica; since K7 `mergeThree` (= `merge3` by value) keeps both, like `merge3Ref`', () => {
    expect(runDoc(mergeThree)).toEqual({ t: 'A2', tags: [1, 2] }); // K7 (pre-K-diff: tags [1], converged on the loss)
    expect(runDoc(asMerge(merge3Ref))).toEqual({ t: 'A2', tags: [1, 2] }); // K7
  });

  it("[PIN K7 array conflict] the same two edits under `mergeThree` at the ARRAY path with unit emission: both sides changed the array, an array CONFLICT is atomic, so today and `merge3Ref` alike keep the winner's array whole", () => {
    const base = [{ id: 'a', t: 'A', tags: [1] }];
    const sc: Scenario = {
      base,
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 19,
    };
    const write = (own: unknown[], k: number): unknown[] =>
      k === 0
        ? [{ ...(own[0] as Rec), t: 'A2' }]
        : [{ ...(own[0] as Rec), tags: [1, 2] }];
    const winner = [{ id: 'a', t: 'A2', tags: [1] }];
    expect(
      expectConverged(
        runArrays(sc, write, [{ path: ['todos'], merge: mergeThree }]),
      ),
    ).toEqual(winner);
    expect(
      expectConverged(
        runArrays(sc, write, [{ path: ['todos'], merge: asMerge(merge3Ref) }]),
      ),
    ).toEqual(winner);
  });

  it(`[PROVEN] (F3) three-way branches at ARRAY paths with arbitrary ancestors: merge3Ref follows the unchanged-side rules by value; since K7 production \`mergeThree\` on wire copies follows the same rules (pre-K-diff: always mine) (${NUM_RUNS} runs)`, () => {
    let mineUnchanged = 0;
    fc.assert(
      fc.property(
        anyArrayArb,
        anyArrayArb,
        anyArrayArb,
        fc.constantFrom('mine=anc', 'theirs=anc', 'mine=theirs', 'free'),
        (a0, m0, t0, shape) => {
          const anc = a0;
          const mine = shape === 'mine=anc' ? wire(a0) : m0;
          const theirs =
            shape === 'theirs=anc'
              ? wire(a0)
              : shape === 'mine=theirs'
                ? wire(mine)
                : t0;
          const ref = merge3Ref(anc, mine, theirs);
          const today = mergeThree(wire(anc), wire(mine), wire(theirs), {
            path: ['todos'],
          });
          // merge3Ref by branch (arrays are atomic: no element-wise step exists for them)
          const expected =
            structEq(mine, theirs) || structEq(mine, anc) ? theirs : mine;
          expect(structEq(ref, expected)).toBe(true);
          expect(structEq(today, ref)).toBe(true); // K7: production ≡ reference (pre-K-diff: ≡ mine)
          if (structEq(mine, anc) && !structEq(theirs, anc)) {
            mineUnchanged++;
            expect(structEq(ref, theirs)).toBe(true);
            expect(structEq(today, theirs)).toBe(true); // the K7 change, at array paths too (pre-K-diff: false)
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(mineUnchanged).toBeGreaterThan(0);
  });

  it('[PIN K7 unchanged side] astra F3: merge3Ref([1],[1],[2]) = [2]; production mergeThree on wire copies = [2] since K7 (pre-K-diff [1]); and in the register — base [0], A [1], B observes A and writes [2], C (base only) writes [1], C > B > A ⇒ [2] under K7 for production and reference alike (pre-K-diff [1])', () => {
    expect(merge3Ref([1], [1], [2])).toEqual([2]);
    expect(
      mergeThree(wire([1]), wire([1]), wire([2]), { path: ['todos'] }),
    ).toEqual([2]); // K7 (pre-K-diff: [1])
    const sc: Scenario = {
      base: [0],
      writers: [[], [], []],
      rank: [0, 1, 2],
      orderSeed: 41,
    };
    const write = (_own: unknown[], k: number): unknown[] =>
      k === 0 ? [1] : k === 1 ? [2] : [1];
    const dag = [[], [0], []];
    const today = runArrays(
      sc,
      write,
      [{ path: ['todos'], merge: mergeThree }],
      'unit',
      dag,
    );
    expect(expectConverged(today)).toEqual([2]); // K7 (pre-K-diff: [1])
    const k7 = runArrays(
      sc,
      write,
      [{ path: ['todos'], merge: asMerge(merge3Ref) }],
      'unit',
      dag,
    );
    expect(expectConverged(k7)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------------------------
// F2 — causal DAGs: siblings with DIFFERENT `prev`s (one observed a write the other did not)
// ---------------------------------------------------------------------------------------------

const dagArb = (
  baseArb: fc.Arbitrary<unknown[]> = anyArrayArb,
  kinds?: readonly EditKind[],
) =>
  scenarioArb(baseArb, kinds).chain((sc) =>
    fc
      .tuple(
        ...sc.writers.map((_, k) =>
          fc.subarray(
            Array.from({ length: k }, (_, j) => j),
            { minLength: 0 },
          ),
        ),
      )
      .map((observes) => ({ sc, observes: observes as number[][] })),
  );

const lwwRef = (_a: unknown, mine: unknown): unknown => mine;

describe('F2 — causal DAGs: convergence + the exact reduce over live siblings with their OWN prev', () => {
  it(`[PROVEN→impl] positionalRef, in-place edits only (the guards accept, so the ancestor matters): converged ≡ the reduce with each sibling's OWN prev, and in some runs that DIFFERS from the reduce against the base (${NUM_RUNS} runs)`, () => {
    let differs = 0;
    const inPlace: EditKind[] = ['field', 'nestedRec', 'nestedArr', 'delKey'];
    fc.assert(
      fc.property(dagArb(anyArrayArb, inPlace), ({ sc, observes }) => {
        const r = runArrays(
          sc,
          (own, k) => applyEdits(own, sc.writers[k]),
          positionalPolicy(),
          'unit',
          observes,
        );
        const out = expectConverged(r);
        const ownPrev = expectedReduce(sc, r, positionalRef);
        expect(structEq(out, ownPrev)).toBe(true);
        const againstBase = { ...r, prevs: r.prevs.map(() => sc.base) };
        if (!structEq(ownPrev, expectedReduce(sc, againstBase, positionalRef)))
          differs++;
      }),
      { numRuns: NUM_RUNS },
    );
    expect(differs).toBeGreaterThan(0); // the own-prev reading is load-bearing in this generator
  });

  for (const [name, merge, policies] of [
    ['explicit lww', lwwRef, [{ path: ['todos'], merge: lww }]],
    ['no policy (positional since P2a)', positionalRef, undefined],
    ['positionalRef', positionalRef, positionalPolicy()],
    ['keyedArrayRef', keyedArrayRef, keyedPolicy()],
  ] as const) {
    it(`[PROVEN→impl] ${name}: all replicas converge AND converged ≡ winner-first reduce over the live siblings, each against its own prev (${NUM_RUNS} runs)`, () => {
      let gaps = 0;
      fc.assert(
        fc.property(
          dagArb(name === 'keyedArrayRef' ? recordArrayArb : anyArrayArb),
          ({ sc, observes }) => {
            const r = runArrays(
              sc,
              (own, k) => applyEdits(own, sc.writers[k]),
              policies,
              'unit',
              observes,
            );
            const out = expectConverged(r);
            if (r.ordered.some((k) => !structEq(r.prevs[k], sc.base))) gaps++;
            expect(structEq(out, expectedReduce(sc, r, merge))).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
      expect(gaps).toBeGreaterThan(0); // live siblings with a non-base prev occur
    });
  }

  it('[PIN causal] preservation across a causal gap is not promised: keyed — base [], A [x], B observes A and writes [x, y], C (base only) writes [z]; C > B > A ⇒ [z, y]', () => {
    const sc: Scenario = {
      base: [],
      writers: [[], [], []],
      rank: [0, 1, 2],
      orderSeed: 31,
    };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0
          ? [{ id: 'x' }]
          : k === 1
            ? [...own, { id: 'y' }]
            : [{ id: 'z' }],
      keyedPolicy(),
      'unit',
      [[], [0], []],
    );
    expect(r.ordered).toEqual([2, 1]); // A is superseded by B
    expect(expectConverged(r)).toEqual([{ id: 'z' }, { id: 'y' }]); // C's ignorance of x reads as a removal
  });

  it('[PIN causal] preservation across a causal gap is not promised: positional — base [10,20,30], A [11,20,30], B observes A and writes [11,21,30], C (base only) writes [10,20,31]; C > B > A ⇒ [10,21,31]', () => {
    const sc: Scenario = {
      base: [10, 20, 30],
      writers: [[], [], []],
      rank: [0, 1, 2],
      orderSeed: 37,
    };
    const r = runArrays(
      sc,
      (own, k) =>
        k === 0 ? [11, 20, 30] : k === 1 ? [own[0], 21, own[2]] : [10, 20, 31],
      positionalPolicy(),
      'unit',
      [[], [0], []],
    );
    expect(r.ordered).toEqual([2, 1]);
    expect(expectConverged(r)).toEqual([10, 21, 31]); // A's 11 is lost: against B's prev, C "reverted" it
  });
});

// ---------------------------------------------------------------------------------------------
// F5 — K4's precondition: no contributing descendant registers under the array register
// ---------------------------------------------------------------------------------------------

/**
 * The healing REFERENCE (§14.3): after a unit write at `['todos']`, the contributing descendants are
 * exactly the descendant paths written by envelopes its emitter had NOT observed (sorted JSON paths).
 */
function expectedSurvivors(unobserved: readonly OpEnvelope[]): string[] {
  const paths = new Set<string>();
  for (const e of unobserved)
    for (const op of e.ops)
      if (op.kind !== 'clear' && op.path.length > 1)
        paths.add(JSON.stringify(op.path));
  return [...paths].sort();
}

/** Descendant registers (deeper than `['todos']`) that still hold a live `set`/`delete` sibling. */
const contributingDescendants = (r: ReturnType<typeof replica>) =>
  r
    .liveUnder(['todos'])
    .filter(
      (reg) =>
        reg.path.length > 1 && reg.siblings.some((x) => x.kind !== 'clear'),
    );

describe('F5 — descendant registers under a unit: characterized, then healed by one unit write', () => {
  const baseOf = (base: unknown[]) =>
    envelope('BASE', 1, [
      { kind: 'set', path: ['todos'], next: base, cites: [], epoch: 0 },
    ]);
  const deliverAll = (rs: ReturnType<typeof replica>[], envs: OpEnvelope[]) => {
    for (const r of rs)
      for (const e of envs) if (e.origin !== r.origin) r.receive(e);
  };

  it('[PIN K4 descendants] a unit reorder + an OLD emitter\'s per-slot `set(["todos",0,"t"])`: the slot write grafts AFTER the unit fold ⇒ [{b,A2},{a,A}]; one further unit write clears the descendant and the next concurrent round folds by the K4 bound', () => {
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    const A = replica('A', positionalPolicy());
    const B = replica('B', positionalPolicy());
    const O = replica('O', positionalPolicy());
    const all = [A, B, O];
    for (const r of all) r.receive(baseOf(base));
    const ownA = A.folded().todos;
    const eA = A.emit(
      unitDiff({ todos: ownA }, { todos: [ownA[1], ownA[0]] }),
      10,
    );
    const eB = B.emit(
      [{ kind: 'set', path: ['todos', 0, 't'], prev: 'A', next: 'A2' }],
      20,
    );
    deliverAll(all, [eA, eB]);
    for (const r of all)
      expect(r.state().todos).toEqual([
        { id: 'b', t: 'A2' },
        { id: 'a', t: 'A' },
      ]);
    expect(contributingDescendants(O).map((x) => x.path)).toEqual([
      ['todos', 0, 't'],
    ]);
    // heal: ONE unit write at the path (here by the observer)
    const cur = O.folded().todos;
    const eO = O.emit(
      unitDiff({ todos: cur }, { todos: [...cur, { id: 'c', t: 'C' }] }),
      30,
    );
    deliverAll(all, [eO]);
    for (const r of all) expect(contributingDescendants(r)).toEqual([]);
    // next concurrent round: A reorders, B edits slot 0 — whole-array units, no descendant ⇒ K4′ fold
    const healed = O.state().todos;
    const pa = A.folded().todos;
    const pb = B.folded().todos;
    const e2A = A.emit(
      unitDiff({ todos: pa }, { todos: [pa[1], pa[0], pa[2]] }),
      40,
    );
    const e2B = B.emit(
      unitDiff(
        { todos: pb },
        { todos: [{ ...(pb[0] as Rec), t: 'X' }, pb[1], pb[2]] },
      ),
      50,
    );
    deliverAll(all, [e2A, e2B]);
    const winnerB = [{ ...(healed[0] as Rec), t: 'X' }, healed[1], healed[2]];
    for (const r of all)
      expect(r.state().todos).toEqual(
        positionalRef(healed, winnerB, [healed[1], healed[0], healed[2]]),
      );
    for (const r of all) expect(r.state().todos).toEqual(winnerB); // the reorder is a move ⇒ lww, the winner whole
  });

  const healCase = (observes: boolean) => {
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    const D = replica('D', positionalPolicy());
    const H = replica('H', positionalPolicy());
    const O = replica('O', positionalPolicy());
    const all = [D, H, O];
    for (const r of all) r.receive(baseOf(base));
    const eD = D.emit(
      [{ kind: 'set', path: ['todos', 0, 't'], prev: 'A', next: 'A2' }],
      20,
    );
    if (observes) H.receive(eD);
    const own = H.folded().todos;
    const next = [
      { id: 'b', t: 'B' },
      { id: 'a', t: 'A' },
    ];
    const eH = H.emit(unitDiff({ todos: own }, { todos: next }), 30);
    deliverAll(all, [eD, eH]);
    const states = all.map((r) => r.state().todos);
    for (const st of states) expect(st).toEqual(states[0]);
    return {
      out: states[0],
      live: all.map((r) => contributingDescendants(r).map((x) => x.path)),
    };
  };

  it('[PIN K4 heal observed] H has OBSERVED D\'s `set(["todos",0,"t"],"A2")` before its unit write ⇒ its stamp clears D: H\'s array whole, no contributing descendant anywhere', () => {
    const { out, live } = healCase(true);
    expect(out).toEqual([
      { id: 'b', t: 'B' },
      { id: 'a', t: 'A' },
    ]);
    for (const l of live) expect(l).toEqual([]);
  });

  it('[PIN K4 heal unobserved] astra N2: H never observed D (D HLC 20, H HLC 30, epoch 0) ⇒ D stays live and grafts after the unit fold ⇒ [{b,A2},{a,A}] on every replica', () => {
    const { out, live } = healCase(false);
    expect(out).toEqual([
      { id: 'b', t: 'A2' },
      { id: 'a', t: 'A' },
    ]);
    for (const l of live) expect(l).toEqual([['todos', 0, 't']]);
  });

  it(`[PROVEN→impl] healing needs observation (§14.3): mixed unit / per-slot (old) emitters; the healer has OBSERVED a random subset; ONE unit write ⇒ exactly the UNOBSERVED descendants stay contributing on every replica; when none, the next concurrent unit round converges to the exact reduce (${NUM_RUNS} runs)`, () => {
    let hadDescendant = 0;
    let survived = 0;
    fc.assert(
      fc.property(
        scenarioArb().chain((sc) =>
          fc.record({
            sc: fc.constant(sc),
            old: fc.array(fc.boolean(), {
              minLength: sc.writers.length,
              maxLength: sc.writers.length,
            }),
            round2: fc.array(writerEditsArb(), {
              minLength: sc.writers.length,
              maxLength: sc.writers.length,
            }),
            seen: fc.array(fc.boolean(), {
              minLength: sc.writers.length,
              maxLength: sc.writers.length,
            }),
          }),
        ),
        ({ sc, old, round2, seen }) => {
          const ws = sc.writers.map((_, k) =>
            replica(`W${k}`, positionalPolicy()),
          );
          const O = replica('O', positionalPolicy());
          const all = [...ws, O];
          for (const r of all) r.receive(baseOf(sc.base));
          const envs1: OpEnvelope[] = [];
          sc.writers.forEach((edits, k) => {
            const own = ws[k].folded().todos;
            const mine = applyEdits(own, edits);
            const ops = old[k]
              ? diffOps({ todos: own }, { todos: mine })
              : unitDiff({ todos: own }, { todos: mine });
            if (ops.length) envs1.push(ws[k].emit(ops, 10 * (sc.rank[k] + 1)));
          });
          // the healer O observes only the `seen` writers before it writes; everyone gets everything after
          const observed = envs1.filter((e) => seen[Number(e.origin.slice(1))]);
          deliverAll([O], observed);
          if (contributingDescendants(O).length) hadDescendant++;
          const cur = O.folded().todos;
          const eO = O.emit(
            unitDiff({ todos: cur }, { todos: [...cur, 9] }),
            100,
          );
          deliverAll(ws, [eO]);
          deliverAll(
            all,
            envs1.filter((e) => !observed.includes(e)),
          );
          deliverAll(ws, observed);
          const expected0 = expectedSurvivors(
            envs1.filter((e) => !observed.includes(e)),
          );
          if (expected0.length) survived++;
          for (const r of all)
            expect(
              contributingDescendants(r)
                .map((x) => JSON.stringify(x.path))
                .sort(),
            ).toEqual(expected0);
          if (expected0.length) return; // the K4 bound needs no contributing descendant (§12 F5)
          const healed = O.state().todos;
          // round 2: every writer edits from the healed array (a shared ancestor), unit emission
          const arrays: unknown[][] = [];
          const envs2: OpEnvelope[] = [];
          round2.forEach((edits, k) => {
            const own = ws[k].folded().todos;
            const mine = applyEdits(own, edits);
            arrays.push(mine);
            const ops = unitDiff({ todos: own }, { todos: mine });
            if (ops.length)
              envs2.push(ws[k].emit(ops, 200 + 10 * (sc.rank[k] + 1)));
          });
          deliverAll(all, envs2);
          const ordered = envs2
            .map((e) => Number(e.origin.slice(1)))
            .sort((x, y) => sc.rank[y] - sc.rank[x]);
          let expected: unknown = healed;
          if (ordered.length) {
            expected = arrays[ordered[0]];
            for (const k of ordered.slice(1))
              expected = positionalRef(healed, expected, arrays[k]);
          }
          const states = all.map((r) => r.state());
          for (const st of states) expect(structEq(st, states[0])).toBe(true);
          expect(structEq(states[0].todos, expected)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(hadDescendant).toBeGreaterThan(0); // descendants were actually present before healing
    expect(survived).toBeGreaterThan(0); // and some were unobserved by the healer, so they survived
  });
});

// ---------------------------------------------------------------------------------------------
// F6 — K4′ guard acceptance (what the guard accepts, not "no moves"); F7 — explicit lww
// ---------------------------------------------------------------------------------------------

describe('F6/F7 — guard-acceptance pins and explicit lww', () => {
  const fold = (
    base: unknown[],
    arrays: unknown[][],
    rank: number[],
    policies = positionalPolicy(),
  ) =>
    expectConverged(
      runArrays(
        { base, writers: arrays.map(() => []), rank, orderSeed: 47 },
        (_own, k) => arrays[k],
        policies,
      ),
    );

  it("[PIN K4′ guard fp] [1,1,2]: A [0,1,2] > B [1,2,2] ⇒ [0,2,2] — B's changed slot equals ancestor slot 2, which did NOT change, so it is a copy, not a move: both distinct-slot edits survive; the pre-refinement guard gave [0,1,2] (one lost)", () => {
    expect(
      fold(
        [1, 1, 2],
        [
          [0, 1, 2],
          [1, 2, 2],
        ],
        [1, 0],
      ),
    ).toEqual([0, 2, 2]);
    expect(preRefinement([1, 1, 2], [0, 1, 2], [1, 2, 2])).toEqual([0, 1, 2]);
  });

  it('[PIN K4′ guard equal-swap] [1,1,2]: A [4,1,2] > B [1,1,3] (B swapped the equal 1s and edited slot 2) ⇒ [4,1,3] — an equal-valued swap is invisible and benign (indistinguishable states)', () => {
    expect(
      fold(
        [1, 1, 2],
        [
          [4, 1, 2],
          [1, 1, 3],
        ],
        [1, 0],
      ),
    ).toEqual([4, 1, 3]);
  });

  it('[PIN K4′ guard N≥3] [0,0]: [1,0] > [0,0,3] > [0,2] ⇒ [1,2] — a sibling failing a guard (length change) is skipped, `acc` kept, the rest still merge', () => {
    expect(
      fold(
        [0, 0],
        [
          [1, 0],
          [0, 0, 3],
          [0, 2],
        ],
        [2, 1, 0],
      ),
    ).toEqual([1, 2]);
  });

  it('[PIN F7 explicit lww] the real `lww` MergeFn as an EXPLICIT policy over units stays whole-value: [0,0], A [1,0] > B [0,2] ⇒ [1,0] (the contract P2a keeps when it splits "no policy" from `lww`); the positional default gives [1,2]', () => {
    expect(
      fold(
        [0, 0],
        [
          [1, 0],
          [0, 2],
        ],
        [1, 0],
        [{ path: ['todos'], merge: lww }],
      ),
    ).toEqual([1, 0]);
    expect(
      fold(
        [0, 0],
        [
          [1, 0],
          [0, 2],
        ],
        [1, 0],
      ),
    ).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------------------------
// F8 — selective undo through rebaseOps (the model P2b transcribes into storeHistory)
// ---------------------------------------------------------------------------------------------

describe('F8 — selective undo: an inverse unit set routed through rebaseOps with the register policy', () => {
  const policies = [{ path: ['todos'], merge: asMerge(undoRef) }];
  /**
   * Undo of a forward unit `set(prev=P, next=N)` after the document moved to `C`: the inverse
   * `set(prev=N, next=P)` is the PENDING batch over a remote delta `N → C`, so rebaseOps finds
   * `op.prev (N) ≠ current (C)` and resolves `merge(N, P, C)`.
   */
  const undo = (P: unknown[], N: unknown[], C: unknown[]): unknown => {
    const inverse: StoreOp = { kind: 'set', path: ['todos'], prev: N, next: P };
    const remote: StoreOp[] = [
      { kind: 'set', path: ['todos'], prev: N, next: C },
    ];
    return (rebaseOps({ todos: P }, [[inverse]], remote, policies).root as Root)
      .todos;
  };

  it(`[PROVEN] undo ≡ undoRef(N, P, C) for every forward edit N of P folded with a concurrent T into C (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        tripleArb(),
        fc.boolean(),
        ({ base: P, mine: N, theirs: T }, nWins) => {
          const C = (
            nWins ? positionalRef(P, N, T) : positionalRef(P, T, N)
          ) as unknown[];
          expect(structEq(undo(P, N, C), undoRef(N, P, C))).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("[PIN F8] base [5,6], A [1,6] folded with B [5,2] to [1,2]; undoing A ⇒ [5,2] (B's edit survives)", () => {
    expect(undo([5, 6], [1, 6], [1, 2])).toEqual([5, 2]);
  });

  it("[PIN F8 selective undo] astra's [0,0] / A [1,0] / B [0,2] ⇒ C [1,2]; undoing A ⇒ [0,2]: B's edit survives; the pre-refinement both-sides guard read my inverse [1,0]→[0,0] as a move (N[1] = 0) and gave [0,0]", () => {
    expect(undo([0, 0], [1, 0], [1, 2])).toEqual([0, 2]);
    expect(preRefinement([1, 0], [0, 0], [1, 2])).toEqual([0, 0]); // the reason for ruling B′
    // under the vanished form the copy is not a move on either side, so the register default agrees
    expect(positionalRef([1, 0], [0, 0], [1, 2])).toEqual([0, 2]);
  });

  it('[PIN F8 others moved] OTHERS reordered since my write ⇒ lww, my inverse whole: P [5,6], N [1,6], C [6,1] ⇒ [5,6] (OPEN-K-10: their restructure is lost)', () => {
    expect(undo([5, 6], [1, 6], [6, 1])).toEqual([5, 6]);
  });

  it('[PIN F8 one slot, two fields] I edited `t`, another writer then edited `n` of the same record: undoing my edit restores `t` and keeps their `n`', () => {
    const P = [{ id: 'a', t: 'A', n: 0 }];
    const N = [{ id: 'a', t: 'A2', n: 0 }];
    const C = [{ id: 'a', t: 'A2', n: 5 }];
    expect(undo(P, N, C)).toEqual([{ id: 'a', t: 'A', n: 5 }]);
  });

  /** Today's per-slot inverse: the index-mode forward diff P → N, inverted, applied to C. */
  const oldInverse = (P: unknown[], N: unknown[], C: unknown[]): unknown =>
    applyOps({ todos: C }, invertBatch(diffOps({ todos: P }, { todos: N })))
      .todos;

  it("[PIN F8 own-reorder attachment (accepted loss, OPEN-K-10)] P [a0,b0], my reorder N [b0,a0], another writer edits b: C [b1,a0] ⇒ [a1,b0] — b's edit moves onto a (identity-blind); the old per-slot inverse gives the same [a1,b0]", () => {
    const P = [
      { id: 'a', v: 0 },
      { id: 'b', v: 0 },
    ];
    const N = [P[1], P[0]];
    const C = [
      { id: 'b', v: 1 },
      { id: 'a', v: 0 },
    ];
    const attached = [
      { id: 'a', v: 1 },
      { id: 'b', v: 0 },
    ];
    expect(undo(P, N, C)).toEqual(attached);
    expect(oldInverse(P, N, C)).toEqual(attached); // old per-slot inverse: [a1,b0]
  });

  it("[PIN F8 false positive (recovered by the refinement)] P [5,6,7], N [1,6,7], C [1,7,7] ⇒ [5,7,7] = the old per-slot inverse (C copied 7 into slot 1; N's slot 2 did not change, so no move); the pre-refinement guard gave [5,6,7] (an accepted loss then)", () => {
    expect(undo([5, 6, 7], [1, 6, 7], [1, 7, 7])).toEqual([5, 7, 7]);
    expect(
      positionalWith({ movedMine: false })([1, 6, 7], [5, 6, 7], [1, 7, 7]),
    ).toEqual([5, 6, 7]); // pre-refinement
    expect(oldInverse([5, 6, 7], [1, 6, 7], [1, 7, 7])).toEqual([5, 7, 7]); // old: [5,7,7]
    // charter §14.4 fact (2), others really swapped (accepted loss, OPEN-K-10): B′ [5,6,7], old [5,7,6]
    expect(undo([5, 6, 7], [1, 6, 7], [1, 7, 6])).toEqual([5, 6, 7]);
    expect(oldInverse([5, 6, 7], [1, 6, 7], [1, 7, 6])).toEqual([5, 7, 6]);
  });

  it('[PIN F8 call shape] rebaseOps(C, [[inverse]], []) — the inverse as pending over NO remote delta — re-applies the inverse verbatim (naive undo)', () => {
    const inverse: StoreOp = {
      kind: 'set',
      path: ['todos'],
      prev: [1, 6],
      next: [5, 6],
    };
    expect(
      (rebaseOps({ todos: [1, 2] }, [[inverse]], [], policies).root as Root)
        .todos,
    ).toEqual([5, 6]); // B's 2 is reverted: the call must carry the N → C delta as `remote`
  });
});

// ---------------------------------------------------------------------------------------------
// N5 (§14.6) — K7 edit/revert and the equality domain
// ---------------------------------------------------------------------------------------------

describe('N5 — merges by value: edit/revert, and the equality domain', () => {
  it('[PIN K7 edit/revert] ancestor {arr:[0]}; mine edits arr to [1], then back to a FRESH [0]; theirs {arr:[2]} ⇒ merge3Ref {arr:[2]} (a side that ends where it started made no change); since K7 production `mergeThree` agrees (pre-K-diff: the reference-based merge kept the stale fresh [0])', () => {
    const anc = { arr: [0] };
    const edited = { arr: [1] };
    const mine = { ...edited, arr: [0] }; // copy-on-write: a fresh array, equal to the ancestor's
    expect(mine.arr).not.toBe(anc.arr);
    const theirs = { arr: [2] };
    expect(merge3Ref(anc, mine, theirs)).toEqual({ arr: [2] });
    expect(mergeThree(anc, mine, theirs, { path: ['doc'] })).toEqual({
      arr: [2],
    }); // K7 (pre-K-diff: { arr: [0] })
  });

  it('[PIN K7 equality domain] two `new Date(0)` are NOT structEq (reference only outside plain data); the same instance is; holes ≡ undefined; NaN ≡ NaN and +0 ≢ -0 (Object.is)', () => {
    const d = new Date(0);
    expect(structEq(new Date(0), new Date(0))).toBe(false);
    expect(structEq(d, d)).toBe(true);
    expect(structEq({ at: new Date(0) }, { at: new Date(0) })).toBe(false);
    expect(structEq(new Map(), new Map())).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(structEq([, 1], [undefined, 1])).toBe(true);
    expect(structEq(NaN, NaN)).toBe(true);
    expect(structEq(0, -0)).toBe(false);
    const fresh = new Date(0);
    const merged = merge3Ref({ at: d }, { at: fresh }, { at: d }) as Rec;
    expect(merged['at']).toBe(fresh); // a fresh Date is a change (mine changed, theirs did not)
  });
});

// ---------------------------------------------------------------------------------------------
// F9 residue — recursive presence; a one-sided added key
// ---------------------------------------------------------------------------------------------

describe('F9 residue — presence is recursive; a one-sided added key survives', () => {
  const two = (base: unknown[], a: unknown[], b: unknown[]) => {
    const sc: Scenario = {
      base,
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 53,
    };
    const r = runArrays(sc, (_own, k) => (k === 0 ? a : b), positionalPolicy());
    return { sc, r, out: expectConverged(r) };
  };

  it('[PIN K4 recursive presence] A edits sub.x, B edits sub.y of one record ⇒ both survive and every nested key nobody deleted is present; a fold that DROPS the nested key is reported', () => {
    const base = [{ id: 'a', sub: { x: 0, y: 0 } }];
    const { sc, r, out } = two(
      base,
      [{ id: 'a', sub: { x: 1, y: 0 } }],
      [{ id: 'a', sub: { x: 0, y: 1 } }],
    );
    expect(out).toEqual([{ id: 'a', sub: { x: 1, y: 1 } }]);
    expect(requiredKeysMissing(sc, r, out)).toBeNull();
    // the checker sees a nested loss the top-level check could not (`sub` is present)
    expect(requiredKeysMissing(sc, r, [{ id: 'a', sub: { x: 1 } }])).toBe(
      'slot 0.sub lost required key y',
    );
  });

  it('[PIN K4 added key] A edits `t`, B ADDS a key `z` to the same record ⇒ the added key survives beside the edit', () => {
    const base = [{ id: 'a', t: 'A' }];
    const { out } = two(
      base,
      [{ id: 'a', t: 'A2' }],
      [{ id: 'a', t: 'A', z: 1 }],
    );
    expect(out).toEqual([{ id: 'a', t: 'A2', z: 1 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// N4 (§14.5) — coalescing: a run extends only across CONTINUOUS local writes
// ---------------------------------------------------------------------------------------------

type HistEntry = {
  readonly prev: unknown[];
  readonly next: unknown[];
  /** how many local writes this entry composes (1 for an uncoalesced write) */
  readonly parts?: number;
  /** index of the entry's first local write in the uncoalesced history */
  readonly from?: number;
};
type HistStep = { readonly local: boolean; readonly edits: readonly Edit[] };

/**
 * Coalescing reference (§14.5): the open entry extends only if the incoming write is CONTINUOUS with
 * it — its `prev` is (`Object.is`) or equals (structEq) the open entry's `next`, i.e. nothing changed
 * under us between the two local writes; otherwise a new entry starts.
 */
function coalesceRef(entries: readonly HistEntry[]): HistEntry[] {
  const out: HistEntry[] = [];
  entries.forEach((e, i) => {
    const open = out.at(-1);
    if (open && (Object.is(open.next, e.prev) || structEq(open.next, e.prev)))
      out[out.length - 1] = {
        prev: open.prev,
        next: e.next,
        parts: (open.parts ?? 1) + 1,
        from: open.from,
      };
    else out.push({ ...e, parts: 1, from: i });
  });
  // §14.11 ruling 4: a run whose composite is structurally a no-op is dropped (an undo step that does nothing)
  return out.filter((e) => !structEq(e.prev, e.next));
}

/** A local/remote interleaving from `v0`: the local writes' history and the final value. */
function simulateHistory(v0: unknown[], steps: readonly HistStep[]) {
  let cur = v0;
  const entries: HistEntry[] = [];
  const stepOf: number[] = []; // the step index of each entry
  steps.forEach((s, i) => {
    const next = applyEdits(cur, s.edits);
    if (s.local && !structEq(next, cur)) {
      entries.push({ prev: cur, next });
      stepOf.push(i);
    }
    cur = next;
  });
  return { entries, final: cur, stepOf };
}

/** Undo entries newest first, each by the selective-undo merge `undoRef(N, P, current)`. */
const undoAll = (entries: readonly HistEntry[], from: unknown[]): unknown[] =>
  entries.reduceRight<unknown[]>(
    (x, e) => undoRef(e.next, e.prev, x) as unknown[],
    from,
  );

describe('N4 — a coalesced entry is ONE logical write (§14.11 ruling 4, coalescing law B)', () => {
  it(`[PROVEN] undoing a coalesced entry ≡ undoing the run as ONE write P→N (definitional) AND ≡ undoing its writes one by one when no remote write landed during or after it (a remote write that CHANGES the value splits the run; an ABA pair inside is invisible by value, by design — FINDING-IMPL-3) (${NUM_RUNS} runs)`, () => {
    let merged = 0;
    let quiet = 0;
    fc.assert(
      fc.property(
        anyArrayArb,
        fc.array(fc.record({ local: fc.boolean(), edits: writerEditsArb() }), {
          minLength: 2,
          maxLength: 6,
        }),
        writerEditsArb(),
        (v0, steps, last) => {
          const run = [...steps, { local: true, edits: last }]; // ends with a local write
          const { entries, final, stepOf } = simulateHistory(v0, run);
          const groups = coalesceRef(entries);
          const g = groups.at(-1);
          // the newest run must end at the last local write (else it was a dropped no-op run)
          if (!g || (g.from ?? 0) + (g.parts ?? 1) !== entries.length) return;
          if ((g.parts ?? 1) > 1) merged++;
          const parts = entries.slice(g.from ?? 0);
          // definitional: the entry's undo is the net change merged against the present
          expect(
            structEq(undoAll([g], final), undoRef(g.next, g.prev, final)),
          ).toBe(true);
          // one by one: only when no remote write landed since the run began (an ABA pair of remote
          // writes inside the run is invisible to the structural continuity rule — FINDING-IMPL-3)
          const remoteSince = run
            .slice(stepOf[g.from ?? 0])
            .some((st) => !st.local);
          if (!remoteSince) {
            quiet++;
            expect(structEq(undoAll([g], final), undoAll(parts, final))).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(merged).toBeGreaterThan(0); // some runs actually coalesced
    expect(quiet).toBeGreaterThan(0); // and some had no remote write since the run began
  });

  it('[PIN N4 one write] [1] →(local) [0] →(local) [1] →(remote) [0]: the run is ONE logical write [1]→[1], a no-op, dropped; undo leaves the present [0]. The REJECTED alternative (constituent inverses, newest first) gave [1], stomping the newer remote [0] with my net nothing. Length case [a]→[]→[a], remote [b] ⇒ [b] (rejected: [a])', () => {
    const e1 = { prev: [1], next: [0] };
    const e2 = { prev: [0], next: [1] };
    const groups = coalesceRef([e1, e2]);
    expect(groups).toEqual([]); // the no-op run is dropped
    expect(undoAll(groups, [0])).toEqual([0]); // chosen (B)
    expect(undoAll([e1, e2], [0])).toEqual([1]); // rejected (A): one by one
    const a = { id: 'a', t: 'A' };
    const b = { id: 'a', t: 'B' };
    const run = [
      { prev: [a], next: [] },
      { prev: [], next: [a] },
    ];
    expect(undoAll(coalesceRef(run), [b])).toEqual([b]); // chosen (B)
    expect(undoAll(run, [b])).toEqual([a]); // rejected (A)
  });

  it('[PIN N4 no-op run] a continuous run whose composite is structurally a no-op leaves NO history entry; a run that only passes through its start does not', () => {
    expect(
      coalesceRef([
        { prev: [1, 2], next: [3, 2] },
        { prev: [3, 2], next: [1, 2] },
      ]),
    ).toEqual([]);
    expect(
      coalesceRef([
        { prev: [1], next: [0] },
        { prev: [0], next: [1] },
        { prev: [1], next: [2] },
      ]),
    ).toEqual([{ prev: [1], next: [2], parts: 3, from: 0 }]);
  });

  it('[PIN N4 astra] [0,0] →(local) [1,0] →(remote) [1,2] →(local) [3,2]: the remote write breaks the run (two entries); sequential undo gives [1,2] then [0,2]; coalesced equals it', () => {
    const e1 = { prev: [0, 0], next: [1, 0] };
    const e2 = { prev: [1, 2], next: [3, 2] };
    const groups = coalesceRef([e1, e2]);
    expect(groups).toHaveLength(2);
    expect(undoAll([e2], [3, 2])).toEqual([1, 2]);
    expect(undoAll([e1, e2], [3, 2])).toEqual([0, 2]);
    expect(undoAll(groups, [3, 2])).toEqual([0, 2]);
    // today's endpoint-only compose (mergeInto) makes one entry [0,0] → [3,2]: undo erases the remote 2
    expect(undoAll([{ prev: [0, 0], next: [3, 2] }], [3, 2])).toEqual([0, 0]);
  });

  it('[PIN N4 redo] redo inverts the change ACTUALLY applied: after the selective undo C [1,2] → U [0,2], redo yields C', () => {
    const C = [1, 2];
    const U = undoRef([1, 0], [0, 0], C) as unknown[];
    expect(U).toEqual([0, 2]);
    expect(undoRef(U, C, U)).toEqual(C); // redo = undo of the applied entry U ← C, current U
  });
});

// ---------------------------------------------------------------------------------------------
// §14.4 / §14.11 — the `vanished` guard (adopted; the law)
// ---------------------------------------------------------------------------------------------

describe('K4′ / B′ `vanished` guard — the law since §14.11 ruling 1', () => {
  it('[PIN K4′ vanished F6] [1,1,2]: A [0,1,2] > B [1,2,2] ⇒ [0,2,2]; the pre-refinement guard gave [0,1,2]', () => {
    expect(positionalRef([1, 1, 2], [0, 1, 2], [1, 2, 2])).toEqual([0, 2, 2]);
    expect(preRefinement([1, 1, 2], [0, 1, 2], [1, 2, 2])).toEqual([0, 1, 2]);
  });

  it('[PIN B′ vanished] undo P [5,6,7], N [1,6,7], C [1,7,7] ⇒ [5,7,7] (pre-refinement [5,6,7]); §14.4 facts (1) and (2) unchanged', () => {
    expect(undoRef([1, 6, 7], [5, 6, 7], [1, 7, 7])).toEqual([5, 7, 7]);
    expect(undoRef([1, 6, 7], [5, 6, 7], [1, 7, 6])).toEqual([5, 6, 7]); // (2) a real swap still fires
    const P = [
      { id: 'a', v: 0 },
      { id: 'b', v: 0 },
    ];
    expect(
      undoRef([P[1], P[0]], P, [
        { id: 'b', v: 1 },
        { id: 'a', v: 0 },
      ]),
    ).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 0 },
    ]); // (1) own-reorder attachment unchanged
  });

  it('[PIN K4′ vanished moves] every pure move still fires: swap, rotate, shift, a move among duplicates', () => {
    for (const [anc, side] of [
      [
        [1, 2, 3],
        [2, 1, 3],
      ],
      [
        [1, 2, 3],
        [2, 3, 1],
      ],
      [
        [1, 2, 3, 4],
        [4, 1, 2, 3],
      ],
      [
        [1, 1, 2],
        [1, 2, 1],
      ],
    ])
      expect(movedAgainst(anc, side, true), JSON.stringify(side)).toBe(true);
  });
});

describe('(c′) precondition — a length-keeping remove + insert is a replacement, not a shape edit', () => {
  it('[PIN K4′ two replacements] base [c,e]; W0 removes c and inserts a at 0 ⇒ [a,e]; W3 removes e and inserts a at 1 ⇒ [c,a]; same length, nothing moved ⇒ per slot [a,a]: a bag no writer wrote, legitimately (the old (c′) generator admitted this and was flaky)', () => {
    const c = { id: 'c', t: 'C' };
    const e = { id: 'e', t: 'A' };
    const a = { id: 'a', t: 'A', n: 0 };
    const sc: Scenario = {
      base: [c, e],
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 59,
    };
    const r = runArrays(
      sc,
      (own, k) => (k === 0 ? [a, own[1]] : [own[0], a]),
      positionalPolicy(),
    );
    expect(expectConverged(r)).toEqual([a, a]);
  });
});

// ---------------------------------------------------------------------------------------------
// astra r3 (implementation review) — reference defects and domain pins
// ---------------------------------------------------------------------------------------------

describe('astra r3 — reference fixes and domain pins', () => {
  it('[PIN K5 NaN identity] identities compare SameValueZero: identity = () => NaN, anc [], mine [1], theirs [2] ⇒ one identity, cross-side additions pair ⇒ [1] (astra r3 A3: the reference used === and gave [1,2])', () => {
    expect(keyedArrayWith(() => NaN)([], [1], [2])).toEqual([1]);
  });

  it("[PIN K5 undefined addition] an addition on both sides whose body is `undefined` keeps ABSENT as its ancestor: anc [], mine [undefined], theirs [5] ⇒ [undefined] (mine's body; astra r3 A1: a production that substitutes `undefined` for the absent ancestor yields [5])", () => {
    expect(keyedArrayWith(() => 'x')([], [undefined], [5])).toEqual([
      undefined,
    ]);
  });

  it('[PIN K4′ holes] structurally equal inputs give equal outputs: anc [undefined], theirs [1], mine [undefined] ⇒ [1]; mine = new Array(1) (a hole ≡ undefined) ⇒ [1] with index 0 PRESENT (astra r3 law amendment 1: `.map` skipped the hole)', () => {
    expect(positionalRef([undefined], [undefined], [1])).toEqual([1]);
    const out = positionalRef([undefined], new Array(1), [1]) as unknown[];
    expect(out).toEqual([1]);
    expect(0 in out).toBe(true);
    expect(structEq(out, [1])).toBe(true);
  });
});
