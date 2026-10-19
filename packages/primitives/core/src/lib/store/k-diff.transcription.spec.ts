import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { merge3 } from './fork-store';
import { createHlcClock } from './hlc';
import { applyOps, diffOps, type StoreOp } from './op-log';
import { isOpaque, opaque } from './opaque';
import {
  createConvergingApply,
  isConflicted,
  keyedArray,
  lww,
  OP_PROTO_VERSION,
  opSync,
  policyStrategy,
  positional,
  preserve,
  rebaseOps,
  syncedFork,
  undoMerge,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSyncCheckpoint,
} from './op-sync';
import { structEq as prodStructEq } from './predicates';
import { store } from './store';
import { storeHistory } from './store-history';

// K-diff IMPL: transcription gate. Every function in the "verifier-owned references" block below is
// RE-DECLARED verbatim from `k-diff.model.spec.ts` (the verifier's model, 77 tests after the astra r3
// amendments: SameValueZero identities, `Array.from` positional iteration; that file is not edited
// here, and a non-spec helper module would ship fast-check into the library build). Each
// `[PROVEN→impl] X ≡ XRef` property calls the production function and its reference on the SAME
// generated inputs, compared under the verifier's `structEq`; pins replicate the model's `[PIN …]`s
// whose subject is production behaviour. Coalescing has NO reference copy here, by design: the
// model's `coalesceRef` is single-path (a scalar witness), while production entries are root pairs
// (charter §16.1); coalescing coverage is the production pins (D1, D2, overlap 1/2, remote
// elsewhere, the N4 pins) plus the local-only property in the P7 block.
// Source lines of each copied block are given in its banner (model line numbers at P1g).

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
const positionalRef = positionalWith(POSITIONAL_GUARDS);
/** The selective-undo merge (F8, ruling B′): `undoRef(N, P, C)` — anc = my forward `next`, mine = my
 * inverse's target `P`, theirs = the current value. Equal length required; OTHERS moved since `N` ⇒
 * lww (my inverse whole); else per slot, both changed ⇒ `merge3Ref`. */
const undoRef = positionalWith({ movedMine: false, vanished: true });
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

// ---------------------------------------------------------------------------------------------
// K4 — the integrity theorem under unit emission (lww, no policy) + the index-mode negative control
// ---------------------------------------------------------------------------------------------

/** The soup predicate: the converged id-multiset is that of NO writer's array (nor the base's). */
const isSoup = (
  r: Run,
  out: readonly unknown[],
  base: readonly unknown[],
): boolean =>
  idBag(out) !== idBag(base) && !r.arrays.some((a) => idBag(a) === idBag(out));

// ---------------------------------------------------------------------------------------------
// K4′ — positional three-way WHEN SAFE, installed as the policy at the array path of the REAL
// register (how the default fold behaves after P2a)
// ---------------------------------------------------------------------------------------------

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

const tripleArb = (baseArb: fc.Arbitrary<unknown[]> = anyArrayArb) =>
  fc
    .tuple(baseArb, writerEditsArb(), writerEditsArb())
    .map(([base, e1, e2]) => ({
      base,
      mine: applyEdits(base, e1),
      theirs: applyEdits(base, e2),
    }));

// =============================================================================================
// IMPL P2a — value-based `merge3`, the exported `positional`, the no-policy / explicit-`lww` split
// =============================================================================================

/** Plain-data values of every shape the references cover, plus the boundary members of the domain. */
const valueArb: fc.Arbitrary<unknown> = fc.oneof(
  anyArrayArb,
  elementArb,
  fc.jsonValue({ maxDepth: 3 }),
  fc.constantFrom<unknown>(
    NaN,
    0,
    -0,
    undefined,
    null,
    [undefined],
    new Array(1),
  ),
);

/** A root record and copy-on-write edits of it: shared subtrees, deleted keys, added keys. */
const rootArb = fc.record(
  {
    todos: anyArrayArb,
    meta: fc.record(
      { tags: scalarArrayArb, s: fc.nat(2) },
      { requiredKeys: [] },
    ),
    k: fc.option(fc.nat(2), { nil: undefined }),
  },
  { requiredKeys: ['todos'] },
);
const sideOf = (base: Rec, edits: readonly Edit[], mask: number): Rec => {
  const out: Rec = { ...base };
  if (mask & 1) out['todos'] = applyEdits(base['todos'] as unknown[], edits);
  if (mask & 2 && isPlainRec(base['meta'])) {
    const meta = base['meta'];
    out['meta'] = isList(meta['tags'])
      ? { ...meta, tags: applyEdits(meta['tags'], edits) }
      : { ...meta, s: 9 };
  }
  if (mask & 4) delete out['k'];
  if (mask & 8) out['z'] = mask;
  if (mask & 16) out['meta'] = wire(base['meta'] ?? null); // a fresh copy of an untouched subtree
  return out;
};
const rootTripleArb = fc
  .tuple(rootArb, writerEditsArb(), writerEditsArb(), fc.nat(31), fc.nat(31))
  .map(([base, e1, e2, m1, m2]) => ({
    base: base as Rec,
    mine: sideOf(base as Rec, e1, m1),
    theirs: sideOf(base as Rec, e2, m2),
  }));

/**
 * "≡ reference" = equal under the VERIFIER's `structEq` (values and key presence, deep).
 * References and the prototype of a plain record (`null` vs `Object.prototype`) may differ: where
 * `merge3`'s `Object.is` fast path returns one of two structurally equal sides, the reference may
 * return the other (both are "unchanged" by the K7 law).
 */
const expectSame = (actual: unknown, expected: unknown): void => {
  if (!structEq(actual, expected)) expect(actual).toStrictEqual(expected);
};

describe('P2a — production ≡ reference (structEq, merge3, positional)', () => {
  it(`[PROVEN→impl] structEq ≡ the model's structEq over generated pairs, clones and wire copies (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        expect(prodStructEq(a, b)).toBe(structEq(a, b));
        expect(prodStructEq(a, clone(a))).toBe(structEq(a, clone(a)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K7 equality domain] two `new Date(0)` are not equal, one instance is; holes ≡ undefined; NaN ≡ NaN; +0 ≢ -0', () => {
    const d = new Date(0);
    expect(prodStructEq(new Date(0), new Date(0))).toBe(false);
    expect(prodStructEq(d, d)).toBe(true);
    expect(prodStructEq({ d }, { d })).toBe(true);
    expect(prodStructEq(new Array(1), [undefined])).toBe(true);
    expect(prodStructEq(NaN, NaN)).toBe(true);
    expect(prodStructEq(0, -0)).toBe(false);
    expect(prodStructEq({ a: undefined }, {})).toBe(false);
  });

  it(`[PROVEN→impl] merge3 ≡ merge3Ref, values AND presence (toStrictEqual), for copy-on-write sides and for wire copies (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(rootTripleArb, ({ base, mine, theirs }) => {
        expectSame(merge3(base, mine, theirs), merge3Ref(base, mine, theirs));
        const [a, m, t] = [wire(base), wire(mine), wire(theirs)];
        expectSame(merge3(a, m, t), merge3Ref(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, (a, m, t) => {
        expectSame(merge3(a, m, t), merge3Ref(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K7 edit/revert] ancestor {arr:[0]}; mine writes [1] then a FRESH [0]; theirs {arr:[2]} ⇒ merge3 = {arr:[2]}', () => {
    expect(merge3({ arr: [0] }, { arr: [0] }, { arr: [2] })).toEqual({
      arr: [2],
    });
    expect(merge3Ref({ arr: [0] }, { arr: [0] }, { arr: [2] })).toEqual({
      arr: [2],
    });
  });

  it('[PIN K7 unchanged side] astra F3: merge3([1],[1],[2]) = [2] on fresh references', () => {
    expect(merge3([1], [1], [2])).toEqual([2]);
  });

  it(`[PROVEN→impl] positional ≡ positionalRef over copy-on-write triples (author form), their wire copies, and arbitrary value triples (${NUM_RUNS} runs)`, () => {
    const ctx = { path: ['todos'] };
    fc.assert(
      fc.property(tripleArb(), ({ base, mine, theirs }) => {
        expectSame(
          positional(base, mine, theirs, ctx),
          positionalRef(base, mine, theirs),
        );
        const [a, m, t] = [wire(base), wire(mine), wire(theirs)];
        expectSame(positional(a, m, t, ctx), positionalRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, (a, m, t) => {
        expectSame(positional(a, m, t, ctx), positionalRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K4′ vanished F6] [1,1,2]: A [0,1,2] > B [1,2,2] ⇒ [0,2,2] (a copy is not a move); every pure move still keeps the winner whole', () => {
    const ctx = { path: [] };
    expect(positional([1, 1, 2], [0, 1, 2], [1, 2, 2], ctx)).toEqual([0, 2, 2]);
    expect(positional([1, 1, 2], [1, 2, 2], [0, 1, 2], ctx)).toEqual([0, 2, 2]);
    const anc = [1, 2, 3, 4];
    for (const moved of [
      [2, 1, 3, 4], // swap
      [2, 3, 4, 1], // rotate
      [9, 1, 2, 3], // shift
    ])
      expect(positional(anc, [1, 2, 3, 5], moved, ctx)).toEqual([1, 2, 3, 5]);
    expect(positional([1, 1, 2], [1, 1, 3], [1, 2, 1], ctx)).toEqual([1, 1, 3]); // a move among duplicates
  });
});

/** `runPatched` over the DEFAULT register (no merge policy at all). */
function runPatchedDefault(
  base: readonly unknown[],
  patches: readonly { slot: number; patch: Rec }[],
  rank: readonly number[],
  orderSeed: number,
): unknown[] {
  const sc: Scenario = {
    base: base.slice(),
    writers: patches.map(() => []),
    rank,
    orderSeed,
  };
  const r = runArrays(sc, (own, k) => {
    const out = own.slice();
    out[patches[k].slot] = {
      ...(own[patches[k].slot] as Rec),
      ...patches[k].patch,
    };
    return out;
  });
  return expectConverged(r);
}

describe('P2a — the register with NO policy folds array siblings positionally (model K4′ (a)(b)(c) re-run against the default)', () => {
  it(`[PROVEN→impl] (a) distinct-slot field edits all survive (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(distinctSlotEditsArb, ({ base, slots, rank, orderSeed }) => {
        const patches = slots.map((slot, k) => ({
          slot,
          patch: { t: `X${k}` },
        }));
        const out = runPatchedDefault(base, patches, rank, orderSeed);
        const expected = base.slice();
        for (const { slot, patch } of patches)
          expected[slot] = { ...(base[slot] as Rec), ...patch };
        expect(structEq(out, expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] (b) different fields of the same slot both survive (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(distinctSlotEditsArb, ({ base, slots, rank, orderSeed }) => {
        const patches = slots.map((slot, k) =>
          k === 0
            ? { slot, patch: { t: 'X0' } }
            : k === 1
              ? { slot: slots[0], patch: { n: 7 } }
              : { slot, patch: { t: `X${k}` } },
        );
        const out = runPatchedDefault(base, patches, rank, orderSeed);
        const expected = base.slice();
        expected[slots[0]] = { ...(base[slots[0]] as Rec), t: 'X0', n: 7 };
        for (const { slot, patch } of patches.slice(2))
          expected[slot] = { ...(base[slot] as Rec), ...patch };
        expect(structEq(out, expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] (c)+(d) any scenario: replicas equal; converged ≡ the winner-first positionalRef reduce; some writer's array OR within the provenance bound; no soup outside it; no required key lost (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(scenarioArb(), (sc) => {
        const r = run(sc, 'unit');
        const out = expectConverged(r);
        expect(structEq(out, expectedReduce(sc, r, positionalRef))).toBe(true);
        const d2 = provenanceBound(sc, r, out);
        if (!d2)
          expect(
            isSoup(r, out, sc.base),
            'soup outside the per-slot disjunct',
          ).toBe(false);
        expect(isWritersArray(r, out, sc.base) || d2).toBe(true);
        expect(requiredKeysMissing(sc, r, out)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN F7] no policy vs explicit `lww` in the register: [0,0], A [1,0] > B [0,2] ⇒ [1,2] with no policy, [1,0] with an explicit `lww`', () => {
    const fold = (policies?: readonly MergePolicyEntry[]): unknown[] => {
      const sc: Scenario = {
        base: [0, 0],
        writers: [[], []],
        rank: [1, 0],
        orderSeed: 5,
      };
      const r = runArrays(
        sc,
        (own, k) => (k === 0 ? [1, own[1]] : [own[0], 2]),
        policies,
      );
      return expectConverged(r);
    };
    expect(fold()).toEqual([1, 2]);
    expect(fold([{ path: ['todos'], merge: lww }])).toEqual([1, 0]);
    expect(fold([{ path: 'todos', merge: lww }])).toEqual([1, 0]);
  });

  it('[PIN F7 rebaseOps] the same split through rebaseOps: pending {arr} [0,0]→[1,0] over remote [0,2] ⇒ [1,2] no policy, [1,0] explicit `lww`', () => {
    const pending: StoreOp[][] = [
      [{ kind: 'set', path: ['arr'], prev: [0, 0], next: [1, 0] }],
    ];
    const remote: StoreOp[] = [
      { kind: 'set', path: ['arr'], prev: [0, 0], next: [0, 2] },
    ];
    expect(rebaseOps({ arr: [1, 0] }, pending, remote).root).toEqual({
      arr: [1, 2],
    });
    expect(
      rebaseOps({ arr: [1, 0] }, pending, remote, [{ path: 'arr', merge: lww }])
        .root,
    ).toEqual({ arr: [1, 0] });
  });

  it('[PIN K4′ g] a merged sibling with NO prev folds lww under the default; the winner whole', () => {
    expect(positional(undefined, [1], [2], { path: [] })).toEqual([1]);
    const base = [
      { id: 'a', t: 'A' },
      { id: 'b', t: 'B' },
    ];
    const W = replica('W');
    const L = replica('L');
    const baseEnv = envelope('BASE', 1, [
      { kind: 'set', path: ['todos'], next: base, cites: [], epoch: 0 },
    ]);
    W.receive(baseEnv);
    L.receive(baseEnv);
    const ownW = W.folded().todos;
    const ownL = L.folded().todos;
    const eW = W.emit(
      [
        {
          kind: 'set',
          path: ['todos'],
          prev: ownW,
          next: [{ ...(ownW[0] as Rec), t: 'A2' }, ownW[1]],
        },
      ],
      20,
    );
    const eL = L.emit(
      [
        {
          kind: 'set',
          path: ['todos'],
          next: [ownL[0], { ...(ownL[1] as Rec), t: 'B2' }],
        },
      ],
      10,
    );
    W.receive(eL);
    L.receive(eW);
    expect(W.state()).toEqual(L.state());
    expect(W.state().todos).toEqual([
      { id: 'a', t: 'A2' },
      { id: 'b', t: 'B' },
    ]);
  });
});

// N1 (charter §14.2): admission + hydration parity at the sync's entry points.
const manualDriver = () => ({ destroy: () => undefined });
const syncOf = (
  root: Rec,
  extra?: { onReject?: (e: OpEnvelope, r: string) => void },
) => {
  const source = signal<Rec>(root);
  const sync = opSync(source, {
    writer: 'me',
    origin: 'me',
    driver: manualDriver,
    ...extra,
  });
  return { source, sync };
};

/** Astra's checkpoint: registers that fold (v4) to {arr:[1,2]}, carried with the v3 root {arr:[1,0]}. */
function v3Checkpoint(): OpSyncCheckpoint<Rec> {
  const conv = createConvergingApply();
  conv.ingest(
    envelope('BASE', 1, [
      { kind: 'set', path: [], next: { arr: [0, 0] }, cites: [], epoch: 0 },
    ]),
  );
  conv.ingest(
    envelope('A', 20, [
      {
        kind: 'set',
        path: ['arr'],
        prev: [0, 0],
        next: [1, 0],
        cites: [],
        epoch: 0,
      },
    ]),
  );
  conv.ingest(
    envelope('B', 10, [
      {
        kind: 'set',
        path: ['arr'],
        prev: [0, 0],
        next: [0, 2],
        cites: [],
        epoch: 0,
      },
    ]),
  );
  return {
    proto: 3,
    root: { arr: [1, 0] },
    registers: conv.checkpoint(),
    wm: { BASE: 1, A: 1, B: 1 },
  };
}

describe('P2a — N1 entry points: hydrate parity, checkpoint proto, restore proto', () => {
  it('[PIN N1 hydrate parity] hydrating a v3 checkpoint (root {arr:[1,0]}, registers folding to [1,2]) yields the materialization of its registers: {arr:[1,2]}', () => {
    const { source, sync } = syncOf({});
    sync.hydrate(v3Checkpoint());
    expect(source()).toEqual({ arr: [1, 2] });
    const absent = syncOf({});
    const { proto, ...noProto } = v3Checkpoint();
    expect(proto).toBe(3);
    absent.sync.hydrate(noProto);
    expect(absent.source()).toEqual({ arr: [1, 2] });
  });

  it('[PIN N1 hydrate parity + pending] the pending replay lands on top of the re-materialized root', () => {
    const { source, sync } = syncOf({});
    const pending = envelope('me', 30, [
      { kind: 'set', path: ['x'], next: 1, cites: [], epoch: 0 },
    ]);
    sync.hydrate(v3Checkpoint(), [{ ...pending, version: 1 }]);
    expect(source()).toEqual({ arr: [1, 2], x: 1 });
  });

  it('[PIN N1 checkpoint proto] snapshot() writes OP_PROTO_VERSION; proto 3, absent and current load; any other (2, 99) throws naming both versions and leaves the store untouched', () => {
    const { source, sync } = syncOf({ a: 1 });
    expect(sync.snapshot().proto).toBe(OP_PROTO_VERSION);
    for (const proto of [2, 99]) {
      expect(() => sync.hydrate({ ...v3Checkpoint(), proto })).toThrow(
        new RegExp(`protocol ${proto}.*protocol ${OP_PROTO_VERSION}`),
      );
      expect(source()).toEqual({ a: 1 });
    }
    for (const proto of [3, undefined, OP_PROTO_VERSION]) {
      const r = syncOf({});
      r.sync.hydrate({ ...v3Checkpoint(), proto });
      expect(r.source()).toEqual({ arr: [1, 2] });
    }
  });

  it('[PIN N1 restore proto] restore drops an outbox envelope of another protocol (onReject), and replays a current one', () => {
    const rejected: string[] = [];
    const { source, sync } = syncOf(
      {},
      { onReject: (_e, r) => rejected.push(r) },
    );
    const old = {
      ...envelope('me', 5, [
        { kind: 'set', path: ['old'], next: 1, cites: [], epoch: 0 },
      ]),
      proto: 3,
    };
    const cur = envelope('me', 6, [
      { kind: 'set', path: ['cur'], next: 1, cites: [], epoch: 0 },
    ]);
    sync.restore([old, { ...cur, version: 2 }]);
    expect(source()).toEqual({ cur: 1 });
    expect(rejected).toEqual([`proto 3 (expected ${OP_PROTO_VERSION})`]);
  });
});

// =============================================================================================
// IMPL P2 — emission mode (`arrays: 'unit' | 'index'`), opSync's unit default, policyStrategy
// =============================================================================================

describe('P2 — diffOps array modes ≡ the references (K1, K2)', () => {
  it(`[PROVEN→impl] diffOps(prev, next, { arrays: 'unit' }) ≡ unitDiff, and the unit shape law holds (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        const ops = diffOps(prev, next, { arrays: 'unit' });
        expect(ops).toStrictEqual(unitDiff(prev, next));
        expect(unitShapeViolation(prev, next, ops)).toBeNull();
        expect(applyOps(prev, ops)).toEqual(next);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] echo freedom: a rebuilt-but-equal root emits nothing under 'unit' (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev }) => {
        expect(diffOps(prev, clone(prev), { arrays: 'unit' })).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it(`[PROVEN→impl] K2: the default and explicit 'index' ≡ frozenIndexDiff (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(pairArb, ({ prev, next }) => {
        expect(diffOps(prev, next)).toStrictEqual(frozenIndexDiff(prev, next));
        expect(diffOps(prev, next, { arrays: 'index' })).toStrictEqual(
          frozenIndexDiff(prev, next),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('P2 — opSync emits units by default (K3); policyStrategy diffs units', () => {
  const emitted = (emit?: { arrays?: 'unit' | 'index' }) => {
    const source = signal<Rec>({ arr: ['a', 'b'], k: 1 });
    const sync = opSync(source, {
      writer: 'w',
      origin: 'o',
      driver: manualDriver,
      emit,
    });
    const out: OpEnvelope[] = [];
    sync.subscribe((e) => out.push(e));
    source.set({ arr: ['b', 'a'], k: 1 });
    sync.flush();
    return out.flatMap((e) =>
      e.ops.map((o) => ({ kind: o.kind, path: o.path })),
    );
  };

  it('[PIN K3] a same-length reorder under opSync is ONE envelope op at the array path; `emit: { arrays: "index" }` keeps the per-index walk', () => {
    expect(emitted()).toEqual([{ kind: 'set', path: ['arr'] }]);
    expect(emitted({})).toEqual([{ kind: 'set', path: ['arr'] }]);
    expect(emitted({ arrays: 'index' })).toEqual([
      { kind: 'set', path: ['arr', 0] },
      { kind: 'set', path: ['arr', 1] },
    ]);
  });

  it('[PIN F7 policyStrategy] {arr:[0,0]} / mine [1,0] / theirs [0,2] ⇒ [1,2] with no policy, [1,0] with an explicit `lww`', () => {
    const anc = { arr: [0, 0] };
    expect(
      policyStrategy<Rec>([])(anc, { arr: [1, 0] }, { arr: [0, 2] }),
    ).toEqual({ arr: [1, 2] });
    expect(
      policyStrategy<Rec>([{ path: 'arr', merge: lww }])(
        anc,
        { arr: [1, 0] },
        { arr: [0, 2] },
      ),
    ).toEqual({ arr: [1, 0] });
  });

  it('[PIN scoped fork commit] (§14.7) the fork previews [1,0]; its commit (citing the fork-time frontier) folds with the remote [0,2] to [1,2] on both peers — preview and committed value differ by design', () => {
    TestBed.runInInjectionContext(() => {
      type S = { arr: number[] };
      const sa = store<S>({ arr: [0, 0] });
      const sb = store<S>({ arr: [0, 0] });
      const a = opSync(sa, {
        writer: 'wa',
        origin: 'oa',
        clock: createHlcClock(() => 1),
      });
      const b = opSync(sb, {
        writer: 'wb',
        origin: 'ob',
        clock: createHlcClock(() => 2),
      });
      const aOut: OpEnvelope[] = [];
      const bOut: OpEnvelope[] = [];
      a.subscribe((e) => aOut.push(e));
      b.subscribe((e) => bOut.push(e));
      a.seed();
      for (const e of aOut.splice(0)) b.receive(e);
      const fk = syncedFork(a, sa);
      sb.arr.set([0, 2]);
      b.flush();
      for (const e of bOut.splice(0)) a.receive(e);
      fk.store.arr.set([1, 0]);
      expect(fk.store.arr()).toEqual([1, 0]); // preview: merge3 keeps the fork's array whole
      fk.commit();
      a.flush();
      for (const e of aOut.splice(0)) b.receive(e);
      expect(sa.arr()).toEqual([1, 2]);
      expect(sb.arr()).toEqual([1, 2]);
    });
  });
});

// =============================================================================================
// IMPL P2b — selective undo (`undoMerge`, `storeHistory({ policies })`, coalescing law B)
// =============================================================================================

/** Two synced peers (manual drivers); A's history tracks A's sync. `todos` is the array under test. */
function undoRig(
  todos: unknown[],
  opt?: {
    policies?: readonly MergePolicyEntry[];
    coalesce?: { ms: number };
    now?: () => number;
  },
) {
  const sa = signal<Rec>({ todos });
  const sb = signal<Rec>({ todos });
  const mk = (s: typeof sa, o: string, p: number) =>
    opSync(s, {
      writer: `w${o}`,
      origin: o,
      driver: manualDriver,
      clock: createHlcClock(() => p),
      policies: opt?.policies,
    });
  const a = mk(sa, 'oa', 1);
  const b = mk(sb, 'ob', 2);
  const aOut: OpEnvelope[] = [];
  const bOut: OpEnvelope[] = [];
  a.subscribe((e) => aOut.push(e));
  b.subscribe((e) => bOut.push(e));
  const toB = () => aOut.splice(0).forEach((e) => b.receive(e));
  const toA = () => bOut.splice(0).forEach((e) => a.receive(e));
  a.seed();
  toB();
  const h = storeHistory(sa, {
    track: a,
    driver: manualDriver,
    policies: opt?.policies,
    coalesce: opt?.coalesce,
    now: opt?.now,
  });
  const write = (s: typeof sa, sync: typeof a, next: unknown[]) => {
    s.set({ ...s(), todos: next });
    sync.flush();
  };
  return {
    h,
    /** a local write by A (tracked) */
    mine: (next: unknown[]) => write(sa, a, next),
    /** a write by B; `seen` = B first receives A's pending envelopes (B then supersedes them) */
    theirs: (
      next: unknown[] | ((cur: unknown[]) => unknown[]),
      seen = false,
    ) => {
      if (seen) toB();
      const cur = sb()['todos'] as unknown[];
      write(sb, b, typeof next === 'function' ? next(cur) : next);
    },
    sync: () => {
      toB();
      toA();
      toB();
    },
    undo: () => {
      h.undo();
      toB();
      toA();
    },
    redo: () => {
      h.redo();
      toB();
      toA();
    },
    a: () => sa()['todos'] as unknown[],
    b: () => sb()['todos'] as unknown[],
  };
}

describe('P2b — undoMerge ≡ undoRef; storeHistory undoes selectively', () => {
  it(`[PROVEN→impl] undoMerge ≡ undoRef over copy-on-write triples, wire copies and arbitrary values (${NUM_RUNS} runs)`, () => {
    const ctx = { path: ['todos'] };
    fc.assert(
      fc.property(tripleArb(), ({ base, mine, theirs }) => {
        expectSame(
          undoMerge(mine, base, theirs, ctx),
          undoRef(mine, base, theirs),
        );
        const [a, m, t] = [wire(mine), wire(base), wire(theirs)];
        expectSame(undoMerge(a, m, t, ctx), undoRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, (a, m, t) => {
        expectSame(undoMerge(a, m, t, ctx), undoRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PROVEN→impl] over the real sync: my write N of P, a concurrent write T, both folded to C; undo ⇒ undoRef(N, P, C) on both peers (100 runs)', () => {
    fc.assert(
      fc.property(
        tripleArb(recordArrayArb),
        ({ base: P, mine: N, theirs: T }) => {
          fc.pre(!structEq(N, P));
          const r = undoRig(P);
          r.mine(N);
          r.theirs(T);
          r.sync();
          const C = r.a();
          expect(r.b()).toEqual(C);
          r.undo();
          expectSame(r.a(), undoRef(N, P, C));
          expect(r.b()).toEqual(r.a());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("[PIN F8 selective undo] astra's [0,0] / A [1,0] / B [0,2] ⇒ C [1,2]; undoing A ⇒ [0,2] on both peers", () => {
    const r = undoRig([0, 0]);
    r.mine([1, 0]);
    r.theirs([0, 2]);
    r.sync();
    expect(r.a()).toEqual([1, 2]);
    r.undo();
    expect(r.a()).toEqual([0, 2]);
    expect(r.b()).toEqual([0, 2]);
  });

  it('[PIN F8] [5,6] / A [1,6] / B [5,2] ⇒ [1,2]; undoing A ⇒ [5,2]', () => {
    const r = undoRig([5, 6]);
    r.mine([1, 6]);
    r.theirs([5, 2]);
    r.sync();
    r.undo();
    expect(r.a()).toEqual([5, 2]);
  });

  it('[PIN F8 others moved] (OPEN-K-10) others reordered since my write ⇒ my inverse whole: P [5,6], N [1,6], C [6,1] ⇒ [5,6]', () => {
    const r = undoRig([5, 6]);
    r.mine([1, 6]);
    r.theirs([6, 1], true);
    r.sync();
    expect(r.a()).toEqual([6, 1]);
    r.undo();
    expect(r.a()).toEqual([5, 6]);
  });

  it('[PIN F8 one slot, two fields] I edited `t`, another writer then edited `n` of the same record: undo restores `t` and keeps their `n`', () => {
    const r = undoRig([{ id: 'a', t: 'A', n: 0 }]);
    r.mine([{ id: 'a', t: 'A2', n: 0 }]);
    r.theirs((cur) => [{ ...(cur[0] as Rec), n: 5 }], true);
    r.sync();
    r.undo();
    expect(r.a()).toEqual([{ id: 'a', t: 'A', n: 5 }]);
  });

  it('[PIN F8 own-reorder attachment] (accepted loss, OPEN-K-10; witnesses `movedMine: false`) P [a0,b0], my reorder [b0,a0], another writer edits b ⇒ C [b1,a0]; undo ⇒ [a1,b0]', () => {
    const a0 = { id: 'a', v: 0 };
    const b0 = { id: 'b', v: 0 };
    const r = undoRig([a0, b0]);
    r.mine([b0, a0]);
    r.theirs((cur) => [{ ...(cur[0] as Rec), v: 1 }, cur[1]], true);
    r.sync();
    expect(r.a()).toEqual([{ id: 'b', v: 1 }, a0]);
    r.undo();
    expect(r.a()).toEqual([{ id: 'a', v: 1 }, b0]);
  });

  it('[PIN B′ vanished] (witnesses the vanished guard on the undo side) P [5,6,7], N [1,6,7], C [1,7,7] ⇒ [5,7,7]; a real swap by others (C [1,7,6]) ⇒ [5,6,7]', () => {
    for (const [C, want] of [
      [
        [1, 7, 7],
        [5, 7, 7],
      ],
      [
        [1, 7, 6],
        [5, 6, 7],
      ],
    ]) {
      const r = undoRig([5, 6, 7]);
      r.mine([1, 6, 7]);
      r.theirs(C, true);
      r.sync();
      expect(r.a()).toEqual(C);
      r.undo();
      expect(r.a()).toEqual(want);
    }
  });
});

describe('P2b — the undo dispatch, inverse adds/deletes, redo, coalescing law B', () => {
  it('[PIN undo dispatch] explicit `lww` ⇒ my inverse whole (P [5,6], my [1,6], B [5,2] wins the fold; undo restores [5,6] whole, where no policy gives [5,2]); the `keyedArray` merge policy ⇒ identity-aware undo of my reorder ([a0,b1]: their edit stays on b)', () => {
    const r = undoRig([5, 6], { policies: [{ path: 'todos', merge: lww }] });
    r.mine([1, 6]);
    r.theirs([5, 2]);
    r.sync();
    expect(r.a()).toEqual([5, 2]);
    r.undo();
    expect(r.a()).toEqual([5, 6]);
    expect(undoMerge([1, 6], [5, 6], [5, 2], { path: [] })).toEqual([5, 2]);

    const a0 = { id: 'a', v: 0 };
    const b0 = { id: 'b', v: 0 };
    const k = undoRig([a0, b0], {
      policies: [{ path: 'todos', merge: keyedArray((x) => (x as Rec)['id']) }],
    });
    k.mine([b0, a0]);
    k.theirs(
      (cur) =>
        cur.map((x) => ((x as Rec)['id'] === 'b' ? { id: 'b', v: 1 } : x)),
      true,
    );
    k.sync();
    expect(k.a()).toEqual([{ id: 'b', v: 1 }, a0]);
    k.undo();
    expect(k.a()).toEqual([a0, { id: 'b', v: 1 }]);
  });

  it('[PIN undo add/delete] (§14.11.2) undoing my add removes the key only while it still holds what I added (an edit by others wins); undoing my delete always restores', () => {
    const rig = (root: Rec) => {
      const sa = signal<Rec>(root);
      const sb = signal<Rec>(root);
      const a = opSync(sa, {
        writer: 'wa',
        origin: 'oa',
        driver: manualDriver,
        clock: createHlcClock(() => 1),
      });
      const b = opSync(sb, {
        writer: 'wb',
        origin: 'ob',
        driver: manualDriver,
        clock: createHlcClock(() => 2),
      });
      const aOut: OpEnvelope[] = [];
      const bOut: OpEnvelope[] = [];
      a.subscribe((e) => aOut.push(e));
      b.subscribe((e) => bOut.push(e));
      const toB = () => aOut.splice(0).forEach((e) => b.receive(e));
      const toA = () => bOut.splice(0).forEach((e) => a.receive(e));
      a.seed();
      toB();
      const h = storeHistory(sa, { track: a, driver: manualDriver });
      const mine = (v: Rec) => (sa.set(v), a.flush(), toB());
      const theirs = (v: Rec) => (sb.set(v), b.flush(), toA());
      return { sa, h, mine, theirs };
    };
    const kept = rig({});
    kept.mine({ added: 1 });
    kept.theirs({ added: 2 });
    kept.h.undo();
    expect(kept.sa()).toEqual({ added: 2 }); // their edit of what I added wins
    const gone = rig({});
    gone.mine({ added: 1 });
    gone.h.undo();
    expect(gone.sa()).toEqual({});
    const back = rig({ k: 1 });
    back.mine({});
    back.theirs({ k: 5 });
    back.h.undo();
    expect(back.sa()).toEqual({ k: 1 }); // undoing my delete restores, whatever is there
  });

  it('[PIN redo] redo inverts the change ACTUALLY applied: after the selective undo C [1,2] → U [0,2], redo yields [1,2]', () => {
    const r = undoRig([0, 0]);
    r.mine([1, 0]);
    r.theirs([0, 2]);
    r.sync();
    r.undo();
    expect(r.a()).toEqual([0, 2]);
    r.redo();
    expect(r.a()).toEqual([1, 2]);
    expect(r.b()).toEqual([1, 2]);
  });

  it('[PIN N4 astra] [0,0] →(local) [1,0] →(remote) [1,2] →(local) [3,2] inside the coalescing window: the remote write closes the run (two entries); undo ⇒ [1,2], then [0,2]', () => {
    let t = 0;
    const r = undoRig([0, 0], { coalesce: { ms: 1000 }, now: () => t });
    r.mine([1, 0]);
    r.theirs([1, 2], true);
    r.sync();
    t = 1;
    r.mine([3, 2]);
    r.undo();
    expect(r.a()).toEqual([1, 2]);
    r.undo();
    expect(r.a()).toEqual([0, 2]);
    expect(r.h.canUndo()).toBe(false);
  });

  it('[PIN N4 one write] [1] →(local) [0] →(local) [1] →(remote) [0]: the continuous run is ONE write [1]→[1], a no-op, dropped; nothing to undo, the present [0] stays', () => {
    let t = 0;
    const r = undoRig([1], { coalesce: { ms: 1000 }, now: () => t });
    r.mine([0]);
    t = 1;
    r.mine([1]);
    expect(r.h.canUndo()).toBe(false); // [PIN N4 no-op run]
    r.sync();
    r.theirs([0], true);
    r.sync();
    expect(r.a()).toEqual([0]);
    r.undo();
    expect(r.a()).toEqual([0]);
  });

  it('[PIN N4 no-op run] a run that only passes through its start is one entry from the first value to the last: [1]→[0]→[1]→[2] undoes to [1]', () => {
    let t = 0;
    const r = undoRig([1], { coalesce: { ms: 1000 }, now: () => t });
    for (const v of [[0], [1], [2]]) {
      r.mine(v);
      t++;
    }
    expect(r.h.canUndo()).toBe(true);
    r.undo();
    expect(r.a()).toEqual([1]);
    expect(r.h.canUndo()).toBe(false);
  });
});

// =============================================================================================
// IMPL P3 — the `keyedArray` merge policy: unique path unchanged, duplicates by value (K5)
// =============================================================================================

const hasDupIds = (...arrs: (readonly unknown[])[]): boolean =>
  arrs.some(
    (a) => new Set(a.map((x) => JSON.stringify(idOf(x)))).size !== a.length,
  );
const prodKeyed = keyedArray(idOf);
const keyedProd = (a: unknown, m: unknown, t: unknown): unknown =>
  prodKeyed(a, m, t, { path: ['todos'] });
const prodKeyedPolicy: MergePolicyEntry[] = [
  { path: ['todos'], merge: prodKeyed },
];

describe('P3 — keyedArray ≡ keyedArrayRef (K5)', () => {
  it(`[PROVEN→impl] keyedArray(id) ≡ keyedArrayRef over copy-on-write triples WITH duplicates (every edit kind), their wire copies, and duplicate-heavy scalar triples (${NUM_RUNS} runs)`, () => {
    let dups = 0;
    fc.assert(
      fc.property(tripleArb(), ({ base, mine, theirs }) => {
        if (hasDupIds(base, mine, theirs)) dups++;
        expectSame(
          keyedProd(base, mine, theirs),
          keyedArrayRef(base, mine, theirs),
        );
        const [a, m, t] = [wire(base), wire(mine), wire(theirs)];
        expectSame(keyedProd(a, m, t), keyedArrayRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
    expect(dups).toBeGreaterThan(0);
    const dupScalars = fc.array(fc.nat(2), { maxLength: 6 });
    fc.assert(
      fc.property(dupScalars, dupScalars, dupScalars, (a, m, t) => {
        expectSame(keyedProd(a, m, t), keyedArrayRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('[PIN K5 smallest duplicate] mine duplicated `x`, theirs edited it: the copy is an addition, the edit lands once (the pre-K-diff `byKey` collapse landed it twice)', () => {
    const x = { id: 'a', t: 'A', n: 0 };
    expect(keyedProd([x], [x, x], [{ ...x, n: 1 }])).toEqual([
      { ...x, n: 1 },
      x,
    ]);
  });

  it("[PIN K5.4 bodies] clause (4) pairs additions equal-first, then in order, and coalesces each pair to mine's body: P,Q vs R,S,Q ⇒ [P,Q,S]; swapped ⇒ [R,S,Q]; reordered equal additions ⇒ mine's order", () => {
    const x = (v: string) => ({ id: 'x', v });
    const [P, Q, R, S] = [x('P'), x('Q'), x('R'), x('S')];
    expect(keyedProd([], [P, Q], [R, S, Q])).toEqual([P, Q, S]);
    expect(keyedProd([], [R, S, Q], [P, Q])).toEqual([R, S, Q]);
    expect(keyedProd([], [Q, P], [P, Q])).toEqual([Q, P]);
    const sc: Scenario = {
      base: [],
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 43,
    };
    const r = runArrays(
      sc,
      (_own, k) => (k === 0 ? [P, Q] : [R, S, Q]),
      prodKeyedPolicy,
    );
    expect(expectConverged(r)).toEqual([P, Q, S]);
  });

  it('[PIN K5.4] both writers duplicating `x` fold to [x, x]; the same slot edit 2→0 on [2,0,1,2] by both folds to [0,0,1,2]', () => {
    const x = { id: 'a', t: 'A' };
    const r = runArrays(
      { base: [x], writers: [[], []], rank: [0, 1], orderSeed: 11 },
      (own) => [own[0], own[0]],
      prodKeyedPolicy,
    );
    expect(expectConverged(r)).toEqual([x, x]);
    const r2 = runArrays(
      { base: [2, 0, 1, 2], writers: [[], []], rank: [0, 1], orderSeed: 12 },
      (own) => [0, ...own.slice(1)],
      prodKeyedPolicy,
    );
    expect(expectConverged(r2)).toEqual([0, 0, 1, 2]);
  });

  it('[PIN K5 count] base [x,x], A [x,x,x] > B [] ⇒ [x]', () => {
    const x = { id: 'a', t: 'A' };
    const r = runArrays(
      { base: [x, x], writers: [[], []], rank: [1, 0], orderSeed: 23 },
      (own, k) => (k === 0 ? [own[0], own[1], own[0]] : []),
      prodKeyedPolicy,
    );
    expect(expectConverged(r)).toEqual([x]);
  });

  it("[PIN K5 multiplicity-2] the stated blind spot: the loser adds a new `b` then makes the winner's edit ⇒ [{b,w0,0},{b,B,0}]; edit first ⇒ [{b,B,0}, fresh]", () => {
    const b = { id: 'b', t: 'B', n: 2 };
    const fresh = { id: 'b', t: 'w0', n: 1 };
    const sc: Scenario = {
      base: [b],
      writers: [[], []],
      rank: [1, 0],
      orderSeed: 29,
    };
    const edit = (own: unknown[]) => ({ ...(own[0] as Rec), n: 0 });
    const r = runArrays(
      sc,
      (own, k) => (k === 0 ? [edit(own)] : [fresh, edit(own)]),
      prodKeyedPolicy,
    );
    expect(expectConverged(r)).toEqual([
      { id: 'b', t: 'w0', n: 0 },
      { id: 'b', t: 'B', n: 0 },
    ]);
    const r2 = runArrays(
      sc,
      (own, k) => (k === 0 ? [edit(own)] : [edit(own), fresh]),
      prodKeyedPolicy,
    );
    expect(expectConverged(r2)).toEqual([{ id: 'b', t: 'B', n: 0 }, fresh]);
  });

  it("[PIN K5-wire] (the model's FINDING, now fixed) the winner reorders, the loser edits a nested array over a JSON wire ⇒ the edit survives on every replica", () => {
    const base = [
      { id: 'a', t: 'A', tags: [1] },
      { id: 'b', t: 'B' },
    ];
    const r = runArrays(
      { base, writers: [[], []], rank: [1, 0], orderSeed: 13 },
      (own, k) =>
        k === 0
          ? [own[1], own[0]]
          : [{ ...(own[0] as Rec), tags: [1, 2] }, own[1]],
      prodKeyedPolicy,
    );
    expect(expectConverged(r)).toEqual([
      { id: 'b', t: 'B' },
      { id: 'a', t: 'A', tags: [1, 2] },
    ]);
  });
});

// =============================================================================================
// IMPL P6 — astra r3: one equality everywhere (G1/G2), per-path net coalescing (D1/D2), keyed
// pairs with no ancestor (A1), the opaque boundary (A2), holes, SameValueZero identities (A3)
// =============================================================================================

describe('P6 — one equality in the register and in rebaseOps (astra r3 G1/G2)', () => {
  const d = (p: number, next: unknown): OpEnvelope =>
    envelope(p === 1 ? 'A' : 'B', p, [
      { kind: 'set', path: ['d'], next, cites: [], epoch: 0 },
    ]);
  /** Fold the two concurrent sets in `order`; return the live value, `materialize()` and a fresh hydrate. */
  const fold = (a: unknown, b: unknown, order: 'AB' | 'BA') => {
    const conv = createConvergingApply();
    let root: unknown = {};
    const envs = order === 'AB' ? [d(1, a), d(2, b)] : [d(2, b), d(1, a)];
    for (const e of envs) root = applyOps(root, conv.ingest(e));
    const fresh = syncOf({});
    fresh.sync.hydrate({
      proto: OP_PROTO_VERSION,
      root: {},
      registers: conv.checkpoint(),
      wm: {},
    });
    return [
      (root as Rec)['d'],
      (conv.materialize() as Rec)['d'],
      fresh.source()['d'],
    ];
  };

  it('[PIN G1 Date winner] concurrent `new Date(0)` (HLC 1) and `new Date(1)` (HLC 2) at [d]: the HLC-2 Date in both delivery orders, live, materialized and after a fresh hydrate', () => {
    const d0 = new Date(0);
    const d1 = new Date(1);
    for (const order of ['AB', 'BA'] as const)
      for (const v of fold(d0, d1, order)) expect(v).toBe(d1);
  });

  it('[PIN G1 sparse length] concurrent `[]` (HLC 1) and `new Array(1)` (HLC 2): length 1 in both delivery orders and after a fresh hydrate', () => {
    for (const order of ['AB', 'BA'] as const)
      for (const v of fold([], new Array(1), order))
        expect((v as unknown[]).length).toBe(1);
  });

  it('[PIN G2 rebase] {a:[d0,1]} pending [d0,0]→[d0,1] over remote [d0,0]→[d1,0] ⇒ {a:[d1,1]} (the positional merge is not bypassed)', () => {
    const d0 = new Date(0);
    const d1 = new Date(1);
    const out = rebaseOps(
      { a: [d0, 1] },
      [[{ kind: 'set', path: ['a'], prev: [d0, 0], next: [d0, 1] }]],
      [{ kind: 'set', path: ['a'], prev: [d0, 0], next: [d1, 0] }],
    ).root as Rec;
    expect(out['a']).toEqual([d1, 1]);
    expect((out['a'] as unknown[])[0]).toBe(d1);
  });
});

/** Two synced peers over record roots; A's history tracks A's sync, coalescing on time alone. */
function recordRig(
  root: Rec,
  opt?: { coalesce?: { ms: number; samePath?: boolean }; now?: () => number },
) {
  const sa = signal<Rec>(root);
  const sb = signal<Rec>(root);
  const mk = (s: typeof sa, o: string, p: number) =>
    opSync(s, {
      writer: `w${o}`,
      origin: o,
      driver: manualDriver,
      clock: createHlcClock(() => p),
    });
  const a = mk(sa, 'oa', 1);
  const b = mk(sb, 'ob', 2);
  const aOut: OpEnvelope[] = [];
  const bOut: OpEnvelope[] = [];
  a.subscribe((e) => aOut.push(e));
  b.subscribe((e) => bOut.push(e));
  const toB = () => aOut.splice(0).forEach((e) => b.receive(e));
  const toA = () => bOut.splice(0).forEach((e) => a.receive(e));
  a.seed();
  toB();
  const h = storeHistory(sa, {
    track: a,
    driver: manualDriver,
    coalesce: opt?.coalesce,
    now: opt?.now,
  });
  return {
    sa,
    h,
    mine: (v: Rec) => (sa.set(v), a.flush(), toB()),
    theirs: (v: Rec) => (sb.set(v), b.flush(), toA()),
    undo: () => (h.undo(), a.flush(), toB()),
  };
}

describe('P6 — a coalesced entry is the per-path NET change, with presence (astra r3 D1/D2)', () => {
  const window = () => {
    let t = 0;
    return { coalesce: { ms: 1000, samePath: false }, now: () => t++ };
  };

  it('[PIN D1] {} →(local) {x:1} →(local) {} →(remote) {x:9}: the run adds then deletes x, net nothing, so no entry; undo leaves {x:9}', () => {
    const r = recordRig({}, window());
    r.mine({ x: 1 });
    r.mine({});
    expect(r.h.canUndo()).toBe(false);
    r.theirs({ x: 9 });
    r.undo();
    expect(r.sa()).toEqual({ x: 9 });
  });

  it('[PIN D2] {x:[0,1], y:0} →(local) {x:[2,1], y:1} →(local) {x:[0,1], y:1} →(remote) {x:[1,0], y:1}: x has no net change and leaves the entry; undo ⇒ {x:[1,0], y:0}', () => {
    const r = recordRig({ x: [0, 1], y: 0 }, window());
    r.mine({ x: [2, 1], y: 1 });
    r.mine({ x: [0, 1], y: 1 });
    r.theirs({ x: [1, 0], y: 1 });
    r.undo();
    expect(r.sa()).toEqual({ x: [1, 0], y: 0 });
  });

  it('[PIN D delete/set] {x:1} →(local) {} →(local) {x:2}: one entry x 1→2; undo restores 1', () => {
    const r = recordRig({ x: 1 }, window());
    r.mine({});
    r.mine({ x: 2 });
    r.undo();
    expect(r.sa()).toEqual({ x: 1 });
    expect(r.h.canUndo()).toBe(false);
  });
});

describe('P6 — keyed pairs with no ancestor, SameValueZero identities, holes (astra r3 A1/A3, law amendment 1)', () => {
  /** Item bodies across the domain: undefined, null, scalars, nested arrays, records. */
  const bodyArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.nat(2),
    fc.array(fc.nat(2), { maxLength: 2 }),
    elementArb,
  );
  const bodiesArb = fc.array(bodyArb, { maxLength: 5 });

  it(`[PROVEN→impl] keyedArray ≡ keyedArrayRef over undefined / null / nested-array / record bodies, by idOf and by ONE shared identity (${NUM_RUNS} runs each)`, () => {
    const one = keyedArray(() => 'x');
    const oneRef = keyedArrayWith(() => 'x');
    fc.assert(
      fc.property(bodiesArb, bodiesArb, bodiesArb, (a, m, t) => {
        expectSame(keyedProd(a, m, t), keyedArrayRef(a, m, t));
        expectSame(one(a, m, t, { path: [] }), oneRef(a, m, t));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[PIN K5 undefined addition] keyedArray(() => 'x')([], [undefined], [5]) ⇒ [undefined]: an addition on both sides is mine's body, never a merge against `undefined`", () => {
    expect(keyedArray(() => 'x')([], [undefined], [5], { path: [] })).toEqual([
      undefined,
    ]);
  });

  it('[PIN K5 NaN identity] identity () => NaN: anc [], mine [1], theirs [2] ⇒ [1] (one identity, the additions pair)', () => {
    expect(keyedArray(() => NaN)([], [1], [2], { path: [] })).toEqual([1]);
  });

  it('[PIN K4′ holes] positional and undoMerge visit holes: anc [undefined], mine new Array(1), theirs [1] ⇒ [1] with index 0 present, as with a dense mine', () => {
    const ctx = { path: [] };
    expect(positional([undefined], [undefined], [1], ctx)).toEqual([1]);
    const out = positional([undefined], new Array(1), [1], ctx) as unknown[];
    expect(out).toEqual([1]);
    expect(0 in out).toBe(true);
    const sparse = positional([0], new Array(1), [0], ctx) as unknown[];
    expect(0 in sparse).toBe(true); // nothing to merge, but the output is still dense
    expectSame(
      positional([undefined], new Array(1), [1], ctx),
      positionalRef([undefined], new Array(1), [1]),
    );
    const u = undoMerge(
      [undefined],
      new Array(1),
      [undefined],
      ctx,
    ) as unknown[];
    expect(0 in u).toBe(true);
  });
});

describe('P6 — opaque values are atomic leaves (astra r3 A2)', () => {
  it('[PIN A2 equality] two separately allocated opaque({x:0}) are not structEq; one instance is', () => {
    const o = opaque({ x: 0 });
    expect(prodStructEq(opaque({ x: 0 }), opaque({ x: 0 }))).toBe(false);
    expect(prodStructEq(o, o)).toBe(true);
    expect(prodStructEq([opaque({ x: 0 })], [opaque({ x: 0 })])).toBe(false);
  });

  it('[PIN A2 merge3] merge3(opaque{x:0}, opaque{x:0}′, 5) ⇒ mine (reference only: mine changed); three distinct opaque records never merge key-wise (mine, still opaque)', () => {
    const mine = opaque({ x: 0 });
    expect(merge3<unknown>(opaque({ x: 0 }), mine, 5)).toBe(mine);
    const m = opaque({ x: 1, y: 0 });
    const out = merge3<unknown>(
      opaque({ x: 0, y: 0 }),
      m,
      opaque({ x: 0, y: 2 }),
    );
    expect(out).toBe(m);
    expect(isOpaque(out)).toBe(true);
    const nested = merge3<Rec>(
      { c: opaque({ x: 0, y: 0 }) },
      { c: m },
      { c: opaque({ x: 0, y: 2 }) },
    );
    expect(nested['c']).toBe(m);
  });

  it('[PIN A2 keyed item] the keyedArray merge policy merges opaque items as leaves: mine, still opaque', () => {
    const anc = opaque({ id: 'a', x: 0, y: 0 });
    const m = opaque({ id: 'a', x: 1, y: 0 });
    const t = opaque({ id: 'a', x: 0, y: 2 });
    const out = keyedArray((i) => (i as Rec)['id'])([anc], [m], [t], {
      path: [],
    }) as unknown[];
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(m);
    expect(isOpaque(out[0])).toBe(true);
  });
});

// =============================================================================================
// IMPL P7 — astra r4: a history entry is a pair of roots (overlap), presence-aware rebaseOps,
// and the cheap items of the manual list
// =============================================================================================

describe('P7 — a history entry is the pair of roots before and after the run (charter §16.1)', () => {
  const window = () => {
    let t = 0;
    return { coalesce: { ms: 1000, samePath: false }, now: () => t++ };
  };

  it('[PIN overlap 1] {a:{x:0}} →(local) {a:1} →(local) {a:{x:2}} →(local) {a:{x:0}} →(remote) {a:{x:9}}: the run changed nothing (parent and child writes alike), no entry; undo keeps {a:{x:9}}', () => {
    const r = recordRig({ a: { x: 0 } }, window());
    r.mine({ a: 1 });
    r.mine({ a: { x: 2 } });
    r.mine({ a: { x: 0 } });
    expect(r.h.canUndo()).toBe(false);
    r.theirs({ a: { x: 9 } });
    r.undo();
    expect(r.sa()).toEqual({ a: { x: 9 } });
  });

  it('[PIN overlap 2] {} →(local) {a:{x:1}} →(local) {a:{x:2}} →(local) {} →(remote) {a:{x:9}}: one continuous run (the child write continues the parent write), net nothing; undo keeps {a:{x:9}}', () => {
    const r = recordRig({}, window());
    r.mine({ a: { x: 1 } });
    r.mine({ a: { x: 2 } });
    r.mine({});
    expect(r.h.canUndo()).toBe(false);
    r.theirs({ a: { x: 9 } });
    r.undo();
    expect(r.sa()).toEqual({ a: { x: 9 } });
  });

  it('[PIN remote elsewhere] I type a.x 0→1→2 while a peer writes z: the run stays ONE entry and its net is only a.x; undo ⇒ {a:{x:0}, z:5}, nothing left to undo', () => {
    const r = recordRig({ a: { x: 0 }, z: 0 }, window());
    r.mine({ a: { x: 1 }, z: 0 });
    r.theirs({ a: { x: 1 }, z: 5 });
    r.mine({ ...r.sa(), a: { x: 2 } });
    r.undo();
    expect(r.sa()).toEqual({ a: { x: 0 }, z: 5 });
    expect(r.h.canUndo()).toBe(false);
  });

  /** A record-of-arrays document and one local write over it. */
  const docArb = fc.record({
    a: scalarArrayArb,
    b: fc.record({ x: fc.nat(2), y: fc.nat(2) }, { requiredKeys: ['x'] }),
  });
  const stepArb = fc.record({
    kind: fc.nat(5),
    edits: writerEditsArb(),
    v: fc.nat(2),
  });
  const step = (
    doc: Rec,
    s: { kind: number; edits: readonly Edit[]; v: number },
  ): Rec => {
    const b = doc['b'] as Rec | number | undefined;
    switch (s.kind) {
      case 0:
        return { ...doc, a: applyEdits(doc['a'] as unknown[], s.edits) };
      case 1:
        return { ...doc, b: isPlainRec(b) ? { ...b, x: s.v } : { x: s.v } };
      case 2: {
        if (!isPlainRec(b)) return { ...doc, b: { x: 0 } };
        const rest: Rec = { ...b };
        delete rest['y'];
        return { ...doc, b: Object.hasOwn(b, 'y') ? rest : { ...b, y: s.v } };
      }
      case 3:
        return { ...doc, b: s.v }; // parent replaced by a leaf
      case 4: {
        const rest: Rec = { ...doc };
        delete rest['c'];
        return Object.hasOwn(doc, 'c') ? rest : { ...doc, c: [s.v] };
      }
      default:
        return { ...doc, b: { x: s.v, y: s.v } }; // parent replaced by a record
    }
  };

  it("[PROVEN→impl] local-only coalesced runs over a record-of-arrays doc: the net holds no op at an unchanged path, undo restores the run's first root exactly, and a run that ends where it started leaves nothing to undo (100 runs)", () => {
    fc.assert(
      fc.property(
        docArb,
        fc.array(stepArb, { minLength: 1, maxLength: 6 }),
        (doc0, steps) => {
          const r = recordRig(doc0 as Rec, window());
          let doc = doc0 as Rec;
          for (const s of steps) {
            doc = step(doc, s);
            r.mine(doc);
          }
          // the entry's net is this unit diff of its two roots (before = doc0, after = the final
          // doc, local-only): it must hold no op at a path whose value is unchanged
          const net = diffOps(doc0, r.sa(), { arrays: 'unit' });
          const at = (root: unknown, path: readonly Key[]): unknown[] => {
            let cur = root;
            for (const seg of path) {
              if (
                cur === null ||
                typeof cur !== 'object' ||
                !Object.hasOwn(cur, seg)
              )
                return [];
              cur = (cur as Record<Key, unknown>)[seg];
            }
            return [cur];
          };
          for (const op of net)
            expect(
              structEq(at(doc0, op.path), at(r.sa(), op.path)),
              JSON.stringify(op.path),
            ).toBe(false);
          expect(r.h.canUndo()).toBe(net.length > 0);
          r.undo();
          expect(structEq(r.sa(), doc0)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('P7 — rebaseOps tells a present `undefined` from an absent key (charter §16.2)', () => {
  it('[PIN G2 present undefined] pending a: 0→1 over remote a: 0→undefined with `preserve` at a ⇒ preserve(0, 1, undefined), and the rebased op carries an OWN prev: undefined', () => {
    const out = rebaseOps(
      { a: 1 },
      [[{ kind: 'set', path: ['a'], prev: 0, next: 1 }]],
      [{ kind: 'set', path: ['a'], prev: 0, next: undefined }],
      [{ path: 'a', merge: preserve }],
    );
    const a = (out.root as Rec)['a'];
    expect(isConflicted(a)).toBe(true);
    expect(a).toMatchObject({ mine: 1, theirs: undefined, ancestor: 0 });
    const op = out.pending[0][0];
    expect(Object.hasOwn(op, 'prev')).toBe(true);
    expect((op as { prev?: unknown }).prev).toBeUndefined();
    // an absent key is still an add: no prev
    const add = rebaseOps(
      { a: 1 },
      [[{ kind: 'set', path: ['a'], prev: 0, next: 1 }]],
      [{ kind: 'delete', path: ['a'], prev: 0 }],
    ).pending[0][0];
    expect(Object.hasOwn(add, 'prev')).toBe(false);
  });
});

describe('P7 — manual-list items pinned (charter §16.4)', () => {
  it('[PIN N1 hydrate deleted parent + pending] registers: root {a:{x:0}, k:1}, a concurrent delete of `a` (HLC 20) and edit of a.x (HLC 10): the edit is suppressed under the deleted parent; the pending write lands on top', () => {
    const conv = createConvergingApply();
    conv.ingest(
      envelope('BASE', 1, [
        {
          kind: 'set',
          path: [],
          next: { a: { x: 0 }, k: 1 },
          cites: [],
          epoch: 0,
        },
      ]),
    );
    conv.ingest(
      envelope('D', 20, [
        { kind: 'delete', path: ['a'], prev: { x: 0 }, cites: [], epoch: 0 },
      ]),
    );
    conv.ingest(
      envelope('E', 10, [
        {
          kind: 'set',
          path: ['a', 'x'],
          prev: 0,
          next: 1,
          cites: [],
          epoch: 0,
        },
      ]),
    );
    const { source, sync } = syncOf({});
    const pending = {
      ...envelope('me', 30, [
        { kind: 'set', path: ['p'], next: 1, cites: [], epoch: 0 },
      ]),
      version: 1,
    };
    sync.hydrate(
      {
        proto: OP_PROTO_VERSION,
        root: { a: { x: 1 }, k: 1 },
        registers: conv.checkpoint(),
        wm: { BASE: 1, D: 1, E: 1 },
      },
      [pending],
    );
    expect(source()).toEqual({ k: 1, p: 1 });
  });

  it('[PIN explicit-policy undo + redo, both peers] explicit `lww`: undo restores [5,6] whole and redo returns to [5,2] on both peers; the `keyedArray` merge policy: undo and redo of my reorder agree on both peers', () => {
    const r = undoRig([5, 6], { policies: [{ path: 'todos', merge: lww }] });
    r.mine([1, 6]);
    r.theirs([5, 2]);
    r.sync();
    r.undo();
    expect([r.a(), r.b()]).toEqual([
      [5, 6],
      [5, 6],
    ]);
    r.redo();
    expect([r.a(), r.b()]).toEqual([
      [5, 2],
      [5, 2],
    ]);
    const a0 = { id: 'a', v: 0 };
    const b0 = { id: 'b', v: 0 };
    const b1 = { id: 'b', v: 1 };
    const k = undoRig([a0, b0], {
      policies: [{ path: 'todos', merge: keyedArray((x) => (x as Rec)['id']) }],
    });
    k.mine([b0, a0]);
    k.theirs(
      (cur) => cur.map((x) => ((x as Rec)['id'] === 'b' ? b1 : x)),
      true,
    );
    k.sync();
    k.undo();
    expect([k.a(), k.b()]).toEqual([
      [a0, b1],
      [a0, b1],
    ]);
    k.redo();
    expect([k.a(), k.b()]).toEqual([
      [b1, a0],
      [b1, a0],
    ]);
  });
});

// =============================================================================================
// IMPL P8 — astra r5: a batch carries the root it produced, out of band (charter §17.1)
// =============================================================================================

/**
 * Two peers on the DEFAULT (effect) driver, A's history tracking A's sync. Nothing flushes A's
 * writes by hand: `receive` flushes a pending local write while receiving, which DEFERS its
 * envelope's notification past the remote fold.
 */
function defaultDriverRig(
  root: Rec,
  opt?: { coalesce?: { ms: number; samePath?: boolean }; now?: () => number },
) {
  return TestBed.runInInjectionContext(() => {
    const sa = store<Rec>(root);
    const sb = store<Rec>(root);
    const a = opSync(sa, {
      writer: 'wa',
      origin: 'oa',
      clock: createHlcClock(() => 1),
    });
    const b = opSync(sb, {
      writer: 'wb',
      origin: 'ob',
      clock: createHlcClock(() => 2),
    });
    const aOut: OpEnvelope[] = [];
    const bOut: OpEnvelope[] = [];
    a.subscribe((e) => aOut.push(e));
    b.subscribe((e) => bOut.push(e));
    const toB = () => (a.flush(), aOut.splice(0).forEach((e) => b.receive(e)));
    const toA = () => (b.flush(), bOut.splice(0).forEach((e) => a.receive(e)));
    a.seed();
    toB();
    const h = storeHistory(sa, {
      track: a,
      coalesce: opt?.coalesce,
      now: opt?.now,
    });
    return { sa, sb, a, b, h, toA, toB };
  });
}

describe('P8 — history records the root a change produced, not the store at delivery (astra r5 P1)', () => {
  it("[PIN deferred delivery] default driver, initial A write unflushed: A writes [1,0], B's [0,2] is received (A's envelope is deferred), store [1,2]; undo ⇒ {arr:[0,2]}, redo ⇒ [1,2]; B equal after delivery", () => {
    const r = defaultDriverRig({ arr: [0, 0] });
    r.sa.set({ arr: [1, 0] }); // not flushed
    r.sb.set({ arr: [0, 2] });
    r.toA(); // A.receive flushes A's write under `receiving`: its notification is deferred
    expect(r.sa()).toEqual({ arr: [1, 2] });
    r.h.undo();
    expect(r.sa()).toEqual({ arr: [0, 2] });
    r.toB();
    expect(r.sb()).toEqual({ arr: [0, 2] });
    r.h.redo();
    expect(r.sa()).toEqual({ arr: [1, 2] });
    r.toB();
    expect(r.sb()).toEqual({ arr: [1, 2] });
  });

  it('[PIN deferred remote field] default driver, initial A write unflushed (later steps flush explicitly): a remote-only field k present during the deferral never enters the entry: a coalesced follow-up write to k starts a NEW entry (k was not mine), so one undo reverts k only', () => {
    let t = 0;
    const r = defaultDriverRig(
      { arr: [0, 0], k: 0 },
      { coalesce: { ms: 1000, samePath: false }, now: () => t++ },
    );
    r.sa.set({ arr: [1, 0], k: 0 }); // not flushed
    r.sb.set({ arr: [0, 0], k: 5 });
    r.toA();
    expect(r.sa()).toEqual({ arr: [1, 0], k: 5 });
    r.a.flush(); // deliver the deferred envelope now, while the store already holds k: 5
    r.sa.set({ ...r.sa(), k: 6 });
    r.a.flush();
    r.h.undo();
    expect(r.sa()).toEqual({ arr: [1, 0], k: 5 }); // only my k write
    expect(r.h.canUndo()).toBe(true);
    r.h.undo();
    expect(r.sa()).toEqual({ arr: [0, 0], k: 5 });
  });

  it('[PIN scoped commit seam] default driver, initial A write (the fork commit) unflushed: a fork commit is reconciled before it is delivered: the entry is the EMITTED change ([0,2] → [1,0]), not the reconciled [1,2]; after B moves slot 1 to 3, undo ⇒ [0,2] (my emitted slot-1 write is undone), where the reconciled root would give [0,3]', () => {
    const r = defaultDriverRig({ arr: [0, 0] });
    const fk = TestBed.runInInjectionContext(() =>
      syncedFork(r.a, r.sa as never),
    );
    r.sb.set({ arr: [0, 2] });
    r.toA();
    (fk.store as unknown as { set(v: Rec): void }).set({ arr: [1, 0] });
    fk.commit();
    r.a.flush();
    expect(r.sa()).toEqual({ arr: [1, 2] }); // reconciled ≠ emitted [1,0]
    r.toB();
    r.sb.set({ arr: [1, 3] });
    r.toA();
    expect(r.sa()).toEqual({ arr: [1, 3] });
    r.h.undo();
    expect(r.sa()).toEqual({ arr: [0, 2] });
  });
});

// =============================================================================================
// IMPL P9 — astra r6: the outbox drains in place, never from a spliced copy (charter §18.1)
// =============================================================================================

/**
 * Queues two deferred A envelopes on the default driver: E1 `x 0→1`, E2 `x 1→2`. Each A write is
 * left unflushed, then flushed by `receive` (under `receiving`) of a B write that touches `y` only.
 */
function twoDeferred() {
  const r = defaultDriverRig({ x: 0, y: 0 });
  r.sa.set({ ...r.sa(), x: 1 }); // not flushed
  r.sb.set({ ...r.sb(), y: 1 });
  r.toA(); // E1 queued
  r.sa.set({ ...r.sa(), x: 2 }); // not flushed
  r.sb.set({ ...r.sb(), y: 2 });
  r.toA(); // E2 queued behind E1
  expect(r.sa()).toEqual({ x: 2, y: 2 });
  return r;
}

/** `path=next` of every set op in an envelope (the change it delivers). */
const sets = (env: OpEnvelope): string[] =>
  env.ops.flatMap((o) =>
    o.kind === 'set' ? [`${o.path.join('.')}=${String(o.next)}`] : [],
  );

describe('P9 — the outbox drains in place (astra r6 P2)', () => {
  it('[PIN nested flush undo] history subscribes first; a one-shot subscriber undoes on E1: the nested flush delivers E2 first, so undo takes back E2 (x 1), and a second undo takes back E1 (x 0)', () => {
    const r = twoDeferred();
    const off = r.a.subscribe(() => {
      off();
      r.h.undo();
    });
    r.a.flush();
    expect(r.sa()).toEqual({ x: 1, y: 2 });
    expect(r.h.canUndo()).toBe(true);
    r.h.undo();
    expect(r.sa()).toEqual({ x: 0, y: 2 });
  });

  it('[PIN mid-drain write order] a subscriber writes z on E1 and flushes it: delivery order is E1, E2, then the z envelope', () => {
    const r = twoDeferred();
    const seen: string[][] = [];
    r.a.subscribe((e) => seen.push(sets(e)));
    const off = r.a.subscribe(() => {
      off();
      r.sa.set({ ...r.sa(), z: 1 });
      r.a.flush();
    });
    r.a.flush();
    expect(seen).toEqual([['x=1'], ['x=2'], ['z=1']]);
  });

  it('[PIN mid-drain write queues] a subscriber emits a z write on E1 without draining (override): it queues behind E2 (the outbox branch of emitLocal), delivery order E1, E2, z', () => {
    const r = twoDeferred();
    const seen: string[][] = [];
    r.a.subscribe((e) => seen.push(sets(e)));
    const off = r.a.subscribe(() => {
      off();
      r.a.override(() => r.sa.set({ ...r.sa(), z: 1 }));
    });
    r.a.flush();
    expect(seen).toEqual([['x=1'], ['x=2'], ['z=1']]);
  });
});
