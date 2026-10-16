import { applyOps, diffOps, type AddedPolicy, type StoreOp } from './op-log';
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

// ---- Round 2: per-path policies on the convergence model ---------------------------------------

type Write = { origin: string; at: Key[]; value: unknown };

/** Concurrent first writers through the real stamp path; deliveries shuffled + duplicated. */
function runConcurrent(
  base: OpEnvelope[],
  writes: Write[],
  added: AddedPolicy,
  seed: number,
) {
  const r = mulberry32(seed * 6151 + writes.length);
  const mk = (): Replica => {
    const conv = createConvergingApply();
    let root: unknown = {};
    for (const e of base) root = applyOps(root, conv.ingest(e));
    return { conv, root };
  };
  const writers = writes.map(() => mk());
  const O = mk();
  const baseRoot = O.root;
  const envs = writes.map((w, i) => {
    const rep = writers[i];
    const next = setIn(rep.root, w.at, w.value);
    const ops = diffOps(rep.root, next, { added });
    const env = envOf(w.origin, 10 + Math.floor(r() * 2), rep.conv.stamp(ops));
    rep.root = next;
    rep.conv.ingest(env, { local: true });
    return env;
  });
  const deliver = (rep: Replica, list: OpEnvelope[]) => {
    const dup = list.flatMap((e) => (r() < 0.5 ? [e, e] : [e]));
    for (const e of shuffle(dup, r))
      rep.root = applyOps(rep.root, rep.conv.ingest(e));
  };
  writers.forEach((rep, i) =>
    deliver(
      rep,
      envs.filter((_, j) => j !== i),
    ),
  );
  deliver(O, envs);
  return { baseRoot, envs, replicas: [...writers, O] };
}

/** Each entry path carries exactly ONE op in its writer's envelope, with the whole entry, nothing under it. */
const expectAtomicEntries = (
  env: OpEnvelope,
  entries: Record<string, unknown>,
  at: Key[],
  tag: string,
) => {
  for (const [k, entry] of Object.entries(entries)) {
    const path = [...at, k];
    const under = env.ops.filter(
      (o) =>
        o.kind !== 'clear' &&
        o.path.length >= path.length &&
        path.every((x, i) => o.path[i] === x),
    );
    expect(under, `${tag} entry ${k}`).toHaveLength(1);
    expect((under[0] as { next: unknown }).next, `${tag} entry ${k}`).toEqual(
      entry,
    );
  }
};

const genEntries = (r: () => number, writer: string): Rec => {
  const out: Rec = {};
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++)
    out[`${writer}${i}`] = {
      rule: `r${Math.floor(r() * 5)}`,
      by: writer,
      at: i,
      meta: { n: Math.floor(r() * 9) },
    };
  return out;
};

describe('M2b per-path policy: leafy collection, atomic entries (createConvergingApply, shuffled + duplicated)', () => {
  for (const start of STARTS) {
    it(`[PROVEN] both writers' entries survive on every replica and each entry is ONE set — start "${start.name}" (${SEEDS} seeds)`, () => {
      const policy: AddedPolicy = (p) =>
        p.length <= start.at.length ? 'leaves' : 'whole';
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = mulberry32(seed * 31337);
        const eA = genEntries(r, 'a');
        const eB = genEntries(r, 'b');
        const { baseRoot, envs, replicas } = runConcurrent(
          start.base,
          [
            { origin: 'A', at: start.at, value: eA },
            { origin: 'B', at: start.at, value: eB },
          ],
          policy,
          seed,
        );
        const expected = setIn(baseRoot, start.at, { ...eA, ...eB });
        for (const [i, rep] of replicas.entries()) {
          expect(rep.root, `seed ${seed} replica ${i}`).toEqual(expected);
          expect(
            rep.conv.materialize(),
            `seed ${seed} replica ${i} materialize`,
          ).toEqual(expected);
        }
        expectAtomicEntries(envs[0], eA, start.at, `seed ${seed} A`);
        expectAtomicEntries(envs[1], eB, start.at, `seed ${seed} B`);
      }
    });
  }

  it(`[PROVEN] studio policy: two concurrent first suppressors on a MISSING lint both survive, each entry one set; a concurrent first rule too (${SEEDS} seeds × bare/root)`, () => {
    const LEAFY = new Set([
      '["lint"]',
      '["lint","rules"]',
      '["lint","suppress"]',
    ]);
    const studio: AddedPolicy = (p) =>
      LEAFY.has(JSON.stringify(p)) ? 'leaves' : 'whole';
    for (const start of STARTS.slice(0, 2)) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = mulberry32(seed * 977);
        const sup = (by: string) => ({
          rule: `r${Math.floor(r() * 4)}`,
          path: ['p', by],
          reason: 'why',
          by,
          at: seed,
        });
        const sA = sup('a');
        const sB = sup('b');
        const rule = {
          id: 'r9',
          on: true,
          opts: { level: Math.floor(r() * 3) },
        };
        const { baseRoot, envs, replicas } = runConcurrent(
          start.base,
          [
            { origin: 'A', at: ['lint', 'suppress', 'kA'], value: sA },
            { origin: 'B', at: ['lint', 'suppress', 'kB'], value: sB },
            { origin: 'C', at: ['lint', 'rules', 'r9'], value: rule },
          ],
          studio,
          seed,
        );
        const expected = setIn(
          setIn(
            setIn(baseRoot, ['lint', 'suppress', 'kA'], sA),
            ['lint', 'suppress', 'kB'],
            sB,
          ),
          ['lint', 'rules', 'r9'],
          rule,
        );
        for (const [i, rep] of replicas.entries()) {
          expect(rep.root, `${start.name} seed ${seed} replica ${i}`).toEqual(
            expected,
          );
          expect(
            rep.conv.materialize(),
            `${start.name} seed ${seed} replica ${i}`,
          ).toEqual(expected);
        }
        expectAtomicEntries(
          envs[0],
          { kA: sA },
          ['lint', 'suppress'],
          `${start.name} seed ${seed} A`,
        );
        expectAtomicEntries(
          envs[1],
          { kB: sB },
          ['lint', 'suppress'],
          `${start.name} seed ${seed} B`,
        );
        expectAtomicEntries(
          envs[2],
          { r9: rule },
          ['lint', 'rules'],
          `${start.name} seed ${seed} C`,
        );
      }
    }
  });

  it(`whole (characterisation): the same two first suppressors on a missing lint keep only ONE (${SEEDS} seeds)`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { replicas } = runConcurrent(
        STARTS[0].base,
        [
          { origin: 'A', at: ['lint', 'suppress', 'kA'], value: { by: 'a' } },
          { origin: 'B', at: ['lint', 'suppress', 'kB'], value: { by: 'b' } },
        ],
        'whole',
        seed,
      );
      const sup = getIn(replicas[2].root, ['lint', 'suppress']) as Rec;
      expect(Object.keys(sup), `seed ${seed}`).toHaveLength(1);
    }
  });
});
