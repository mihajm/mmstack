import { applyOps, diffOps, invertBatch, type StoreOp } from './op-log';
import { isOpaque, opaque } from './opaque';

// M1: the leaf-wise emission model. The oracle below is written from the semantics, not from
// `diffNode`: a generator of copy-on-write edits, a path resolver and a structural walk. The
// properties hold over SEEDS seeded runs; every failure message names its seed.

type Key = string | number;

const SEEDS = 300;

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Rnd = () => number;
const pick = <T>(r: Rnd, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];

const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && !isMarkedOpaque(v);
};
const isMarkedOpaque = (v: object): boolean => isOpaque(v);
const isPlainList = (v: unknown): v is unknown[] =>
  Array.isArray(v) && !isMarkedOpaque(v);

const KEYS = ['a', 'b', 'c', 'd', 'e'];

function genLeaf(r: Rnd): unknown {
  const roll = r();
  if (roll < 0.3) return Math.floor(r() * 10);
  if (roll < 0.5) return pick(r, ['x', 'y', '']);
  if (roll < 0.6) return null;
  if (roll < 0.7) return r() < 0.5;
  if (roll < 0.8) return opaque({ blob: Math.floor(r() * 3) });
  return Math.floor(r() * 100) / 7;
}

function genValue(r: Rnd, depth: number): unknown {
  const roll = r();
  if (depth <= 0 || roll < 0.35) return genLeaf(r);
  if (roll < 0.5) {
    const n = Math.floor(r() * 3);
    return Array.from({ length: n }, () =>
      r() < 0.3 ? genRecord(r, depth - 1) : genLeaf(r),
    );
  }
  return genRecord(r, depth - 1);
}

function genRecord(r: Rnd, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = Math.floor(r() * 4); // 0..3 keys: empty records are generated on purpose
  for (let i = 0; i < n; i++) out[pick(r, KEYS)] = genValue(r, depth);
  return out;
}

/** A copy-on-write edit: untouched subtrees keep their reference (the store contract). */
function mutate(v: unknown, r: Rnd, depth: number): unknown {
  if (isPlainRecord(v)) {
    const copy: Record<string, unknown> = { ...v };
    const edits = 1 + Math.floor(r() * 3);
    for (let i = 0; i < edits; i++) {
      const key = pick(r, KEYS);
      const roll = r();
      if (!Object.hasOwn(copy, key)) {
        copy[key] = roll < 0.6 ? genRecord(r, 3) : genValue(r, 3); // ADDED (records favoured)
      } else if (roll < 0.2) {
        delete copy[key];
      } else if (roll < 0.35) {
        copy[key] = genLeaf(r); // replace / type change at an existing slot
      } else if (roll < 0.45) {
        copy[key] = genRecord(r, 2); // a record replacing whatever existed (prev present)
      } else if (depth > 0) {
        copy[key] = mutate(copy[key], r, depth - 1);
      }
    }
    return copy;
  }
  if (isPlainList(v)) {
    const roll = r();
    if (roll < 0.3) return [...v, genValue(r, 2)]; // length change
    if (roll < 0.4 && v.length) return v.slice(1);
    if (!v.length) return [genLeaf(r)];
    const copy = v.slice();
    const i = Math.floor(r() * copy.length);
    copy[i] = depth > 0 ? mutate(copy[i], r, depth - 1) : genLeaf(r);
    return copy;
  }
  return r() < 0.5 ? genLeaf(r) : genRecord(r, 2);
}

function genPair(seed: number): {
  prev: Record<string, unknown>;
  next: Record<string, unknown>;
} {
  const r = mulberry32(seed * 2654435761);
  const prev = genRecord(r, 3);
  let next: unknown = prev;
  const rounds = 1 + Math.floor(r() * 3);
  for (let i = 0; i < rounds; i++) next = mutate(next, r, 3);
  return { prev, next: next as Record<string, unknown> };
}

const MISSING = Symbol('missing');
function resolve(root: unknown, path: readonly Key[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (isPlainRecord(cur) || isPlainList(cur)) {
      if (!Object.hasOwn(cur, seg)) return MISSING;
      cur = (cur as Record<Key, unknown>)[seg];
    } else return MISSING;
  }
  return cur;
}

const leaves = (prev: unknown, next: unknown) =>
  diffOps(prev, next, { added: 'leaves' });

describe('M1 diffOps(prev, next, { added: "leaves" }) — model properties', () => {
  it(`P1 round-trip: applying the leaf-wise batch to prev yields next exactly (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      expect(applyOps(prev, leaves(prev, next)), `seed ${seed}`).toStrictEqual(
        next,
      );
    }
  });

  it(`P2 the default is untouched: no option ≡ { added: "whole" } ≡ the frozen pre-rider diff (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const base = referenceWholeDiff(prev, next);
      expect(diffOps(prev, next), `seed ${seed}`).toStrictEqual(base);
      expect(
        diffOps(prev, next, { added: 'whole' }),
        `seed ${seed}`,
      ).toStrictEqual(base);
      expect(diffOps(prev, next, {}), `seed ${seed}`).toStrictEqual(base);
    }
  });

  it(`P3 no container register: no set at a path absent in prev carries a non-empty plain record (${SEEDS} seeds)`, () => {
    let sawAdd = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      for (const op of leaves(prev, next)) {
        if (op.kind !== 'set' || resolve(prev, op.path) !== MISSING) continue;
        sawAdd++;
        const nonEmptyRecord =
          isPlainRecord(op.next) && Object.keys(op.next).length > 0;
        expect(
          nonEmptyRecord,
          `seed ${seed} path ${JSON.stringify(op.path)}`,
        ).toBe(false);
        expect(
          Object.hasOwn(op, 'prev'),
          `seed ${seed}: an add carries no prev`,
        ).toBe(false);
      }
    }
    expect(sawAdd).toBeGreaterThan(SEEDS); // the generator really adds
  });

  it(`P4 arrays stay whole: an added or length-changed array is exactly one op (${SEEDS} seeds)`, () => {
    let seen = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const ops = leaves(prev, next);
      for (const op of ops) {
        if (op.kind !== 'set' || !isPlainList(op.next)) continue;
        const before = resolve(prev, op.path);
        if (
          before !== MISSING &&
          isPlainList(before) &&
          before.length === op.next.length
        )
          continue;
        seen++;
        const under = ops.filter(
          (o) =>
            o.path.length >= op.path.length &&
            op.path.every((s, i) => o.path[i] === s),
        );
        expect(
          under,
          `seed ${seed} path ${JSON.stringify(op.path)}`,
        ).toHaveLength(1);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it(`P5 anchors precede content: every op at an absent path has its parent present in prev or anchored earlier in the batch (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const anchored = new Set<string>();
      for (const op of leaves(prev, next)) {
        if (resolve(prev, op.path) !== MISSING) continue;
        const parent = op.path.slice(0, -1);
        const ok =
          resolve(prev, parent) !== MISSING ||
          anchored.has(JSON.stringify(parent));
        expect(ok, `seed ${seed} path ${JSON.stringify(op.path)}`).toBe(true);
        if (op.kind === 'set' && isPlainRecord(op.next))
          anchored.add(JSON.stringify(op.path));
      }
    }
  });

  it(`invertBatch over a leaf-wise batch restores prev exactly (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const ops = leaves(prev, next);
      const applied = applyOps(prev, ops);
      expect(applyOps(applied, invertBatch(ops)), `seed ${seed}`).toStrictEqual(
        prev,
      );
    }
  });

  it('witness: an added nested record is anchors + leaves, path-ordered; undo removes all of it', () => {
    const prev = { keep: 1 };
    const next = { keep: 1, c: { k: 1, d: { e: [1, 2] }, empty: {} } };
    const ops = leaves(prev, next);
    expect(ops).toStrictEqual<StoreOp[]>([
      { kind: 'set', path: ['c'], next: {} },
      { kind: 'set', path: ['c', 'k'], next: 1 },
      { kind: 'set', path: ['c', 'd'], next: {} },
      { kind: 'set', path: ['c', 'd', 'e'], next: [1, 2] },
      { kind: 'set', path: ['c', 'empty'], next: {} },
    ]);
    expect(applyOps(prev, ops)).toStrictEqual(next);
    expect(applyOps(next, invertBatch(ops))).toStrictEqual(prev);
    // a record replacing an existing leaf slot stays one whole replace
    expect(leaves({ c: 1 }, { c: { k: 1 } })).toStrictEqual<StoreOp[]>([
      { kind: 'set', path: ['c'], prev: 1, next: { k: 1 } },
    ]);
  });
});

/**
 * The pre-rider `diffNode`, frozen verbatim in semantics (base `381c7141`, `op-log.ts:111-149`):
 * the P2 oracle that the default emission stays byte-identical.
 */
function referenceWholeDiff(prev: unknown, next: unknown): StoreOp[] {
  const ops: StoreOp[] = [];
  const walk = (p: unknown, n: unknown, path: readonly Key[]): void => {
    if (Object.is(p, n)) return;
    if (isPlainRecord(p) && isPlainRecord(n)) {
      for (const key of Object.keys(p))
        if (!Object.hasOwn(n, key))
          ops.push({ kind: 'delete', path: [...path, key], prev: p[key] });
      for (const key of Object.keys(n)) {
        if (!Object.hasOwn(p, key))
          ops.push({ kind: 'set', path: [...path, key], next: n[key] });
        else walk(p[key], n[key], [...path, key]);
      }
      return;
    }
    if (isPlainList(p) && isPlainList(n)) {
      if (p.length === n.length) {
        for (let i = 0; i < n.length; i++) walk(p[i], n[i], [...path, i]);
        return;
      }
      ops.push({ kind: 'set', path, prev: p, next: n });
      return;
    }
    ops.push({ kind: 'set', path, prev: p, next: n });
  };
  walk(prev, next, []);
  return ops;
}
