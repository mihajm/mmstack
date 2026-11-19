import { applyOps } from './op-log';
import {
  createConvergingApply,
  isConflicted,
  OP_PROTO_VERSION,
  preserve,
  wireValueViolation,
  type Dot,
  type MergePolicyEntry,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SyncOp,
} from './op-sync';

type P = (string | number)[];
const env = (ops: SyncOp[], origin: string, p: number): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: 'w-' + origin,
  version: 1,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});
const d = (origin: string, p: number): Dot => ({ origin, hlc: { p, l: 0 } });
const set = (path: P, next: unknown, cites: Dot[] = [], epoch = 0): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites,
  epoch,
});
const clear = (path: P, cites: Dot[], epoch = 0): SyncOp => ({
  kind: 'clear',
  path,
  cites,
  epoch,
});
const del = (path: P, cites: Dot[]): SyncOp => ({
  kind: 'delete',
  path,
  prev: undefined,
  cites,
  epoch: 0,
});

const split = (envs: OpEnvelope[]): OpEnvelope[] =>
  envs.flatMap((e) => e.ops.map((op) => ({ ...e, ops: [op] })));

// a seeded permutation family, so each scenario is checked in many delivery orders
const orders = <T>(xs: readonly T[], n = 12): T[][] => {
  const out: T[][] = [[...xs], [...xs].reverse()];
  let seed = 7;
  for (let k = 0; k < n; k++) {
    const c = [...xs];
    for (let i = c.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [c[i], c[j]] = [c[j], c[i]];
    }
    out.push(c);
  }
  return out;
};

function converge(
  envs: OpEnvelope[],
  policies: MergePolicyEntry[] = [],
  seedRoot: unknown = {},
): unknown {
  let first: unknown;
  for (const order of orders(envs)) {
    const conv = createConvergingApply({ policies });
    let root: unknown = seedRoot;
    for (const e of order) root = applyOps(root, conv.ingest(e));
    expect(root).toStrictEqual(conv.materialize());
    if (first === undefined) first = root;
    else expect(root).toStrictEqual(first);
  }
  return first;
}

describe('register materialization — an abstaining register falls back to its nearest contributing ancestor', () => {
  it('a clear that wins below a replace that lost at its own path shows the winner’s raw child (root ancestor)', () => {
    const root = converge(
      split([
        env([set([], { a: 'r1' }, [], 1)], 'o1', 1),
        env([set(['a'], 'edit')], 'o2', 2),
        env([set([], { a: 'r3' }), clear(['a'], [d('o2', 2)])], 'o3', 3),
      ]),
    );
    expect(root).toStrictEqual({ a: 'r1' });
  });

  it('skips an abstaining parent to reach a contributing grandparent', () => {
    const root = converge(
      split([
        env([set(['g'], { p: { c: 'raw' } }, [], 1)], 'o1', 1),
        env([set(['g', 'p'], { c: 'p2' })], 'o2', 2),
        env([set(['g', 'p', 'c'], 'c3')], 'o3', 3),
        env(
          [
            set(['g'], { p: { c: 'x' } }),
            clear(['g', 'p'], [d('o2', 2)]),
            clear(['g', 'p', 'c'], [d('o3', 3)]),
          ],
          'o4',
          4,
        ),
      ]),
    );
    expect(root).toStrictEqual({ g: { p: { c: 'raw' } } });
  });

  it('a subtree delete delivered before its clear leaves the key absent, never present-undefined', () => {
    const root = converge(
      split([
        env([set(['a'], { x: 1 })], 'o1', 1),
        env([set(['a', 'x'], 5)], 'o2', 2),
        env(
          [del(['a'], [d('o1', 1)]), clear(['a', 'x'], [d('o2', 2)])],
          'o3',
          3,
        ),
      ]),
    );
    expect(root).toStrictEqual({});
  });

  it('a deleted grandparent hides a live grandchild under a live parent', () => {
    const root = converge([
      env([set(['a', 'b'], { c: 0 })], 'o1', 1),
      env([set(['a', 'b', 'c'], 1)], 'o2', 2),
      env([del(['a'], [])], 'o3', 3),
    ]);
    expect(root).toStrictEqual({});
  });
});

describe('register materialization — vivify and reads', () => {
  it('a joiner deriving from registers alone vivifies a numeric segment as an array, like the incremental apply', () => {
    const conv = createConvergingApply();
    const root = applyOps(
      {},
      conv.ingest(env([set(['list', 0, 'name'], 'n')], 'o', 1)),
    );
    expect(Array.isArray((root as { list: unknown }).list)).toBe(true);
    const joiner = createConvergingApply();
    joiner.load(conv.checkpoint());
    expect(joiner.materialize()).toStrictEqual(root);
    expect(
      Array.isArray((joiner.materialize() as { list: unknown }).list),
    ).toBe(true);
  });

  it('materialize() with no root register vivifies the tree from deeper registers', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['a', 'b'], 1)], 'o', 1));
    expect(conv.materialize()).toStrictEqual({ a: { b: 1 } });
  });

  it('liveAt of a path nobody wrote is empty', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['a'], 1)], 'o', 1));
    expect(conv.liveAt(['never'])).toEqual([]);
  });
});

describe('register citations', () => {
  it('a cross-origin write that observed a sibling supersedes it under preserve (no conflict)', () => {
    const root = converge(
      [
        env([set(['v'], 'B')], 'b', 1),
        env([set(['v'], 'A', [d('b', 1)])], 'a', 2),
      ],
      [{ path: 'v', merge: preserve }],
    ) as { v: unknown };
    expect(isConflicted(root.v)).toBe(false);
    expect(root.v).toBe('A');
  });

  it('a cross-origin subtree replace that observed a child removes it', () => {
    const root = converge([
      env([set(['a', 'x'], 1)], 'b', 5),
      env([set(['a'], { y: 2 }), clear(['a', 'x'], [d('b', 5)])], 'a', 6),
    ]);
    expect(root).toStrictEqual({ a: { y: 2 } });
  });
});

describe('the wire lint and conflict narrowing', () => {
  it('wireValueViolation checks every key of a record, not just the first', () => {
    expect(wireValueViolation({ ok: 1, bad: NaN })).toBe('non-finite-number');
    expect(
      wireValueViolation({ ok: 1, nested: { fine: 2, bad: undefined } }),
    ).toBe('undefined-in-container');
  });

  it('isConflicted narrows a nullable leaf without throwing', () => {
    expect(isConflicted(null)).toBe(false);
    expect(isConflicted(undefined)).toBe(false);
    expect(isConflicted('x')).toBe(false);
  });
});

describe('load and settle', () => {
  const reg = (
    siblings: RegisterCheckpoint['siblings'],
    water: RegisterCheckpoint['water'] = {},
  ): RegisterCheckpoint => ({
    path: ['v'],
    siblings,
    water,
  });
  const sib = (origin: string, p: number, value: unknown) => ({
    kind: 'set' as const,
    value,
    writer: 'w',
    origin,
    hlc: { p, l: 0 },
    epoch: 0,
  });

  it('loading onto populated registers keeps each origin’s newest sibling and highest watermark, in either order', () => {
    const newer = reg([sib('a', 5, 'a5'), sib('b', 4, 'b4')], {
      c: { p: 9, l: 0 },
    });
    const older = reg(
      [sib('a', 2, 'a2'), sib('b', 4, 'b4'), sib('c', 3, 'c3')],
      { c: { p: 1, l: 0 } },
    );
    const x = createConvergingApply();
    x.load([newer]);
    x.load([older]);
    const y = createConvergingApply();
    y.load([older]);
    y.load([newer]);
    for (const c of [x, y]) {
      expect(c.liveAt(['v']).map((s) => [s.origin, s.value])).toEqual([
        ['a', 'a5'],
        ['b', 'b4'],
      ]);
      expect(c.materialize()).toStrictEqual({ v: 'a5' });
    }
  });

  it('a loaded watermark counts in appliedFrontier even when its sibling was collected', () => {
    const conv = createConvergingApply();
    conv.load([reg([sib('a', 5, 'a5')], { x: { p: 3, l: 1 } })]);
    expect(conv.appliedFrontier()['x']).toEqual({ p: 3, l: 1 });
  });

  function superseded() {
    const conv = createConvergingApply();
    conv.ingest(env([set(['v'], 'A')], 'a', 5));
    conv.ingest(env([set(['v'], 'B', [d('a', 5)])], 'b', 20));
    return conv;
  }
  const waterOf = (conv: ReturnType<typeof superseded>) =>
    conv.checkpoint().find((r) => r.path[0] === 'v')?.water;

  it('settling exactly at the cited stamp collects the superseded sibling and its watermark together', () => {
    const conv = superseded();
    conv.settle({ a: { p: 5, l: 0 } });
    expect(conv.liveAt(['v']).map((s) => s.origin)).toEqual(['b']);
    expect(waterOf(conv)).toEqual({});
    expect(
      conv
        .checkpoint()
        .find((r) => r.path[0] === 'v')
        ?.siblings.map((s) => s.origin),
    ).toEqual(['b']);
  });

  it('settling below the cited stamp keeps the watermark, so the superseded write stays hidden', () => {
    const conv = superseded();
    conv.settle({ a: { p: 3, l: 0 } });
    expect(conv.liveAt(['v']).map((s) => s.origin)).toEqual(['b']);
    expect(waterOf(conv)).toEqual({ a: { p: 5, l: 0 } });
  });

  it('settling an origin with no watermark leaves other watermarks alone', () => {
    const conv = superseded();
    expect(() => conv.settle({ b: { p: 1, l: 0 } })).not.toThrow();
    expect(waterOf(conv)).toEqual({ a: { p: 5, l: 0 } });
    expect(conv.liveAt(['v']).map((s) => s.origin)).toEqual(['b']);
  });
});
