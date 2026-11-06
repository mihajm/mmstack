import { applyOps, type StoreOp } from './op-log';
import {
  createConvergingApply,
  isConflicted,
  keyedArray,
  lww,
  mergeThree,
  OP_PROTO_VERSION,
  positional,
  preserve,
  type ConvergingApply,
  type MergePolicyEntry,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SyncOp,
  type SyncSibling,
} from './op-sync';

// A retained sibling's `prev` is the ancestor a value-merging fold merges a `set` sibling against.
// A `delete` sibling has no value to merge, so its `prev` must not decide any folded value: the
// register drops it, and a delete op on the wire keeps it (the emitter's own inversion reads it).

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const shuffle = <T>(arr: readonly T[], seed: number): T[] => {
  const r = mulberry32(seed);
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

type Shape = 'record' | 'keyed' | 'list' | 'mixed';

type Case = {
  readonly name: string;
  readonly shape: Shape;
  readonly policies: readonly MergePolicyEntry[];
};

const byId = keyedArray((t) => (t as { id: number }).id);
const CASES: readonly Case[] = [
  { name: 'lww', shape: 'mixed', policies: [{ path: '*', merge: lww }] },
  {
    name: 'mergeThree',
    shape: 'record',
    policies: [{ path: '*', merge: mergeThree }],
  },
  {
    name: 'keyedArray',
    shape: 'keyed',
    policies: [{ path: '*', merge: byId }],
  },
  {
    name: 'positional',
    shape: 'list',
    policies: [{ path: '*', merge: positional }],
  },
  { name: 'no policy (positional arrays)', shape: 'list', policies: [] },
];

const fresh = (shape: Shape, r: () => number): unknown => {
  const n = () => Math.floor(r() * 4);
  switch (shape) {
    case 'record':
      return { a: n(), b: n(), c: { d: n(), e: n() } };
    case 'keyed':
      return [0, 1, 2].map((id) => ({ id, v: n() }));
    case 'list':
      return [n(), n(), n()];
    case 'mixed':
      return r() < 0.5 ? `s${n()}` : { a: n(), b: [n(), n()] };
  }
};

/** A writer's next value: mostly a small edit of what it sees, so concurrent merges have work. */
const valueOf = (shape: Shape, r: () => number, current: unknown): unknown => {
  const n = () => Math.floor(r() * 4);
  if (r() < 0.25) return fresh(shape, r);
  if (shape === 'record' && current && typeof current === 'object') {
    const field = (['a', 'b'] as const)[Math.floor(r() * 2)];
    return { ...(current as object), [field]: n() };
  }
  if (shape === 'list' && Array.isArray(current) && current.length) {
    const at = Math.floor(r() * current.length);
    return current.map((v, i) => (i === at ? n() : v));
  }
  if (shape === 'keyed' && Array.isArray(current)) {
    const items = current as { id: number; v: number }[];
    const at = Math.floor(r() * (items.length + 1));
    return at === items.length
      ? [...items, { id: 3 + Math.floor(r() * 3), v: n() }]
      : items.map((t, i) => (i === at ? { ...t, v: n() } : t));
  }
  return fresh(shape, r);
};

const readAt = (root: unknown, path: readonly (string | number)[]): unknown => {
  let v = root;
  for (const k of path) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
};

const PATHS: readonly (string | number)[][] = [['x'], ['y'], ['x', 'k']];
const ORIGINS = ['o1', 'o2', 'o3', 'o4'];

/**
 * A history emitted by per-origin replicas that see only part of each other's writes (gossip
 * with random lag), so concurrent siblings carry real cites and epochs. Every `set` carries the
 * emitter's current value as `prev`; every `delete` carries the record it removed (a distinctive
 * value when the emitter saw nothing there), so a fold that read it would see a real ancestor.
 */
function history(seed: number, shape: Shape): OpEnvelope[] {
  const r = mulberry32(seed);
  const replicas = new Map<string, ConvergingApply>(
    ORIGINS.map((o) => [o, createConvergingApply()]),
  );
  const seen = new Map<string, number>(ORIGINS.map((o) => [o, 0]));
  const versions = new Map<string, number>();
  const out: OpEnvelope[] = [];
  const rounds = 14 + Math.floor(r() * 16);
  for (let i = 0; i < rounds; i++) {
    const origin = ORIGINS[Math.floor(r() * ORIGINS.length)];
    const rep = replicas.get(origin) as ConvergingApply;
    // catch up on a random prefix of the history not yet seen (lag makes writes concurrent)
    const from = seen.get(origin) as number;
    const upto =
      r() < 0.5 ? from : from + Math.floor(r() * (out.length - from + 1));
    for (let j = from; j < upto; j++) {
      if (out[j].origin !== origin) rep.ingest(out[j]);
    }
    seen.set(origin, upto);

    const path = PATHS[Math.floor(r() * PATHS.length)];
    const current = readAt(rep.materialize(), path);
    const roll = r();
    const op: StoreOp =
      roll < 0.3
        ? {
            kind: 'delete',
            path,
            prev: current ?? { removed: `${origin}:${i}` },
          }
        : {
            kind: 'set',
            path,
            next: valueOf(shape, r, current),
            prev: current,
          };
    const ops = rep.stamp([op], { bump: r() < 0.15 });
    const version = (versions.get(origin) ?? 0) + 1;
    versions.set(origin, version);
    const e: OpEnvelope = {
      proto: OP_PROTO_VERSION,
      instance: 'g',
      origin,
      writer: origin,
      version,
      hlc: { p: i + 1, l: 0 },
      policyVersion: 0,
      ops,
    };
    rep.ingest(e, { local: true });
    out.push(e);
  }
  return out;
}

/** The same history with every delete op's `prev` removed (the property's other arm). */
const withoutDeletePrev = (envs: readonly OpEnvelope[]): OpEnvelope[] =>
  envs.map((e) => ({
    ...e,
    ops: e.ops.map((op) => {
      if (op.kind !== 'delete') return op;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { prev: _dropped, ...rest } = op as SyncOp & { prev?: unknown };
      return rest as SyncOp;
    }),
  }));

const fold = (
  envs: readonly OpEnvelope[],
  policies: readonly MergePolicyEntry[],
): { applied: unknown; materialized: unknown; conv: ConvergingApply } => {
  const conv = createConvergingApply({ policies });
  let applied: unknown = {};
  for (const e of envs) applied = applyOps(applied, conv.ingest(e));
  return { applied, materialized: conv.materialize(), conv };
};

/**
 * Registers where a fold could misread a delete's `prev`: a set winner with a delete at its epoch
 * (`pair`), and among those, a second set the merge folds in after it (`merged`).
 */
const deleteUnderSetWinner = (
  conv: ConvergingApply,
): { pair: number; merged: number } => {
  let pair = 0;
  let merged = 0;
  for (const { siblings } of conv.liveUnder([])) {
    const top = Math.max(...siblings.map((s) => s.epoch));
    const at = siblings.filter((s) => s.epoch === top);
    const sets = at.filter((s) => s.kind === 'set').length;
    if (!sets || !at.some((s) => s.kind === 'delete')) continue;
    pair++;
    if (sets > 1) merged++;
  }
  return { pair, merged };
};

describe("PROPERTY: a delete sibling's prev decides no folded value (lww, merge, positional)", () => {
  const SEEDS = 200;
  const ORDERS = 3;

  for (const c of CASES) {
    it(`${c.name}: ${SEEDS} seeds × ${ORDERS} orders fold identically with and without delete prev`, () => {
      let pair = 0;
      let merged = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const envs = history(seed * 7919 + c.name.length, c.shape);
        const bare = withoutDeletePrev(envs);
        for (let order = 0; order < ORDERS; order++) {
          const s = seed * 31 + order;
          const withPrev = fold(shuffle(envs, s), c.policies);
          const without = fold(shuffle(bare, s), c.policies);
          expect(
            withPrev.materialized,
            `${c.name} seed ${seed} order ${order}`,
          ).toEqual(without.materialized);
          expect(
            withPrev.applied,
            `${c.name} seed ${seed} order ${order}`,
          ).toEqual(without.applied);
          if (order === 0) {
            const hit = deleteUnderSetWinner(withPrev.conv);
            pair += hit.pair;
            merged += hit.merged;
          }
        }
      }
      // non-vacuity: the generator reaches the registers a fold could misread, many times over
      expect(pair).toBeGreaterThan(SEEDS / 4);
      expect(merged).toBeGreaterThan(SEEDS / 20);
    });
  }
});

const env = (
  origin: string,
  p: number,
  ops: readonly SyncOp[],
): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: origin,
  version: p,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});

const setOp = (path: string[], next: unknown, prev: unknown): SyncOp => ({
  kind: 'set',
  path,
  next,
  prev,
  cites: [],
  epoch: 0,
});

const delOp = (path: string[], prev: unknown): SyncOp => ({
  kind: 'delete',
  path,
  prev,
  cites: [],
  epoch: 0,
});

const siblingsAt = (
  regs: readonly RegisterCheckpoint[],
  path: string,
): readonly SyncSibling[] =>
  regs.find((r) => r.path.join('.') === path)?.siblings ?? [];

describe('register: a delete sibling carries no prev', () => {
  it('ingest keeps a set sibling prev and drops a delete sibling prev (the delete op still carries it)', () => {
    const conv = createConvergingApply();
    const del = env('o1', 1, [delOp(['k'], { big: 'record' })]);
    conv.ingest(del);
    conv.ingest(env('o2', 2, [setOp(['k'], 2, 1)]));
    const sibs = siblingsAt(conv.checkpoint(), 'k');
    const d = sibs.find((s) => s.kind === 'delete') as SyncSibling;
    const s = sibs.find((s) => s.kind === 'set') as SyncSibling;
    expect(Object.hasOwn(d, 'prev')).toBe(false);
    expect(Object.hasOwn(s, 'prev')).toBe(true);
    expect(s.prev).toBe(1);
    // the wire op is untouched: local inversion reads it
    expect(Object.hasOwn(del.ops[0], 'prev')).toBe(true);
  });

  it('load strips prev from an older checkpoint delete sibling and keeps a set sibling prev', () => {
    const hlc = (p: number) => ({ p, l: 0 });
    const old: RegisterCheckpoint[] = [
      {
        path: ['k'],
        siblings: [
          {
            kind: 'delete',
            prev: { big: 'record' },
            writer: 'o1',
            origin: 'o1',
            hlc: hlc(1),
            epoch: 0,
          },
          {
            kind: 'set',
            value: 2,
            prev: 1,
            writer: 'o2',
            origin: 'o2',
            hlc: hlc(2),
            epoch: 0,
          },
        ],
        water: {},
      },
    ];
    const conv = createConvergingApply();
    conv.load(old);
    const sibs = siblingsAt(conv.checkpoint(), 'k');
    expect(sibs).toHaveLength(2);
    const d = sibs.find((s) => s.kind === 'delete') as SyncSibling;
    const s = sibs.find((s) => s.kind === 'set') as SyncSibling;
    expect(Object.hasOwn(d, 'prev')).toBe(false);
    expect(s.prev).toBe(1);
    // the caller's checkpoint is not mutated
    expect(Object.hasOwn(old[0].siblings[0], 'prev')).toBe(true);
    expect(conv.materialize()).toEqual({ k: 2 });
  });
});

describe('preserve: the conflict ancestor is the runner-up prev, absent for a delete runner-up', () => {
  const conflictAt = (envs: readonly OpEnvelope[]) => {
    const conv = createConvergingApply({
      policies: [{ path: 'v', merge: preserve }],
    });
    for (const e of envs) conv.ingest(e);
    const v = (conv.materialize() as { v: unknown }).v;
    expect(isConflicted(v)).toBe(true);
    return v as { ancestor: unknown; mine: unknown; theirs: unknown };
  };

  it('a delete runner-up leaves the ancestor undefined (its prev is not retained)', () => {
    const c = conflictAt([
      env('o1', 1, [delOp(['v'], 'base')]),
      env('o2', 2, [setOp(['v'], 'mine', 'base')]),
    ]);
    expect(c.mine).toBe('mine');
    expect(c.theirs).toBeUndefined();
    expect(c.ancestor).toBeUndefined();
  });

  it('a set runner-up still reports its own prev as the ancestor', () => {
    const c = conflictAt([
      env('o1', 1, [setOp(['v'], 'theirs', 'base')]),
      env('o2', 2, [setOp(['v'], 'mine', 'other')]),
    ]);
    expect(c.mine).toBe('mine');
    expect(c.theirs).toBe('theirs');
    expect(c.ancestor).toBe('base');
  });
});
