import { signal } from '@angular/core';
import {
  applyOps,
  diffOps,
  invertBatch,
  opLog,
  type AddedPolicy,
  type OpLogDriver,
  type StoreOp,
} from './op-log';
import { opSync } from './op-sync';
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

// ---- Round 2: the per-path `added` predicate --------------------------------------------------

/** A verifier-owned oracle for policy emission, written from the ruling's prose. */
function oracleDiff(
  prev: unknown,
  next: unknown,
  policy: AddedPolicy,
): StoreOp[] {
  const ops: StoreOp[] = [];
  const decide = (path: readonly Key[], v: unknown) =>
    typeof policy === 'function' ? policy(path, v) : policy;
  const add = (v: unknown, path: readonly Key[]): void => {
    if (isPlainRecord(v) && decide(path, v) === 'leaves') {
      ops.push({ kind: 'set', path, next: {} });
      for (const k of Object.keys(v)) add(v[k], [...path, k]);
    } else ops.push({ kind: 'set', path, next: v });
  };
  const walk = (p: unknown, n: unknown, path: readonly Key[]): void => {
    if (Object.is(p, n)) return;
    if (isPlainRecord(p) && isPlainRecord(n)) {
      for (const k of Object.keys(p))
        if (!Object.hasOwn(n, k))
          ops.push({ kind: 'delete', path: [...path, k], prev: p[k] });
      for (const k of Object.keys(n)) {
        if (!Object.hasOwn(p, k)) add(n[k], [...path, k]);
        else walk(p[k], n[k], [...path, k]);
      }
      return;
    }
    if (isPlainList(p) && isPlainList(n) && p.length === n.length) {
      for (let i = 0; i < n.length; i++) walk(p[i], n[i], [...path, i]);
      return;
    }
    ops.push({ kind: 'set', path, prev: p, next: n });
  };
  walk(prev, next, []);
  return ops;
}

const pathHash = (path: readonly Key[], salt: number): number => {
  let h = salt | 0;
  for (const ch of JSON.stringify(path))
    h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h >>> 0;
};

/** The predicate families every property runs over. */
const POLICIES: readonly {
  name: string;
  policy: (seed: number) => AddedPolicy;
}[] = [
  {
    name: 'leafy at depth <= 1, whole below',
    policy: () => (p) => (p.length <= 1 ? 'leaves' : 'whole'),
  },
  {
    name: 'leafy at depth <= 2, whole below',
    policy: () => (p) => (p.length <= 2 ? 'leaves' : 'whole'),
  },
  {
    name: 'whole at depth 1, leafy below',
    policy: () => (p) => (p.length <= 1 ? 'whole' : 'leaves'),
  },
  {
    name: 'per-path hash',
    policy: (seed) => (p) => (pathHash(p, seed) % 2 ? 'leaves' : 'whole'),
  },
  { name: 'always leaves (fn)', policy: () => () => 'leaves' },
  { name: 'always whole (fn)', policy: () => () => 'whole' },
];

/** The studio policy, verbatim from the ruling: leafy collections, atomic entries. */
const LEAFY = new Set([
  JSON.stringify(['lint']),
  JSON.stringify(['lint', 'rules']),
  JSON.stringify(['lint', 'suppress']),
]);
const studioPolicy: AddedPolicy = (path) =>
  LEAFY.has(JSON.stringify(path)) ? 'leaves' : 'whole';

describe('M1b diffOps(prev, next, { added: predicate }) — policy properties', () => {
  for (const { name, policy } of POLICIES) {
    it(`P0 emission = the oracle; P1 exact round-trip; invert restores — ${name} (${SEEDS} seeds)`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { prev, next } = genPair(seed);
        const pol = policy(seed);
        const ops = diffOps(prev, next, { added: pol });
        expect(ops, `seed ${seed}`).toStrictEqual(oracleDiff(prev, next, pol));
        const applied = applyOps(prev, ops);
        expect(applied, `seed ${seed}`).toStrictEqual(next);
        expect(
          applyOps(applied, invertBatch(ops)),
          `seed ${seed}`,
        ).toStrictEqual(prev);
      }
    });

    it(`P3/P4 a non-empty record add is whole only where the predicate said so; arrays stay one op — ${name} (${SEEDS} seeds)`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { prev, next } = genPair(seed);
        const pol = policy(seed) as (
          p: readonly Key[],
          v: unknown,
        ) => 'whole' | 'leaves';
        const ops = diffOps(prev, next, { added: pol });
        for (const op of ops) {
          if (op.kind !== 'set' || resolve(prev, op.path) !== MISSING) continue;
          if (isPlainRecord(op.next) && Object.keys(op.next).length)
            expect(
              pol(op.path, op.next),
              `seed ${seed} ${JSON.stringify(op.path)}`,
            ).toBe('whole');
          if (isPlainList(op.next)) {
            const under = ops.filter(
              (o) =>
                o.path.length > op.path.length &&
                op.path.every((x, i) => o.path[i] === x),
            );
            expect(
              under,
              `seed ${seed} ${JSON.stringify(op.path)}`,
            ).toHaveLength(0);
          }
        }
      }
    });
  }

  it(`the predicate is asked exactly for added plain records, with the added record itself (${SEEDS} seeds)`, () => {
    let calls = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const asked: { path: readonly Key[]; value: unknown }[] = [];
      diffOps(prev, next, {
        added: (path, value) => {
          asked.push({ path, value });
          return pathHash(path, seed) % 2 ? 'leaves' : 'whole';
        },
      });
      const expected: string[] = [];
      oracleDiff(prev, next, (path, value) => {
        expected.push(JSON.stringify(path));
        void value;
        return pathHash(path, seed) % 2 ? 'leaves' : 'whole';
      });
      expect(
        asked.map((a) => JSON.stringify(a.path)),
        `seed ${seed}`,
      ).toEqual(expected);
      for (const a of asked) {
        expect(isPlainRecord(a.value)).toBe(true);
        expect(a.value, `seed ${seed}`).toBe(resolve(next, a.path)); // the record itself, by reference
      }
      calls += asked.length;
    }
    expect(calls).toBeGreaterThan(SEEDS);
  });

  it(`P2 'whole' in every form and an absent option are the frozen base diff (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      const base = referenceWholeDiff(prev, next);
      expect(
        diffOps(prev, next, { added: () => 'whole' }),
        `seed ${seed}`,
      ).toStrictEqual(base);
      expect(
        diffOps(prev, next, { added: 'whole' }),
        `seed ${seed}`,
      ).toStrictEqual(base);
    }
  });

  it('witness: an added collection with two entries = [anchor, entry1 whole, entry2 whole], key order; round-trip; undo cleans up', () => {
    const e1 = { rule: 'r1', path: ['a'], reason: 'x', by: 'u', at: 1 };
    const e2 = { rule: 'r2', path: ['b'], reason: 'y', by: 'v', at: 2 };
    const prev = { lint: {} };
    const next = { lint: { suppress: { k2: e2, k1: e1 } } };
    const ops = diffOps(prev, next, { added: studioPolicy });
    expect(ops).toStrictEqual<StoreOp[]>([
      { kind: 'set', path: ['lint', 'suppress'], next: {} },
      { kind: 'set', path: ['lint', 'suppress', 'k2'], next: e2 },
      { kind: 'set', path: ['lint', 'suppress', 'k1'], next: e1 },
    ]);
    expect(applyOps(prev, ops)).toStrictEqual(next);
    expect(applyOps(next, invertBatch(ops))).toStrictEqual(prev);
    // on a missing `lint`: two anchors, then the entries
    expect(diffOps({}, next, { added: studioPolicy })).toStrictEqual<StoreOp[]>(
      [
        { kind: 'set', path: ['lint'], next: {} },
        { kind: 'set', path: ['lint', 'suppress'], next: {} },
        { kind: 'set', path: ['lint', 'suppress', 'k2'], next: e2 },
        { kind: 'set', path: ['lint', 'suppress', 'k1'], next: e1 },
      ],
    );
    const fromEmpty = diffOps({}, next, { added: studioPolicy });
    expect(applyOps({}, fromEmpty)).toStrictEqual(next);
    expect(applyOps(next, invertBatch(fromEmpty))).toStrictEqual({});
  });
});

describe('M1c the emission seam: opLog / opSync `emit` (absent ⇒ byte-identical)', () => {
  const manual: OpLogDriver = (run) => {
    run();
    return { destroy: () => undefined };
  };
  const emitted = (
    prev: object,
    next: object,
    emit?: { added: AddedPolicy },
  ) => {
    const s = signal<object>(prev);
    const log = opLog(s, { driver: manual, ...(emit ? { emit } : {}) });
    const out: StoreOp[][] = [];
    log.subscribe((b) => out.push([...b.ops]));
    s.set(next);
    log.flush();
    log.destroy();
    return out.flat();
  };

  it(`opLog without \`emit\` emits the frozen base diff; with \`emit\` it emits diffOps(…, emit) (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { prev, next } = genPair(seed);
      expect(emitted(prev, next), `seed ${seed}`).toStrictEqual(
        referenceWholeDiff(prev, next),
      );
      const pol: AddedPolicy = (p) =>
        pathHash(p, seed) % 2 ? 'leaves' : 'whole';
      expect(emitted(prev, next, { added: pol }), `seed ${seed}`).toStrictEqual(
        diffOps(prev, next, { added: pol }),
      );
    }
  });

  it('opSync forwards `emit` to its log: a first suppressor on a missing `lint` ships anchors + ONE entry set', () => {
    const s = signal<Record<string, unknown>>({});
    const sync = opSync(s, {
      writer: 'w',
      driver: manual,
      emit: { added: studioPolicy },
    });
    const envs: StoreOp[][] = [];
    sync.subscribe((e) =>
      envs.push(
        e.ops.map(({ kind, path, ...rest }) => {
          const { cites, epoch, ...op } = rest as {
            cites: unknown;
            epoch: unknown;
          } & Record<string, unknown>;
          void cites;
          void epoch;
          return { kind, path, ...op } as StoreOp;
        }),
      ),
    );
    const entry = { rule: 'r', path: ['x'], reason: 'why', by: 'me', at: 1 };
    s.set({ lint: { suppress: { k: entry } } });
    sync.flush();
    expect(envs).toStrictEqual([
      [
        { kind: 'set', path: ['lint'], next: {} },
        { kind: 'set', path: ['lint', 'suppress'], next: {} },
        { kind: 'set', path: ['lint', 'suppress', 'k'], next: entry },
      ],
    ]);
    sync.destroy();
    // and without `emit`: one whole set, as before
    const t = signal<Record<string, unknown>>({});
    const plain = opSync(t, { writer: 'w', driver: manual });
    const raw: unknown[] = [];
    plain.subscribe((e) => raw.push(e.ops.map((o) => o.path)));
    t.set({ lint: { suppress: { k: entry } } });
    plain.flush();
    expect(raw).toEqual([[['lint']]]);
    plain.destroy();
  });
});
