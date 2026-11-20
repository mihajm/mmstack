import { TestBed } from '@angular/core/testing';
import * as core from '../../index';
import { createHlcClock } from './hlc';
import {
  applyOps,
  diffOps,
  type AddedPolicy,
  type DiffOpsOptions,
  type EmitContext,
  type StoreOp,
} from './op-log';
import {
  createConvergingApply,
  keyedArray,
  opSync,
  replace,
  syncedFork,
  validateEnvelope,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type SyncOp,
} from './op-sync';
import { isOpaque, opaque } from './opaque';
import { store } from './store';
import { storeHistory } from './store-history';
import type { WritableSignalStore } from './types';

// One local write is one well-formed batch: every op has a kind and a path that can travel, each path
// at most once, and an op under another op's path only when that other op is an earlier set of a
// plain record. Anything else is refused before
// anything happens. A well-formed batch is stamped as today, except that generated descendant clears
// for one path merge into the first, and a generated clear yields to an authored op at its path.

type Key = string | number;
type Reason =
  | 'op'
  | 'kind'
  | 'path'
  | 'path-empty'
  | 'path-control'
  | 'path-proto'
  | 'root-op'
  | 'dup-path'
  | 'nested-path';

/** What a path segment or op shape must be to travel, written apart from the engine. */
function opFault(op: unknown): Reason | null {
  if (typeof op !== 'object' || op === null) return 'op';
  const { kind, path } = op as { kind?: unknown; path?: unknown };
  if (!['set', 'delete', 'clear'].includes(kind as string)) return 'kind';
  if (!Array.isArray(path)) return 'path';
  for (const seg of path as unknown[]) {
    const index = typeof seg === 'number' && Number.isInteger(seg) && seg >= 0;
    if (typeof seg !== 'string' && !index) return 'path';
    if (seg === '') return 'path-empty';
    if (typeof seg === 'string' && [...seg].some((c) => c.charCodeAt(0) < 32))
      return 'path-control';
    if (seg === '__proto__') return 'path-proto';
  }
  if (path.length === 0 && kind !== 'set') return 'root-op';
  return null;
}

const keyFor = (path: readonly Key[]): string =>
  JSON.stringify(path.map((s) => String(s)));
const plainRecord = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || isOpaque(v))
    return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const under = (anc: readonly Key[], p: readonly Key[]): boolean =>
  anc.length < p.length && anc.every((s, i) => String(s) === String(p[i]));

/** The reference predicate, from the contract's prose. */
function wellFormed(ops: readonly StoreOp[]): Reason | null {
  for (const op of ops) {
    const fault = opFault(op);
    if (fault) return fault;
  }
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(keyFor(op.path))) return 'dup-path';
    seen.add(keyFor(op.path));
  }
  for (let i = 0; i < ops.length; i++)
    for (let j = 0; j < ops.length; j++) {
      const anc = ops[j];
      if (!under(anc.path, ops[i].path)) continue;
      if (!(j < i && anc.kind === 'set' && plainRecord(anc.next)))
        return 'nested-path';
    }
  return null;
}

type Doc = Record<string, unknown>;
type Rep = {
  readonly origin: string;
  readonly s: WritableSignalStore<Doc>;
  readonly sync: OpSync<Doc>;
  readonly out: OpEnvelope[];
  readonly ctxs: (EmitContext | undefined)[];
  readonly rejected: string[];
};
type RepOpt = {
  emit?: DiffOpsOptions;
  leaves?: boolean;
  policies?: readonly MergePolicyEntry[];
};

function replica(origin: string, init: Doc = {}, opt?: RepOpt): Rep {
  return TestBed.runInInjectionContext(() => {
    const s = store<Doc>(init) as WritableSignalStore<Doc>;
    const rejected: string[] = [];
    const sync = opSync(s, {
      writer: 'w-' + origin,
      origin,
      clock: createHlcClock(() => 1),
      emit: opt?.emit ?? (opt?.leaves ? { added: 'leaves' } : undefined),
      policies: opt?.policies,
      onReject: (_e, reason) => rejected.push(reason),
    }) as OpSync<Doc>;
    const out: OpEnvelope[] = [];
    const ctxs: (EmitContext | undefined)[] = [];
    sync.subscribe((e, c) => (out.push(e), ctxs.push(c)));
    return { origin, s, sync, out, ctxs, rejected };
  });
}

function room(n: number, init: Doc = {}, opt?: RepOpt) {
  const reps = Array.from({ length: n }, (_, i) => replica('o' + i, init, opt));
  const cursor = reps.map(() => reps.map(() => 0));
  const next = (to: number, from: number): boolean => {
    if (to === from || cursor[to][from] >= reps[from].out.length) return false;
    reps[to].sync.receive(reps[from].out[cursor[to][from]++]);
    return true;
  };
  const deliverAll = (): void => {
    let moved = true;
    while (moved) {
      moved = false;
      reps.forEach((_, to) =>
        reps.forEach((_, from) => (moved = next(to, from) || moved)),
      );
    }
  };
  reps[0].sync.seed();
  deliverAll();
  return { reps, next, deliverAll };
}

const last = (r: Rep): OpEnvelope => r.out[r.out.length - 1];
const shape = (e: OpEnvelope) =>
  e.ops.map((o) => `${o.kind}:${o.path.join('.')}`);
const dot = (e: OpEnvelope) => ({ origin: e.origin, hlc: e.hlc });
const origins = (op: SyncOp) => op.cites.map((c) => c.origin).sort();
const set = (path: Key[], next: unknown, prev?: unknown): StoreOp =>
  prev === undefined
    ? { kind: 'set', path, next }
    : { kind: 'set', path, next, prev };
const del = (path: Key[], prev: unknown): StoreOp => ({
  kind: 'delete',
  path,
  prev,
});
const clr = (path: Key[]): StoreOp => ({ kind: 'clear', path });

function materialized(r: Rep, policies?: readonly MergePolicyEntry[]): unknown {
  const conv = createConvergingApply({ policies });
  conv.load(r.sync.snapshot().registers);
  return conv.materialize();
}

/** Every envelope well formed, nothing rejected, every store equal and equal to its registers. */
function expectSettled(
  reps: readonly Rep[],
  policies?: readonly MergePolicyEntry[],
): void {
  for (const r of reps) {
    for (const e of r.out) expect(validateEnvelope(e)).toBeNull();
    expect(r.rejected).toEqual([]);
  }
  for (const r of reps) expect(r.s()).toEqual(reps[0].s());
  for (const r of reps) expect(materialized(r, policies)).toEqual(r.s());
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (!isRec(a) || !isRec(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join('|') === kb.join('|') && ka.every((k) => deepEq(a[k], b[k]));
}
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('opSync stamp batch: the reference predicate', () => {
  it('a numeric segment and its string form are one path, as the engine keys them', () => {
    expect(wellFormed([set(['l', 0], 1), set(['l', '0'], 2)])).toBe('dup-path');
    const env: OpEnvelope = {
      proto: 5 as never,
      instance: '',
      origin: 'x',
      writer: 'w',
      version: 1,
      hlc: { p: 1, l: 1 },
      policyVersion: 0,
      ops: [
        { kind: 'set', path: ['l', 0], next: 1, cites: [], epoch: 0 },
        { kind: 'set', path: ['l', '0'], next: 2, cites: [], epoch: 0 },
      ],
    };
    expect(validateEnvelope(env)).toBe('dup-path');
  });

  it('shapes and reasons', () => {
    expect(
      wellFormed([
        set(['a'], {}),
        set(['a', 'b'], {}),
        set(['a', 'b', 'c'], 1),
      ]),
    ).toBeNull();
    expect(
      wellFormed([set(['a'], {}), clr(['a', 'y']), del(['b'], 1)]),
    ).toBeNull();
    expect(wellFormed([set(['a', 'y'], 1), set(['a'], {})])).toBe(
      'nested-path',
    );
    expect(wellFormed([del(['a'], {}), set(['a', 'b'], 7)])).toBe(
      'nested-path',
    );
    expect(wellFormed([set(['l'], [1]), set(['l', 0], 2)])).toBe('nested-path');
    expect(wellFormed([set(['a'], opaque({})), set(['a', 'b'], 1)])).toBe(
      'nested-path',
    );
    expect(
      wellFormed([set(['a'], {}), set(['a', 'y'], 1), set(['a', 'y'], 2)]),
    ).toBe('dup-path');
  });
});

type Mk = (rng: () => number, depth: number) => unknown;
// the diff contract's key domain: non-empty strings without control characters, never `__proto__`
const KEYS: readonly string[] = ['a', 'b', 'c'];
const leafOf = (rng: () => number): unknown => {
  const r = rng();
  if (r < 0.1) return null;
  if (r < 0.15) return undefined;
  return Math.floor(rng() * 5);
};
const valueOf: Mk = (rng, depth) => {
  const r = rng();
  if (depth > 2 || r < 0.3) return leafOf(rng);
  if (r < 0.65) {
    const o: Record<string, unknown> = rng() < 0.2 ? Object.create(null) : {};
    for (const k of KEYS) if (rng() < 0.5) o[k] = valueOf(rng, depth + 1);
    return o;
  }
  if (r < 0.85) {
    const xs = Array.from({ length: Math.floor(rng() * 3) }, () =>
      valueOf(rng, depth + 1),
    );
    if (xs.length && rng() < 0.2) {
      const hole = Math.floor(rng() * xs.length);
      const sparse: unknown[] = new Array(xs.length);
      xs.forEach((v, i) => {
        if (i !== hole) sparse[i] = v;
      });
      return sparse;
    }
    return xs;
  }
  return opaque(
    rng() < 0.5 ? { k: Math.floor(rng() * 5) } : [Math.floor(rng() * 5)],
  );
};
/** Copy-on-write edits along random paths, so untouched subtrees keep their references. */
function edit(root: unknown, rng: () => number, depth = 0): unknown {
  const r = rng();
  if (depth > 3 || r < 0.15) return valueOf(rng, depth);
  if (isRec(root) && !isOpaque(root)) {
    const copy: Record<string, unknown> = Object.assign(
      Object.getPrototypeOf(root) === null ? Object.create(null) : {},
      root,
    );
    const k = KEYS[Math.floor(rng() * KEYS.length)];
    if (rng() < 0.2) delete copy[k];
    else
      copy[k] = Object.hasOwn(copy, k)
        ? edit(copy[k], rng, depth + 1)
        : valueOf(rng, depth + 1);
    return copy;
  }
  if (Array.isArray(root) && !isOpaque(root) && root.length) {
    const copy = [...root];
    if (rng() < 0.3) copy.push(valueOf(rng, depth + 1));
    else {
      const i = Math.floor(rng() * copy.length);
      copy[i] = edit(copy[i], rng, depth + 1);
    }
    return copy;
  }
  return valueOf(rng, depth);
}
const ADDED: (AddedPolicy | undefined)[] = [
  undefined,
  'whole',
  'leaves',
  (path) => (path.length % 2 ? 'leaves' : 'whole'),
];
const ARRAYS: DiffOpsOptions['arrays'][] = [undefined, 'index', 'unit'];

/** Beyond W1 and W2: a child under an earlier array or opaque set. */
function underContainer(ops: readonly StoreOp[]): string | null {
  for (let i = 0; i < ops.length; i++)
    for (let j = 0; j < i; j++) {
      const anc = ops[j];
      if (anc.kind !== 'set' || !under(anc.path, ops[i].path)) continue;
      if (Array.isArray(anc.next)) return 'under-array';
      if (isOpaque(anc.next)) return 'under-opaque';
    }
  return null;
}

const WRITE_OPTIONS: RepOpt[] = [
  {},
  { emit: { added: 'leaves' } },
  { emit: { added: (p) => (p.length % 2 ? 'leaves' : 'whole') } },
  { emit: { arrays: 'index' } },
  { emit: { added: 'leaves', arrays: 'index' } },
  { emit: { added: 'leaves' }, policies: [{ path: 'a', merge: replace }] },
  { policies: [{ path: 'l', merge: keyedArray((x) => x) }] },
];
/** Random local writes through every write path a store has, then a restore of one tail. */
function writePaths(seed: number) {
  const rng = rngOf(seed * 7919);
  const opt = WRITE_OPTIONS[seed % WRITE_OPTIONS.length];
  const { reps, next, deliverAll } = room(2, { a: { b: 1 }, l: [1, 2] }, opt);
  const kinds = new Set<string>();
  // envelopes minted by a local write, by origin and index: each must carry its authored ops
  const minted = new Set<string>();
  const history = TestBed.runInInjectionContext(() =>
    storeHistory(reps[0].s, { track: reps[0].sync }),
  );
  for (let step = 0; step < 20; step++) {
    const w = Math.floor(rng() * 2);
    const rep = reps[w];
    const roll = rng();
    const before = rep.out.length;
    if (roll < 0.3) {
      rep.s.set(edit(rep.s(), rng) as Doc);
      rep.sync.flush();
      kinds.add('write');
    } else if (roll < 0.45) {
      rep.s.set(edit(rep.s(), rng) as Doc);
      rep.s.set(edit(rep.s(), rng) as Doc);
      rep.s.set(edit(rep.s(), rng) as Doc);
      rep.sync.flush();
      kinds.add('coalesced');
    } else if (roll < 0.6) {
      if (rng() < 0.5) {
        if (history.undo()) kinds.add('undo');
      } else if (history.redo()) kinds.add('redo');
    } else if (roll < 0.75) {
      const fork = TestBed.runInInjectionContext(() =>
        syncedFork(rep.sync, rep.s),
      );
      if (rng() < 0.5) next(w, 1 - w);
      fork.store.set(edit(fork.store(), rng) as Doc);
      fork.commit();
      kinds.add('fork');
    } else next(w, 1 - w);
    for (let i = before; i < rep.out.length; i++)
      minted.add(`${rep.origin}#${i}`);
  }
  deliverAll();
  history.destroy();
  const fresh = replica('restored', reps[0].s(), opt);
  const tail = reps[1].out.filter((e) => e.origin === 'o1');
  fresh.sync.restore(tail);
  if (fresh.out.length) kinds.add('restore');
  return { reps, fresh, kinds, minted, option: seed % WRITE_OPTIONS.length };
}

const KINDS: Record<string, () => unknown> = {
  record: () => ({ k: 1 }),
  array: () => [1],
  scalar: () => 3,
  opaque: () => opaque({ k: 1 }),
};
const OPTION_SETS: DiffOpsOptions[] = ADDED.flatMap((added) =>
  ARRAYS.map((arrays) => ({ added, arrays })),
);
const optionName = (o: DiffOpsOptions): string =>
  `${typeof o.added === 'function' ? 'per-path' : String(o.added)}/${String(o.arrays)}`;

describe('opSync stamp batch: the diff contract', () => {
  it('same-path kind transitions beside a sibling delete and a sibling add, per emit option set', () => {
    const failures: string[] = [];
    const reached = new Map<string, Set<string>>();
    for (const opt of OPTION_SETS) {
      const seen = new Set<string>();
      reached.set(optionName(opt), seen);
      for (const from of Object.keys(KINDS))
        for (const to of Object.keys(KINDS)) {
          if (from === to) continue;
          const cases: [string, unknown, unknown][] = [
            [
              'record',
              { t: KINDS[from](), s: 1, d: 2 },
              { t: KINDS[to](), s: 2, n: 5 },
            ],
            [
              'equal-length array',
              { l: [KINDS[from](), 0, 7] },
              { l: [KINDS[to](), 1, 7] },
            ],
          ];
          for (const [where, prev, next] of cases) {
            const ops = diffOps(prev, next, opt);
            const bad = wellFormed(ops) ?? underContainer(ops);
            if (bad)
              failures.push(
                `${optionName(opt)} ${where} ${from}->${to}: ${bad} ${JSON.stringify(ops)}`,
              );
            if (!deepEq(applyOps(prev, ops), next))
              failures.push(
                `${optionName(opt)} ${where} ${from}->${to}: no rebuild`,
              );
            if (where === 'record') {
              if (!ops.some((o) => o.kind === 'delete' && o.path[0] === 'd'))
                failures.push(`${optionName(opt)} ${from}->${to}: no delete`);
              if (!ops.some((o) => o.kind === 'set' && o.path[0] === 'n'))
                failures.push(`${optionName(opt)} ${from}->${to}: no add`);
            }
            seen.add(`${where} ${from}->${to}`);
          }
        }
    }
    expect(failures).toEqual([]);
    for (const [name, seen] of reached)
      expect({ name, size: seen.size }).toEqual({ name, size: 24 });
    expect(reached.size).toBe(12);
  });

  it('diffOps yields a well-formed batch for random documents under every emit option, keys from KEYS', () => {
    const failures: string[] = [];
    const nonEmpty = new Map<string, number>();
    for (let seed = 1; seed <= 400 && failures.length < 5; seed++) {
      const rng = rngOf(seed * 104729);
      const from = { root: valueOf(rng, 0) };
      const to = rng() < 0.8 ? edit(from, rng) : { root: valueOf(rng, 0) };
      for (const added of ADDED)
        for (const arrays of ARRAYS) {
          const opt: DiffOpsOptions = { added, arrays };
          const ops = diffOps(from, to, opt);
          if (ops.length)
            nonEmpty.set(
              optionName(opt),
              (nonEmpty.get(optionName(opt)) ?? 0) + 1,
            );
          const bad = wellFormed(ops) ?? underContainer(ops);
          if (bad)
            failures.push(
              `seed ${seed} ${String(added)}/${String(arrays)}: ${bad} ${JSON.stringify(ops)}`,
            );
          if (!deepEq(applyOps(from, ops), to))
            failures.push(`seed ${seed}: ops do not rebuild the target`);
        }
    }
    expect(failures).toEqual([]);
    for (const opt of OPTION_SETS)
      expect({
        opt: optionName(opt),
        enough: (nonEmpty.get(optionName(opt)) ?? 0) > 200,
      }).toEqual({ opt: optionName(opt), enough: true });
  });

  it('every opSync emission carries well-formed authored ops: writes, coalesced writes, undo and redo, fork commits', () => {
    const failures: string[] = [];
    const reached = WRITE_OPTIONS.map(() => new Set<string>());
    let required = 0;
    for (let seed = 1; seed <= 105; seed++) {
      const { reps, fresh, kinds, minted, option } = writePaths(seed);
      kinds.forEach((k) => reached[option].add(k));
      for (const r of [...reps, fresh])
        r.out.forEach((e, i) => {
          const raws = r.ctxs[i]?.raws;
          if (r !== fresh && minted.has(`${r.origin}#${i}`)) {
            required++;
            if (!raws) failures.push(`seed ${seed} ${r.origin}#${i}: no raws`);
          }
          const bad = raws && (wellFormed(raws) ?? underContainer(raws));
          if (bad)
            failures.push(
              `seed ${seed} ${r.origin}#${i}: ${bad} ${JSON.stringify(raws)}`,
            );
        });
    }
    expect(failures).toEqual([]);
    expect(required).toBeGreaterThan(300);
    expect(reached.map((k) => [...k].sort())).toEqual(
      WRITE_OPTIONS.map(() => [
        'coalesced',
        'fork',
        'redo',
        'restore',
        'undo',
        'write',
      ]),
    );
  });
});

describe('opSync stamp batch: well-formed batches', () => {
  it('every envelope those write paths send is valid, restored ones included', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 105 && failures.length < 5; seed++) {
      const { reps, fresh } = writePaths(seed);
      for (const r of [...reps, fresh])
        r.out.forEach((e, i) => {
          const bad = validateEnvelope(e);
          if (bad)
            failures.push(
              `seed ${seed} ${r.origin}#${i}: ${bad} ${JSON.stringify(shape(e))}`,
            );
        });
    }
    expect(failures).toEqual([]);
  });

  const leavesReAdd = (policies?: readonly MergePolicyEntry[]) => {
    const { reps, deliverAll } = room(2, {}, { leaves: true, policies });
    const [A, B] = reps;
    A.s.set({ a: { b: 1 } });
    A.sync.flush();
    deliverAll();
    A.s.set({});
    A.sync.flush();
    B.s.set({ a: { b: 5 } });
    B.sync.flush();
    A.sync.receive(last(B));
    A.s.set({ a: { b: 2 } });
    A.sync.flush();
    return { reps, deliverAll, A, env: last(A) };
  };

  it('leaves: re-adding a parent over a concurrent live child sends one op at the child', () => {
    const { reps, deliverAll, A, env } = leavesReAdd();
    expect(validateEnvelope(env)).toBeNull();
    expect(shape(env)).toEqual(['set:a', 'set:a.b']);
    expect(origins(env.ops[1])).toEqual(['o0', 'o1']);
    deliverAll();
    expectSettled(reps);
    expect(A.s()).toEqual({ a: { b: 2 } });
  });

  it('leaves under a replace policy: one op per path too', () => {
    const policies = [{ path: 'a', merge: replace }];
    const { reps, deliverAll, env } = leavesReAdd(policies);
    expect(validateEnvelope(env)).toBeNull();
    deliverAll();
    expectSettled(reps, policies);
  });

  it('leaves: two nested anchors over a concurrent live grandchild send one clear, at its first position', () => {
    const { reps, deliverAll } = room(2, {}, { leaves: true });
    const [A, B] = reps;
    A.s.set({ a: { b: { c: 1 } } });
    A.sync.flush();
    deliverAll();
    A.s.set({});
    A.sync.flush();
    B.s.set({ a: { b: { c: 5 } } });
    B.sync.flush();
    A.sync.receive(last(B));
    A.s.set({ a: { b: {} } });
    A.sync.flush();
    const env = last(A);
    expect(validateEnvelope(env)).toBeNull();
    expect(shape(env)).toEqual(['set:a', 'clear:a.b.c', 'set:a.b']);
    expect(origins(env.ops[1])).toEqual(['o0', 'o1']);
    deliverAll();
    expectSettled(reps);
    expect(A.s()).toEqual({ a: { b: {} } });
  });

  const liveChild = () => {
    const r = room(2, { a: { y: 0 } });
    r.reps[0].sync.emitOps([set(['a', 'y'], 4, 0)]);
    r.deliverAll();
    return r;
  };

  it('raw: a sibling between the anchor and the child keeps the child after it', () => {
    const { reps, deliverAll } = liveChild();
    const pre = reps[0].s();
    const ops = [
      set(['a'], {}, { y: 4 }),
      set(['a', 'b'], {}),
      set(['a', 'y'], 5),
    ];
    reps[0].sync.emitOps(ops);
    const env = last(reps[0]);
    expect(validateEnvelope(env)).toBeNull();
    expect(shape(env)).toEqual(['set:a', 'set:a.b', 'set:a.y']);
    expect(env.ops[1]).toEqual({
      kind: 'set',
      path: ['a', 'b'],
      next: {},
      cites: [],
      epoch: 0,
    });
    expect(reps[0].s()).toEqual(applyOps(pre, ops));
    deliverAll();
    expectSettled(reps);
  });

  it('raw: a bumped batch climbs one epoch at every path it touches', () => {
    const { reps } = liveChild();
    reps[0].sync.emitOps([set(['a'], {}, { y: 4 }), set(['a', 'y'], 5)], {
      bump: true,
    });
    const env = last(reps[0]);
    expect(validateEnvelope(env)).toBeNull();
    expect(
      env.ops.map((o) => `${o.kind}:${o.path.join('.')}@${o.epoch}`),
    ).toEqual(['set:a@1', 'set:a.y@1']);
  });

  it('scope: three emissions over a foreign child the frontier does not cover', () => {
    const { reps, deliverAll } = room(2, {}, { leaves: true });
    const [A, B] = reps;
    const frontier = A.sync.captureFrontier();
    B.s.set({ a: { b: 9 } });
    B.sync.flush();
    A.sync.receive(last(B));
    A.sync.commitScope(frontier, () => {
      A.sync.emitOps([set(['a'], {}), set(['a', 'b'], 1)]);
      A.sync.emitOps([del(['a'], { b: 1 })]);
      A.sync.emitOps([set(['a'], {}), set(['a', 'b'], 2)]);
    });
    expect(A.out.slice(-3).map(shape)).toEqual([
      ['set:a', 'set:a.b'],
      ['delete:a', 'clear:a.b'],
      ['set:a', 'set:a.b'],
    ]);
    deliverAll();
    expectSettled(reps);
  });

  it('scope: a restored-tail sibling outside the frontier, the third emission is one op per path', () => {
    const env = (
      origin: string,
      l: number,
      version: number,
      ops: SyncOp[],
    ): OpEnvelope => ({
      proto: 5 as never,
      instance: '',
      origin,
      writer: 'w',
      version,
      hlc: { p: 1, l },
      policyVersion: 0,
      ops,
    });
    const conv = createConvergingApply({ origin: 'N' });
    const frontier = conv.captureFrontier();
    const tail = conv.stamp([set(['a'], {}), set(['a', 'b'], 9)]);
    conv.ingest(env('O', 1, 1, tail), { local: true, reconcile: true });
    const since = { origin: 'N', seq: conv.captureFrontier().seq };
    const emit = (l: number, v: number, ops: StoreOp[]): OpEnvelope => {
      const e = env('N', l, v, conv.stamp(ops, { frontier, since }));
      conv.ingest(e, { local: true, reconcile: true });
      return e;
    };
    emit(2, 1, [set(['a'], {}), set(['a', 'b'], 1)]);
    const second = emit(3, 2, [del(['a'], { b: 1 })]);
    const third = emit(4, 3, [set(['a'], {}), set(['a', 'b'], 2)]);
    expect(validateEnvelope(third)).toBeNull();
    expect(third.ops.map((o) => `${o.kind}:${o.path.join('.')}`)).toEqual([
      'set:a',
      'set:a.b',
    ]);
    expect(third.ops[1].cites).toEqual([dot(second)]);
    expect(
      conv
        .liveAt(['a', 'b'])
        .map((s) => s.origin)
        .sort(),
    ).toEqual(['N', 'O']);
  });
});

describe('opSync stamp batch: unchanged envelopes', () => {
  it('a leaves add with no live child, a replace over a live child, a bumped batch on distinct paths', () => {
    const { reps } = room(2, {}, { leaves: true });
    const [A, B] = reps;
    A.s.set({ a: { b: 1 } });
    A.sync.flush();
    expect(last(A).ops).toEqual([
      { kind: 'set', path: ['a'], next: {}, cites: [], epoch: 0 },
      { kind: 'set', path: ['a', 'b'], next: 1, cites: [], epoch: 0 },
    ]);
    const add = last(A);
    B.sync.receive(add);
    B.s.set({ a: 7 });
    B.sync.flush();
    expect(last(B).ops).toEqual([
      {
        kind: 'set',
        path: ['a'],
        prev: { b: 1 },
        next: 7,
        cites: [dot(add)],
        epoch: 0,
      },
      { kind: 'clear', path: ['a', 'b'], cites: [dot(add)], epoch: 0 },
    ]);
    const replaced = last(B);
    A.sync.receive(replaced);
    A.sync.emitOps([set(['m'], 1), set(['a'], 3, 7)], { bump: true });
    expect(last(A).ops).toEqual([
      { kind: 'set', path: ['m'], next: 1, cites: [], epoch: 1 },
      {
        kind: 'set',
        path: ['a'],
        prev: 7,
        next: 3,
        cites: [dot(replaced)],
        epoch: 1,
      },
    ]);
  });
});

const BAD_SEGMENTS: unknown[] = ['', 'a\u0002', '__proto__', -1, 1.5, ['x']];
/** One op of the batch made unable to travel: a bad segment, a root op, an unknown kind or no op. */
function corrupt(rng: () => number, ops: readonly StoreOp[]): StoreOp[] {
  const out = [...ops];
  const i = Math.floor(rng() * out.length);
  const roll = rng();
  if (roll < 0.5) {
    const path = [...out[i].path] as unknown[];
    path[Math.floor(rng() * path.length)] =
      BAD_SEGMENTS[Math.floor(rng() * BAD_SEGMENTS.length)];
    out[i] = { ...out[i], path } as StoreOp;
  } else if (roll < 0.7) out.splice(i, 0, rng() < 0.5 ? del([], {}) : clr([]));
  else if (roll < 0.85) out[i] = { ...out[i], kind: 'move' } as never;
  else out[i] = null as never;
  return out;
}

describe('opSync stamp batch: ill-formed batches are refused', () => {
  const cases: [string, StoreOp[], Reason][] = [
    ['set/set', [set(['m'], 1), set(['m'], 2, 1)], 'dup-path'],
    ['set/clear', [set(['a'], {}, { y: 4 }), clr(['a'])], 'dup-path'],
    ['set/delete', [set(['a', 'y'], 1, 4), del(['a', 'y'], 1)], 'dup-path'],
    ['delete/set', [del(['a', 'y'], 4), set(['a', 'y'], 3)], 'dup-path'],
    [
      'a numeric segment and its string form',
      [set(['l', 0], 5, 1), set(['l', '0'], 6, 5)],
      'dup-path',
    ],
    [
      'two whole-array sets at a keyedArray path',
      [set(['l'], [1], [1, 2]), set(['l'], [3], [1])],
      'dup-path',
    ],
    [
      'a child before its ancestor',
      [set(['a', 'y'], 5, 4), set(['a'], { b: {} }, { y: 5 })],
      'nested-path',
    ],
    [
      'a child under a delete',
      [del(['a'], { y: 4 }), set(['a', 'b'], 7)],
      'nested-path',
    ],
    [
      'a child under a clear',
      [clr(['a']), set(['a', 'y'], 1, 4)],
      'nested-path',
    ],
    [
      'a child under a non-record set',
      [set(['a'], 5, { y: 4 }), set(['a', 'b'], 1)],
      'nested-path',
    ],
    [
      'a child under an array set',
      [set(['l'], [7, 8], [1, 2]), set(['l', 0], 9, 7)],
      'nested-path',
    ],
    [
      'a child under an opaque record set',
      [set(['a'], opaque({}), { y: 4 }), set(['a', 'b'], 1)],
      'nested-path',
    ],
    ['an op that is not a record', [set(['m'], 1, 0), null as never], 'op'],
    [
      'an unknown op kind',
      [set(['m'], 1, 0), { kind: 'move', path: ['a'] } as never],
      'kind',
    ],
    [
      'a path that is not an array',
      [{ kind: 'set', path: 'm', next: 1 } as never],
      'path',
    ],
    ['a negative index', [set(['m'], 1, 0), set(['l', -1], 1)], 'path'],
    ['a fractional index', [set(['l', 0.5], 1)], 'path'],
    ['an empty segment', [set(['m'], 1, 0), set(['a', ''], 1)], 'path-empty'],
    [
      'a segment with a control character',
      [set(['a\u0001b'], 1)],
      'path-control',
    ],
    ['a __proto__ segment', [set(['a', '__proto__'], 1)], 'path-proto'],
    ['a lone root delete', [del([], {})], 'root-op'],
    ['a root clear', [set(['m'], 1, 0), clr([])], 'root-op'],
    [
      'a path fault after a repeated path: the path fault is reported',
      [set(['m'], 1, 0), set(['m'], 2, 1), set(['a', ''], 1)],
      'path-empty',
    ],
  ];
  /** A replica with an own live child and a store write still pending. */
  const refusalWorld = () => {
    const { reps } = room(2, { a: { y: 0 }, l: [1, 2], m: 0 });
    const A = reps[0];
    A.sync.emitOps([set(['a', 'y'], 4, 0)]);
    A.s.set({ ...A.s(), z: 1 });
    return A;
  };
  /** Everything a refusal must leave as it was, read the same way on both replicas. */
  const probe = (A: Rep) => {
    const sent = A.out.length;
    const wm = A.sync.watermark();
    const floors = A.sync.floors();
    const registers = JSON.stringify(A.sync.snapshot().registers);
    const store = JSON.stringify(A.s());
    A.sync.flush();
    const pending = A.out.slice(sent);
    const frontier = A.sync.captureFrontier();
    A.sync.emitOps([set(['m'], 9, 0)]);
    const nextStamp = last(A).hlc;
    return { sent, wm, floors, registers, store, pending, frontier, nextStamp };
  };
  for (const [name, ops, reason] of cases)
    it(`${name}: emitOps throws, and nothing moves next to a replica that never made the call`, () => {
      expect(wellFormed(ops)).toBe(reason);
      const A = refusalWorld();
      const control = refusalWorld();
      const store = A.s();
      let message: string | undefined;
      try {
        A.sync.emitOps(ops);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(
        `[@mmstack/primitives] emitOps: ill-formed batch (${reason})`,
      );
      expect(A.s()).toBe(store);
      const got = probe(A);
      expect(got).toEqual(probe(control));
      expect(got.pending.map(shape)).toEqual([['set:z']]);
    });

  it('parity: the library predicate agrees with the reference on every shape', () => {
    const lib = (core as unknown as Record<string, unknown>)['validateOps'] as
      | ((ops: readonly StoreOp[]) => string | null)
      | undefined;
    expect(typeof lib).toBe('function');
    const shapes = [
      ...cases.map(([, ops]) => ops),
      [set(['a'], {}), set(['a', 'b'], {}), set(['a', 'b', 'c'], 1)],
      [set(['a'], {}), clr(['a', 'y']), del(['b'], 1)],
      [set(['a'], opaque({})), set(['a', 'b'], 1)],
      [set(['a'], Object.create(null)), set(['a', 'b'], 1)],
      [set(['a'], null), set(['a', 'b'], 1)],
      [set(['m'], 1)],
      [],
    ];
    for (const ops of shapes) expect(lib?.(ops)).toBe(wellFormed(ops));
    const reasons = new Map<string, number>();
    for (let seed = 1; seed <= 300; seed++) {
      const rng = rngOf(seed * 31);
      const ops = batchFor(rng, INIT);
      for (const batch of [
        ops,
        [...ops].reverse(),
        [...ops, ops[Math.floor(rng() * ops.length)]],
        ops.map((o) =>
          o.kind === 'set' && rng() < 0.3 ? { ...o, next: opaque({}) } : o,
        ),
        corrupt(rng, ops),
      ]) {
        const want = wellFormed(batch);
        reasons.set(String(want), (reasons.get(String(want)) ?? 0) + 1);
        expect({ batch, got: lib?.(batch) }).toEqual({ batch, got: want });
      }
    }
    expect([...reasons.keys()].sort()).toEqual([
      'dup-path',
      'kind',
      'nested-path',
      'null',
      'op',
      'path',
      'path-control',
      'path-empty',
      'path-proto',
      'root-op',
    ]);
  });

  it('parity: prefixes and repeats are found under the register keying, numeric and string segments alike', () => {
    const lib = (core as unknown as Record<string, unknown>)['validateOps'] as (
      ops: readonly StoreOp[],
    ) => string | null;
    const segs: Key[] = ['a', 'b', 0, 1, '0', '1', 'a\u00a0'];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const rng = rngOf(seed * 53);
      const pathOf = (): Key[] =>
        Array.from(
          { length: 1 + Math.floor(rng() * 4) },
          () => segs[Math.floor(rng() * segs.length)],
        );
      const p = pathOf();
      const q =
        rng() < 0.4 ? p.slice(0, Math.floor(rng() * p.length)) : pathOf();
      const env: OpEnvelope = {
        proto: 5 as never,
        instance: '',
        origin: 'x',
        writer: 'w',
        version: 1,
        hlc: { p: 1, l: 1 },
        policyVersion: 0,
        ops: [q, p].map((path) => ({
          kind: 'set',
          path,
          next: {},
          cites: [],
          epoch: 0,
        })),
      };
      const same = validateEnvelope(env) === 'dup-path';
      const qOverP = !same && under(q, p);
      const pOverQ = !same && under(p, q);
      const anchored = lib([set(q, {}), set(p, 1)]);
      const reversed = lib([set(p, 1), set(q, {})]);
      expect({ p, q, anchored, reversed }).toEqual({
        p,
        q,
        anchored: same ? 'dup-path' : pOverQ ? 'nested-path' : null,
        reversed: same ? 'dup-path' : qOverP || pOverQ ? 'nested-path' : null,
      });
      seen.add(same ? 'same' : qOverP ? 'prefix' : 'apart');
    }
    expect([...seen].sort()).toEqual(['apart', 'prefix', 'same']);
  });
});

const PATHS: string[][] = [
  ['a'],
  ['a', 'b'],
  ['a', 'b', 'c'],
  ['a', 'y'],
  ['b'],
  ['b', 'm'],
  ['m'],
];
const INIT: Doc = { a: { b: { c: 0 }, y: 0 }, b: { m: 0 }, m: 0 };
const lookup = (root: unknown, path: readonly Key[]) => {
  let cur = root;
  for (const seg of path) {
    if (!isRec(cur) || !Object.hasOwn(cur, seg))
      return { found: false, value: undefined };
    cur = cur[seg];
  }
  return { found: true, value: cur };
};
function underRecords(pre: unknown, ops: readonly StoreOp[]): boolean {
  let cur = pre;
  for (const op of ops) {
    if (op.kind === 'clear' || !op.path.length) return false;
    const parent = lookup(cur, op.path.slice(0, -1));
    if (!parent.found || !isRec(parent.value)) return false;
    cur = applyOps(cur, [op]);
  }
  return true;
}
function batchFor(rng: () => number, cur: unknown): StoreOp[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const n = (): number => 1 + Math.floor(rng() * 9);
  const value = (p: readonly string[]): unknown => {
    const k = p.join('.');
    if (k === 'a') return rng() < 0.5 ? {} : { b: { c: n() }, y: n() };
    if (k === 'a.b') return rng() < 0.5 ? {} : { c: n() };
    if (k === 'b') return { m: n() };
    return n();
  };
  if (rng() < 0.4) {
    const p = pick([['a'], ['a', 'b'], ['b']]);
    const out: StoreOp[] = [set(p, {}, lookup(cur, p).value)];
    const v = value(p);
    if (isRec(v))
      for (const k of Object.keys(v)) out.push(set([...p, k], v[k]));
    return out;
  }
  const ops: StoreOp[] = [];
  let at = cur;
  const len = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < len; i++) {
    const p = pick(PATHS);
    const here = lookup(at, p);
    const roll = rng();
    const op: StoreOp =
      roll < 0.15
        ? clr(p)
        : roll < 0.3 && here.found
          ? del(p, here.value)
          : set(p, value(p), here.value);
    ops.push(op);
    at = applyOps(at, [op]);
  }
  return ops;
}

describe('opSync stamp batch: seeded property on the engine', () => {
  const run = (keep: (ops: readonly StoreOp[]) => boolean) => {
    const failures: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 40 && failures.length < 3; seed++) {
      const rng = rngOf(seed * 7919);
      const { reps, next, deliverAll } = room(3, INIT, { leaves: rng() < 0.5 });
      for (let step = 0; step < 25; step++) {
        const w = Math.floor(rng() * 3);
        const roll = rng();
        if (roll < 0.5) {
          const synced = rng() < 0.4;
          if (synced) deliverAll();
          const pres = reps.map((r) => r.s());
          const ops = batchFor(rng, pres[w]);
          if (!keep(ops)) continue;
          checked++;
          const reason = wellFormed(ops);
          const sent = reps[w].out.length;
          if (reason) {
            let threw = false;
            try {
              reps[w].sync.emitOps(ops);
            } catch {
              threw = true;
            }
            if (
              !threw ||
              reps[w].out.length !== sent ||
              reps[w].s() !== pres[w]
            )
              failures.push(
                `seed ${seed} step ${step}: ${reason} not refused ${JSON.stringify(ops)}`,
              );
            continue;
          }
          reps[w].sync.emitOps(ops, { bump: rng() < 0.25 });
          const env = last(reps[w]);
          const bad = validateEnvelope(env);
          if (bad)
            failures.push(
              `seed ${seed} step ${step}: ${bad} ${JSON.stringify(shape(env))}`,
            );
          if (synced) {
            deliverAll();
            reps.forEach((r, i) => {
              if (
                underRecords(pres[i], ops) &&
                !deepEq(r.s(), applyOps(pres[i], ops))
              )
                failures.push(
                  `seed ${seed} step ${step}: ${r.origin} store ${JSON.stringify(shape(env))}`,
                );
            });
          }
        } else next(w, Math.floor(rng() * 3));
      }
      deliverAll();
      for (const r of reps) {
        if (r.rejected.length)
          failures.push(`seed ${seed}: ${r.origin} rejected ${r.rejected[0]}`);
        if (!deepEq(r.s(), reps[0].s()))
          failures.push(`seed ${seed}: ${r.origin} diverged`);
        if (!deepEq(materialized(r), r.s()))
          failures.push(`seed ${seed}: ${r.origin} store is not its registers`);
      }
    }
    return { failures, checked };
  };

  it('well-formed random batches: every envelope valid, batches under records land as written, replicas converge', () => {
    const { failures, checked } = run((ops) => wellFormed(ops) === null);
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it('valid envelope metadata, registers built from valid envelopes: any batch validateOps accepts emits a valid envelope', () => {
    const failures: string[] = [];
    let accepted = 0;
    let refused = 0;
    for (let seed = 1; seed <= 40 && failures.length < 3; seed++) {
      const rng = rngOf(seed * 6151);
      const { reps, next } = room(3, INIT, { leaves: rng() < 0.5 });
      for (let step = 0; step < 30; step++) {
        const w = Math.floor(rng() * 3);
        const r = reps[w];
        const roll = rng();
        if (roll < 0.5) {
          const base = batchFor(rng, r.s());
          const pick = rng();
          const batch =
            pick < 0.3
              ? corrupt(rng, base)
              : pick < 0.45
                ? [...base].reverse()
                : base;
          if (core.validateOps(batch) !== null) {
            refused++;
            continue;
          }
          accepted++;
          r.sync.emitOps(batch, { bump: rng() < 0.25 });
          const bad = validateEnvelope(last(r));
          if (bad)
            failures.push(
              `seed ${seed} step ${step}: ${bad} ${JSON.stringify(shape(last(r)))}`,
            );
        } else if (roll < 0.65) {
          r.s.set(edit(r.s(), rng) as Doc);
          r.sync.flush();
        } else next(w, Math.floor(rng() * 3));
      }
      for (const r of reps) {
        for (const e of r.out)
          if (validateEnvelope(e))
            failures.push(
              `seed ${seed}: ${r.origin} sent ${validateEnvelope(e)}`,
            );
        if (r.rejected.length)
          failures.push(`seed ${seed}: ${r.origin} rejected ${r.rejected[0]}`);
      }
    }
    expect(failures).toEqual([]);
    expect(accepted).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(50);
  });

  it('ill-formed random batches are refused and change nothing', () => {
    const { failures, checked } = run((ops) => wellFormed(ops) !== null);
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });
});
