import { applyOps, type StoreOp } from './op-log';
import { opaque } from './opaque';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  type OpEnvelope,
} from './op-sync';

// A write under an ancestor register that holds an ARRAY must materialize exactly as `applyOps`
// would apply it. `diffOps` descends per index for a same-length array, so these ops are ordinary
// traffic; a graft rule that refused arrays silently dropped them at every receiver while the
// emitter's own store kept the value.

function env(
  ops: StoreOp[],
  stamp: { p?: number; origin?: string; version?: number },
): OpEnvelope {
  return {
    proto: OP_PROTO_VERSION,
    origin: stamp.origin ?? 'o',
    writer: 'w',
    version: stamp.version ?? 1,
    hlc: { p: stamp.p ?? 1, l: 0 },
    policyVersion: 0,
    ops: ops.map((o) => ({
      cites: [],
      epoch: 0,
      ...o,
    })) as unknown as OpEnvelope['ops'],
  };
}

const set = (path: (string | number)[], next: unknown): StoreOp => ({
  kind: 'set',
  path,
  next,
});

const del = (path: (string | number)[], prev: unknown): StoreOp => ({
  kind: 'delete',
  path,
  prev,
});

describe('createConvergingApply — grafting through an array', () => {
  it('CONTROL: a write under an ancestor RECORD materializes', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['cfg'], { a: 'x', b: 'y' })], { p: 1, origin: 'A' }));

    const deltas = conv.ingest(
      env([set(['cfg', 'a'], 'p')], { p: 2, origin: 'B' }),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(conv.materialize()).toEqual({ cfg: { a: 'p', b: 'y' } });
  });

  it('a write under an ancestor ARRAY materializes', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['routes'], ['x', 'y'])], { p: 1, origin: 'A' }));

    const deltas = conv.ingest(
      env([set(['routes', 0], 'p')], { p: 2, origin: 'B' }),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(conv.materialize()).toEqual({ routes: ['p', 'y'] });
  });

  it('a write into a record INSIDE an array materializes (the element-edit shape)', () => {
    const conv = createConvergingApply();
    conv.ingest(
      env([set(['routes'], [{ id: 'r1', path: '/a' }])], { p: 1, origin: 'A' }),
    );

    const deltas = conv.ingest(
      env([set(['routes', 0, 'path'], '/b')], { p: 2, origin: 'B' }),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(conv.materialize()).toEqual({ routes: [{ id: 'r1', path: '/b' }] });
  });

  it('the array graft keeps the value an ARRAY, never an index-keyed record', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['routes'], ['x', 'y'])], { p: 1, origin: 'A' }));
    conv.ingest(env([set(['routes', 0], 'p')], { p: 2, origin: 'B' }));

    const routes = (conv.materialize() as { routes: unknown }).routes;
    expect(Array.isArray(routes)).toBe(true);
  });

  it('a delete under an array matches what applyOps does to the same value', () => {
    const conv = createConvergingApply();
    const root = applyOps(
      {},
      conv.ingest(env([set(['routes'], ['x', 'y'])], { p: 1, origin: 'A' })),
    );

    const deltas = conv.ingest(
      env([del(['routes', 0], 'x')], { p: 2, origin: 'B' }),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(conv.materialize()).toEqual(applyOps(root, deltas));
  });

  it('materialization agrees with incrementally applied deltas across a mixed array run', () => {
    const conv = createConvergingApply();
    let root: unknown = {};
    const feed = (e: OpEnvelope) => {
      root = applyOps(root, conv.ingest(e));
    };

    feed(env([set(['routes'], [{ id: 'r1' }, { id: 'r2' }])], { p: 1, origin: 'A' }));
    feed(env([set(['routes', 0, 'id'], 'r1-edited')], { p: 2, origin: 'B' }));
    feed(env([set(['routes', 1], { id: 'r2-replaced' })], { p: 3, origin: 'C' }));

    expect(root).toEqual(conv.materialize());
    expect(root).toEqual({
      routes: [{ id: 'r1-edited' }, { id: 'r2-replaced' }],
    });
  });

  it('an OPAQUE array stays one unit: a descendant write is still dropped', () => {
    const conv = createConvergingApply();
    const unit = opaque(['x', 'y']);
    conv.ingest(env([set(['routes'], unit)], { p: 1, origin: 'A' }));

    const deltas = conv.ingest(
      env([set(['routes', 0], 'p')], { p: 2, origin: 'B' }),
    );

    expect(deltas).toEqual([]);
    expect((conv.materialize() as { routes: unknown }).routes).toBe(unit);
  });

  it('a `__proto__` segment is a no-op for materialization AND incremental apply, and pollutes nothing', () => {
    const conv = createConvergingApply();
    let root: unknown = {};
    root = applyOps(
      root,
      conv.ingest(
        env([set(['routes'], ['x']), set(['cfg'], { a: 1 })], {
          p: 1,
          origin: 'A',
        }),
      ),
    );

    const before = conv.materialize();
    const deltas = conv.ingest(
      env(
        [
          set(['cfg', '__proto__'], { polluted: true }),
          set(['routes', '__proto__'], { polluted: true }),
          set(['cfg', '__proto__', 'polluted'], true),
        ],
        { p: 2, origin: 'B' },
      ),
    );
    root = applyOps(root, deltas);

    expect(conv.materialize()).toEqual(before);
    expect(conv.materialize()).toEqual(root);
    // `toEqual` compares own properties only, so a swapped [[Prototype]] on a grafted copy
    // would slip past it — assert prototype identity directly, per materialized container
    const state = conv.materialize() as { cfg: object; routes: unknown[] };
    expect(Object.getPrototypeOf(state.cfg)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(state.routes)).toBe(Array.prototype);
    expect((state.cfg as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(([] as unknown as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

// The convergence theorem's safety leg, re-pointed at the real register over ARRAY-bearing
// shapes: the materialized state is a pure function of the delivered op SET — order, duplication
// and interleaving of envelopes must not matter — and every replica's own delta stream, folded
// through `applyOps`, must land on exactly what it materializes (the checkpoint↔incremental
// parity the graft/`applyAt` agreement exists to guarantee).
describe('createConvergingApply — array op sets are order-insensitive and apply-parity-clean', () => {
  const mulberry32 = (seed: number) => () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const shuffled = <T>(items: readonly T[], rand: () => number): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const randomOp = (rand: () => number, n: number): StoreOp => {
    // whole-`routes` writes TYPE-FLIP between array / record / scalar siblings, so shuffled
    // orders exercise drop-under-scalar, resurface-after-restore and array/record admission
    // choices at the same path; deletes ride record keys (emission's only delete shape)
    const routesValue =
      n % 3 === 0 ? [`w${n}`, `w${n + 1}`] : n % 3 === 1 ? { id: `v${n}` } : n;
    const choice = Math.floor(rand() * 6);
    if (choice === 0) return del(['recs', `k${n % 3}`], n);
    const paths: (string | number)[][] = [
      ['recs', `k${n % 3}`],
      ['routes', n % 3],
      ['routes', n % 3, 'path'],
      ['deep', 0, 'items', n % 2],
      ['routes'],
    ];
    const path = paths[choice - 1];
    return set(
      path,
      path.at(-1) === 'path'
        ? `/p${n}`
        : path.length === 1
          ? routesValue
          : { id: `v${n}`, at: n },
    );
  };

  it('[PROVEN→impl] N seeds × shuffled+duplicated delivery: identical state, and applyOps-folded deltas ≡ materialize()', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = mulberry32(seed);
      const base = env(
        [
          set(['recs'], { k0: 0, k1: 1, k2: 2 }),
          set(['routes'], [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }, { id: 'c', path: '/c' }]),
          set(['deep'], [{ items: ['x', 'y'] }]),
        ],
        { p: 1, origin: 'BASE' },
      );
      const writes = Array.from({ length: 12 }, (_, n) =>
        env([randomOp(rand, n)], { p: 2 + n, origin: `O${n % 4}` }),
      );

      // the base rides the shuffle too: descendant registers must tolerate arriving before
      // any ancestor exists, staying dormant until the container does
      const orders: OpEnvelope[][] = [
        [base, ...writes],
        shuffled([base, ...writes], rand),
        shuffled([base, ...writes, ...writes.slice(0, 4)], rand),
      ];

      const results = orders.map((order) => {
        const conv = createConvergingApply();
        let root: unknown = {};
        for (const e of order) root = applyOps(root, conv.ingest(e));
        return { state: conv.materialize(), folded: root };
      });

      for (const { state, folded } of results) {
        expect(folded, `seed ${seed}: incremental fold diverged from materialize`).toEqual(state);
      }
      expect(results[1].state, `seed ${seed}: shuffle changed the state`).toEqual(results[0].state);
      expect(results[2].state, `seed ${seed}: duplication changed the state`).toEqual(results[0].state);
    }
  });
});

// The documented drop rule ("a graft whose parent location is not a plain record is DROPPED —
// the register stays intact and resurfaces if the container is restored"), pinned as the
// COMPATIBILITY DECISION for non-plain ancestors: a descendant under a `Date`-valued sibling
// stays dormant rather than vivifying over it, a checkpoint round-trips to the identical
// state, and restoring a plain container resurfaces the dormant register. Pre-fix code
// contradicted its own rule here (it admitted any non-array object, and its delete lane
// disagreed with `applyAt` about what a delete under a `Date` does).
describe('createConvergingApply — non-plain ancestors drop, checkpoints agree, restore resurfaces', () => {
  it('a concurrent descendant under a Date-valued sibling stays dormant; checkpoint round-trip is identity; a restored container resurfaces it', () => {
    const when = new Date(0);
    const conv = createConvergingApply();
    conv.ingest(env([set(['cfg'], { x: 'old' })], { p: 1, origin: 'A' }));
    conv.ingest(env([set(['cfg', 'x'], 'descendant')], { p: 2, origin: 'B' }));
    conv.ingest(env([set(['cfg'], when)], { p: 3, origin: 'C' }));

    expect((conv.materialize() as { cfg: unknown }).cfg).toBe(when);

    const seeded = createConvergingApply();
    seeded.load(conv.checkpoint());
    expect(seeded.materialize()).toEqual(conv.materialize());

    conv.ingest(env([set(['cfg'], { y: 'restored' })], { p: 4, origin: 'A' }));
    expect(conv.materialize()).toEqual({
      cfg: { y: 'restored', x: 'descendant' },
    });
  });
});
