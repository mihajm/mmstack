import { applyOps, diffOps, type StoreOp } from './op-log';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  type ConvergingApply,
  type OpEnvelope,
} from './op-sync';

// M2: two replicas add the SAME new container concurrently, each with its own keys. Emission goes
// through the real stamp path of `createConvergingApply`; deliveries are shuffled and duplicated per
// seed. Three start documents: no register above the container (`bare`), a root register (`root`,
// a seeded room), and a whole-added parent register (`parent`, the common case: every record added
// in `'whole'` mode mints one).

type Key = string | number;
type Rec = Record<string, unknown>;
type Mode = 'whole' | 'leaves' | 'leaf-only';

const SEEDS = 240;

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = <T>(arr: readonly T[], r: () => number): T[] => {
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

const isRec = (v: unknown): v is Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** An added container: shared intermediate names (`m`, `n`), writer-unique leaf names. */
function genAdd(r: () => number, writer: string, depth: number): Rec {
  const out: Rec = {};
  const leaves = 1 + Math.floor(r() * 3);
  for (let i = 0; i < leaves; i++) out[`${writer}${i}`] = Math.floor(r() * 100);
  if (depth > 0)
    for (const k of ['m', 'n'])
      if (r() < 0.5) out[k] = genAdd(r, writer, depth - 1);
  return out;
}

const deepMerge = (a: Rec, b: Rec): Rec => {
  const out: Rec = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] = isRec(out[k]) && isRec(v) ? deepMerge(out[k] as Rec, v) : v;
  return out;
};

const setIn = (root: unknown, path: readonly Key[], value: unknown): unknown =>
  applyOps(root, [{ kind: 'set', path, next: value }]);
const getIn = (root: unknown, path: readonly Key[]): unknown =>
  path.reduce<unknown>(
    (cur, k) => (isRec(cur) ? cur[k as string] : undefined),
    root,
  );

/** The charter-literal arm, verifier-owned: added records emit ONLY their leaves, no anchor. */
function leafOnlyDiff(
  prev: Rec,
  next: Rec,
  path: readonly Key[] = [],
): StoreOp[] {
  const ops: StoreOp[] = [];
  const emitAdded = (v: unknown, p: readonly Key[]) => {
    if (isRec(v))
      for (const [k, c] of Object.entries(v)) emitAdded(c, [...p, k]);
    else ops.push({ kind: 'set', path: p, next: v });
  };
  for (const [k, v] of Object.entries(next)) {
    if (!Object.hasOwn(prev, k)) emitAdded(v, [...path, k]);
    else if (prev[k] !== v && isRec(prev[k]) && isRec(v))
      ops.push(...leafOnlyDiff(prev[k] as Rec, v, [...path, k]));
    else if (prev[k] !== v)
      ops.push({ kind: 'set', path: [...path, k], prev: prev[k], next: v });
  }
  return ops;
}

const emit = (mode: Mode, prev: unknown, next: unknown): StoreOp[] =>
  mode === 'leaf-only'
    ? leafOnlyDiff(prev as Rec, next as Rec)
    : diffOps(prev, next, { added: mode });

const envOf = (
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

type Start = {
  readonly name: string;
  readonly base: OpEnvelope[];
  readonly at: Key[];
};
const STARTS: readonly Start[] = [
  {
    name: 'bare',
    base: [
      envOf('s', 1, [
        { kind: 'set', path: ['other'], next: 1, cites: [], epoch: 0 },
      ]),
    ],
    at: ['c'],
  },
  {
    name: 'root',
    base: [
      envOf('s', 1, [
        { kind: 'set', path: [], next: { other: 1 }, cites: [], epoch: 0 },
      ]),
    ],
    at: ['c'],
  },
  {
    name: 'parent',
    base: [
      envOf('s', 1, [
        { kind: 'set', path: ['pages'], next: { a: 1 }, cites: [], epoch: 0 },
      ]),
    ],
    at: ['pages', 'c'],
  },
];

type Replica = { conv: ConvergingApply; root: unknown };

function run(start: Start, mode: Mode, seed: number) {
  const r = mulberry32(seed * 7919 + start.name.length);
  const mk = (): Replica => {
    const conv = createConvergingApply();
    let root: unknown = {};
    for (const e of start.base) root = applyOps(root, conv.ingest(e));
    return { conv, root };
  };
  const A = mk();
  const B = mk();
  const O = mk(); // an observer that writes nothing
  const baseRoot = A.root;

  const addA = genAdd(r, 'a', 2);
  const addB = genAdd(r, 'b', 2);
  const write = (rep: Replica, origin: string, add: Rec): OpEnvelope => {
    const next = setIn(rep.root, start.at, add);
    const ops = emit(mode, rep.root, next);
    const env = envOf(origin, 10 + Math.floor(r() * 2), rep.conv.stamp(ops));
    rep.root = next; // optimistic local value
    rep.conv.ingest(env, { local: true });
    return env;
  };
  const envA = write(A, 'A', addA);
  const envB = write(B, 'B', addB);

  const deliver = (rep: Replica, envs: OpEnvelope[]) => {
    const dup = envs.flatMap((e) => (r() < 0.5 ? [e, e] : [e]));
    for (const e of shuffle(dup, r))
      rep.root = applyOps(rep.root, rep.conv.ingest(e));
  };
  deliver(A, [envB]);
  deliver(B, [envA]);
  deliver(O, [envA, envB]);
  return { baseRoot, addA, addB, replicas: [A, B, O] };
}

describe('M2 concurrent first writers on one new container (createConvergingApply, shuffled + duplicated)', () => {
  for (const start of STARTS) {
    it(`[PROVEN] leaves: every replica holds BOTH writers' keys — start "${start.name}" (${SEEDS} seeds)`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { baseRoot, addA, addB, replicas } = run(start, 'leaves', seed);
        const expected = setIn(baseRoot, start.at, deepMerge(addA, addB));
        for (const [i, rep] of replicas.entries()) {
          expect(rep.root, `seed ${seed} replica ${'ABO'[i]}`).toEqual(
            expected,
          );
          expect(
            rep.conv.materialize(),
            `seed ${seed} replica ${'ABO'[i]} materialize`,
          ).toEqual(expected);
        }
      }
    });

    it(`whole (characterisation): the container is ONE writer's value, the other's keys are lost — start "${start.name}" (${SEEDS} seeds)`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { baseRoot, addA, addB, replicas } = run(start, 'whole', seed);
        const [A, B, O] = replicas.map((rep) => rep.root);
        expect(A, `seed ${seed}: still convergent`).toEqual(O);
        expect(B, `seed ${seed}: still convergent`).toEqual(O);
        const got = getIn(O, start.at);
        expect([addA, addB], `seed ${seed}`).toContainEqual(got);
        expect(O, `seed ${seed}`).not.toEqual(
          setIn(baseRoot, start.at, deepMerge(addA, addB)),
        );
      }
    });
  }

  it(`leaf-only, no anchor (the charter-literal arm, characterisation): fine with no register above, LOST on peers under a root or parent register (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bare = run(STARTS[0], 'leaf-only', seed);
      const expected = setIn(
        bare.baseRoot,
        STARTS[0].at,
        deepMerge(bare.addA, bare.addB),
      );
      expect(bare.replicas[2].root, `seed ${seed} bare`).toEqual(expected);
      for (const start of STARTS.slice(1)) {
        const { baseRoot, replicas } = run(start, 'leaf-only', seed);
        // the observer never sees the container; each writer keeps only its own optimistic copy
        expect(replicas[2].root, `seed ${seed} ${start.name}`).toEqual(
          baseRoot,
        );
        expect(replicas[0].root, `seed ${seed} ${start.name}`).not.toEqual(
          replicas[2].root,
        );
      }
    }
  });
});
