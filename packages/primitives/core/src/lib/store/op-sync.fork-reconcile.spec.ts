import { TestBed } from '@angular/core/testing';
import { createHlcClock } from './hlc';
import {
  applyOps,
  type DiffOpsOptions,
  type EmitContext,
  type StoreOp,
} from './op-log';
import {
  createConvergingApply,
  keyedArray,
  opSync,
  syncedFork,
  type FoldFn,
  type FoldPolicyEntry,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
} from './op-sync';
import { store } from './store';
import { storeHistory } from './store-history';
import type { WritableSignalStore } from './types';

// The committer of a fork is a replica like any other: after its own commit, its store must equal the
// materialization of its own registers (what every peer's store becomes on receiving the same envelope).

type Item = { id: string; v: number };
type Root = {
  a?: { x?: number; y?: number } | number;
  b?: { m?: number };
  m?: number;
  w?: number;
  list?: Item[];
  arr?: number[];
  c?: { p?: number; q?: number };
  z?: number;
};
const INIT: Root = {
  a: { x: 0, y: 0 },
  b: { m: 0 },
  m: 0,
  w: 0,
  list: [
    { id: 'p', v: 0 },
    { id: 'q', v: 0 },
  ],
  arr: [0, 0],
};

// numeric max among the top-epoch writes; a lone sibling folds to itself (the fold law)
const maxFold: FoldFn = (siblings) => {
  const epoch = Math.max(...siblings.map((s) => s.epoch));
  const top = siblings.filter((s) => s.epoch === epoch && s.kind !== 'clear');
  if (!top.length) return { kind: 'clear' };
  const nums = top.filter(
    (s) => s.kind === 'set' && typeof s.value === 'number',
  );
  if (nums.length)
    return {
      kind: 'set',
      value: Math.max(...nums.map((s) => s.value as number)),
    };
  return { kind: 'delete' };
};
const FOLDS: FoldPolicyEntry[] = [
  { path: 'm', fold: maxFold },
  { path: 'b.m', fold: maxFold },
];
const POLICIES: MergePolicyEntry[] = [
  { path: 'list', merge: keyedArray((i) => (i as Item).id) },
];

type Rep = {
  readonly s: WritableSignalStore<Root>;
  readonly sync: OpSync<Root>;
  readonly out: OpEnvelope[];
  readonly ctxs: (EmitContext | undefined)[];
};

function replica(origin: string, emit?: DiffOpsOptions): Rep {
  return TestBed.runInInjectionContext(() => {
    const s = store<Root>(INIT);
    const sync = opSync(s, {
      writer: 'w-' + origin,
      origin,
      clock: createHlcClock(() => 1),
      folds: FOLDS,
      policies: POLICIES,
      emit,
    }) as OpSync<Root>;
    const out: OpEnvelope[] = [];
    const ctxs: (EmitContext | undefined)[] = [];
    sync.subscribe((e, c) => (out.push(e), ctxs.push(c)));
    return { s, sync, out, ctxs };
  });
}

/** A seeded room; per-origin FIFO delivery, any interleaving across origins. */
function room(n: number, emit?: DiffOpsOptions) {
  const reps = Array.from({ length: n }, (_, i) => replica('o' + i, emit));
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
  // a duplicate re-sends one already delivered; one ahead of the cursor would be a gap, not a duplicate
  const delivered = (to: number, from: number): OpEnvelope[] =>
    to === from ? [] : reps[from].out.slice(0, cursor[to][from]);
  return {
    reps,
    next,
    deliverAll,
    delivered,
    destroy: () => reps.forEach((r) => r.sync.destroy()),
  };
}

/** What this replica's own registers materialize, read through a fresh register of the same folds. */
function materialized(r: Rep): unknown {
  const conv = createConvergingApply({ policies: POLICIES, folds: FOLDS });
  conv.load(r.sync.snapshot().registers);
  return conv.materialize();
}

const write = (r: Rep, ops: readonly StoreOp[]): void => {
  r.s.set(applyOps(r.s(), ops));
  r.sync.flush();
};
const set = (path: (string | number)[], next: unknown): StoreOp => ({
  kind: 'set',
  path,
  next,
});
const del = (path: string[], prev: unknown): StoreOp => ({
  kind: 'delete',
  path,
  prev,
});
type Commit = (
  r: Rep,
  base: () => void,
  edit: (root: Root) => Root,
  raw: StoreOp[],
) => void;
/** The two committing seams: a synced fork, and `emitOps` inside `commitScope`. */
const SEAMS: Record<string, Commit> = {
  'syncedFork().commit()': (r, base, edit) => {
    const fk = syncedFork(r.sync as OpSync, r.s);
    base();
    fk.store.set(edit(fk.store()));
    fk.commit();
  },
  'emitOps inside commitScope': (r, base, _edit, raw) => {
    const frontier = r.sync.captureFrontier();
    base();
    r.sync.commitScope(frontier, () => r.sync.emitOps(raw));
  },
};

type Row = {
  /** What the base receives after the fork observed it (written by replica 1, delivered to 0). */
  readonly mid: (peer: Rep) => void;
  readonly edit: (root: Root) => Root;
  readonly raw: StoreOp[];
  /** The value every replica must show, the committer included. */
  readonly settled: (root: Root) => unknown;
  readonly want: unknown;
};
const ROWS: Record<string, Row> = {
  '(a) custom max fold: a lower committed value loses': {
    mid: (p) => write(p, [set(['m'], 9)]),
    edit: (r) => ({ ...r, m: 3 }),
    raw: [{ kind: 'set', path: ['m'], next: 3, prev: 9 }],
    settled: (r) => r.m,
    want: 9,
  },
  '(a) last-writer-wins: a concurrent bumped write outranks the commit': {
    mid: (p) => p.sync.override(() => write(p, [set(['w'], 9)])),
    edit: (r) => ({ ...r, w: 3 }),
    raw: [{ kind: 'set', path: ['w'], next: 3, prev: 9 }],
    settled: (r) => r.w,
    want: 9,
  },
  '(b) a child edit under a parent a bumped delete removed': {
    mid: (p) => p.sync.override(() => write(p, [del(['a'], p.s().a)])),
    edit: (r) => ({ ...r, a: { x: 2 } }),
    raw: [{ kind: 'set', path: ['a', 'x'], next: 2, prev: 0 }],
    settled: (r) => Object.hasOwn(r, 'a'),
    want: false,
  },
  '(a) keyedArray policy: the commit removes an item the base edited (an edit beats a removal)':
    {
      mid: (p) =>
        write(p, [
          set(
            ['list'],
            [
              { id: 'p', v: 0 },
              { id: 'q', v: 5 },
            ],
          ),
        ]),
      edit: (r) => ({ ...r, list: [{ id: 'p', v: 0 }] }),
      raw: [
        {
          kind: 'set',
          path: ['list'],
          next: [{ id: 'p', v: 0 }],
          prev: [
            { id: 'p', v: 0 },
            { id: 'q', v: 5 },
          ],
        },
      ],
      settled: (r) => r.list,
      want: [
        { id: 'p', v: 0 },
        { id: 'q', v: 5 },
      ],
    },
  '(a) positional array fold: a concurrent bumped array write outranks the commit':
    {
      mid: (p) => p.sync.override(() => write(p, [set(['arr'], [5, 0])])),
      edit: (r) => ({ ...r, arr: [0, 7] }),
      raw: [{ kind: 'set', path: ['arr'], next: [0, 7], prev: [5, 0] }],
      settled: (r) => r.arr,
      want: [5, 0],
    },
  '(b) array: an element edit under an array a bumped delete removed': {
    mid: (p) => p.sync.override(() => write(p, [del(['list'], p.s().list)])),
    edit: (r) => ({ ...r, list: [{ id: 'p', v: 3 }] }),
    raw: [
      {
        kind: 'set',
        path: ['list', 0],
        next: { id: 'p', v: 3 },
        prev: { id: 'p', v: 0 },
      },
    ],
    settled: (r) => Object.hasOwn(r, 'list'),
    want: false,
  },
};

describe('fork commit reconcile: the committer shows what its registers and every peer show', () => {
  for (const [seam, commit] of Object.entries(SEAMS)) {
    describe(seam, () => {
      for (const [name, row] of Object.entries(ROWS)) {
        it(name, () => {
          const x = room(2);
          const [a, b] = x.reps;
          commit(a, () => (row.mid(b), x.deliverAll()), row.edit, row.raw);
          expect(row.settled(a.s())).toEqual(row.want);
          expect(a.s()).toEqual(materialized(a));
          x.deliverAll();
          expect(row.settled(b.s())).toEqual(row.want);
          expect(a.s()).toEqual(b.s());
          x.destroy();
        });
      }
    });
  }

  it('(b) unbumped on a synced fork already holds: the edit lifts to the parent and the commit wins', () => {
    const x = room(2);
    const [a, b] = x.reps;
    SEAMS['syncedFork().commit()'](
      a,
      () => (write(b, [del(['a'], b.s().a)]), x.deliverAll()),
      (r) => ({ ...r, a: { x: 2 } }),
      [],
    );
    expect(a.s().a).toEqual({ x: 2 });
    expect(a.s()).toEqual(materialized(a));
    x.deliverAll();
    expect(a.s()).toEqual(b.s());
    x.destroy();
  });

  it('(b) unbumped through emitOps: a raw child edit under a concurrently deleted parent', () => {
    const x = room(2);
    const [a, b] = x.reps;
    SEAMS['emitOps inside commitScope'](
      a,
      () => (write(b, [del(['a'], b.s().a)]), x.deliverAll()),
      (r) => r,
      [{ kind: 'set', path: ['a', 'x'], next: 2, prev: 0 }],
    );
    expect(Object.hasOwn(a.s(), 'a')).toBe(false);
    expect(a.s()).toEqual(materialized(a));
    x.deliverAll();
    expect(a.s()).toEqual(b.s());
    x.destroy();
  });
});

describe('fork commit reconcile: reference identity and no echo', () => {
  it('a commit whose fold result did not change leaves the store holding the very objects it held', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(a, [set(['b', 'm'], 4)]);
    x.deliverAll();
    const fk = syncedFork(a.sync as OpSync, a.s);
    // a type change travels as one set at `a` on both sides, and the bumped one outranks the commit
    // (a record written over a record would diff to `a.x` and `a.y`, leaving `a` to the commit)
    b.sync.override(() => write(b, [set(['a'], 5)]));
    x.deliverAll();
    const before = a.s();
    fk.store.set({ ...fk.store(), a: 7 });
    fk.commit();
    expect(a.s().b).toBe(before.b);
    expect(a.s().list).toBe(before.list);
    expect(a.s().a).toBe(5);
    expect(a.s()).toBe(before);
    agrees(x);
    x.destroy();
  });

  it('a commit that wins keeps every untouched subtree, a register-holding one included', () => {
    const x = room(2);
    const [a] = x.reps;
    write(a, [set(['b', 'm'], 4)]);
    const fk = syncedFork(a.sync as OpSync, a.s);
    const before = a.s();
    fk.store.set({ ...fk.store(), w: 5 });
    fk.commit();
    expect(a.s().w).toBe(5);
    expect(a.s().b).toBe(before.b);
    expect(a.s().a).toBe(before.a);
    x.destroy();
  });

  it('the reconcile emits nothing: one commit is one envelope, before and after a flush and a tick', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const fk = syncedFork(a.sync as OpSync, a.s);
    write(b, [set(['m'], 9)]);
    x.deliverAll();
    const sent = a.out.length;
    fk.store.set({ ...fk.store(), m: 3 });
    fk.commit();
    a.sync.flush();
    TestBed.tick();
    a.sync.flush();
    expect(a.out.length).toBe(sent + 1);
    const frontier = a.sync.captureFrontier();
    write(b, [set(['m'], 12)]);
    x.deliverAll();
    a.sync.commitScope(frontier, () => a.sync.emitOps([set(['m'], 1)]));
    a.sync.flush();
    TestBed.tick();
    expect(a.out.length).toBe(sent + 2);
    x.destroy();
  });
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b))
    return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join('|') === kb.join('|') && ka.every((k) => same(a[k], b[k]));
}
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const PATHS: string[][] = [
  [],
  ['a'],
  ['a', 'x'],
  ['a', 'y'],
  ['b'],
  ['b', 'm'],
  ['m'],
  ['w'],
  ['list'],
  ['arr'],
];
function valueFor(path: readonly string[], rng: () => number): unknown {
  const n = () => 1 + Math.floor(rng() * 9);
  const items = () =>
    ['p', 'q', 'r'].filter(() => rng() < 0.7).map((id) => ({ id, v: n() }));
  switch (path.join('.')) {
    case '':
      return {
        a: { x: n(), y: n() },
        b: { m: n() },
        m: n(),
        w: n(),
        list: items(),
        arr: [n(), n()],
      };
    case 'a':
      return rng() < 0.15 ? n() : rng() < 0.5 ? { x: n() } : { x: n(), y: n() };
    case 'b':
      return { m: n() };
    case 'list':
      return items();
    case 'arr':
      return [n(), n()];
    default:
      return n();
  }
}
function opFor(root: unknown, rng: () => number): StoreOp {
  const path = PATHS[Math.floor(rng() * PATHS.length)];
  let cur: unknown = root;
  let found = true;
  for (const seg of path) {
    if (!isObj(cur) || !Object.hasOwn(cur, seg)) {
      found = false;
      break;
    }
    cur = cur[seg];
  }
  if (path.length && rng() < 0.15) return { kind: 'delete', path, prev: cur };
  const next = valueFor(path, rng);
  return found
    ? { kind: 'set', path, next, prev: cur }
    : { kind: 'set', path, next };
}

type Broken = {
  seed: number;
  step: number;
  act: string;
  law: string;
  at: string;
};

/** One random interleaving over the real engine; the first law broken, or null. */
function scenario(
  seed: number,
  opt: { forks: boolean; steps: number },
): Broken | null {
  const rng = rngOf(seed);
  const x = room(3);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const forks: { r: number; fk: ReturnType<typeof syncedFork<Root>> }[] = [];
  const frontiers: { r: number; f: ReturnType<OpSync['captureFrontier']> }[] =
    [];
  try {
    for (let step = 0; step < opt.steps; step++) {
      const r = Math.floor(rng() * 3);
      const rep = x.reps[r];
      const roll = rng();
      let act = 'deliver';
      if (roll < 0.2) {
        act = 'write';
        write(rep, [opFor(rep.s(), rng)]);
      } else if (roll < 0.25) {
        act = 'override';
        rep.sync.override(() => write(rep, [opFor(rep.s(), rng)]));
      } else if (opt.forks && roll < 0.32) {
        act = 'fork';
        forks.push({ r, fk: syncedFork(rep.sync as OpSync, rep.s) });
        frontiers.push({ r, f: rep.sync.captureFrontier() });
      } else if (opt.forks && roll < 0.42 && forks.length) {
        act = 'fork-edit';
        const f = pick(forks);
        f.fk.store.set(applyOps(f.fk.store(), [opFor(f.fk.store(), rng)]));
      } else if (opt.forks && roll < 0.52 && forks.length) {
        act = 'fork-commit';
        pick(forks).fk.commit();
      } else if (opt.forks && roll < 0.56 && forks.length) {
        act = 'fork-rebase';
        pick(forks).fk.rebase();
      } else if (opt.forks && roll < 0.59 && forks.length) {
        act = 'fork-discard';
        pick(forks).fk.discard();
      } else if (opt.forks && roll < 0.67 && frontiers.length) {
        act = 'emitOps-in-scope';
        const f = pick(frontiers);
        const at = x.reps[f.r];
        at.sync.commitScope(f.f, () => at.sync.emitOps([opFor(at.s(), rng)]));
      } else if (roll < 0.72) {
        act = 'duplicate';
        const sent = x.delivered(r, Math.floor(rng() * 3));
        if (sent.length) rep.sync.receive(pick(sent));
      } else {
        x.next(r, Math.floor(rng() * 3));
      }
      for (const [i, each] of x.reps.entries()) {
        if (!same(each.s(), materialized(each)))
          return { seed, step, act, law: 'C1', at: 'o' + i };
      }
    }
    x.deliverAll();
    for (const [i, each] of x.reps.entries()) {
      if (!same(each.s(), materialized(each)))
        return { seed, step: -1, act: 'quiesce', law: 'C1', at: 'o' + i };
      if (!same(each.s(), x.reps[0].s()))
        return { seed, step: -1, act: 'quiesce', law: 'C2', at: 'o' + i };
    }
    return null;
  } finally {
    x.destroy();
  }
}
const scenarios = (
  opt: { forks: boolean; steps: number },
  seeds: number,
): Broken[] => {
  const out: Broken[] = [];
  for (let s = 1; s <= seeds; s++) {
    const b = scenario(s * 104729, opt);
    if (b) out.push(b);
  }
  return out;
};

describe('fork commit reconcile: properties over the real engine (three replicas)', () => {
  it('control, no fork commits: C1 after every step and C2 at quiescence already hold', () => {
    expect(scenarios({ forks: false, steps: 40 }, 200)).toEqual([]);
  });

  it('with fork captures, edits, commits, rebases, discards and scoped emitOps: C1 and C2 hold', () => {
    expect(scenarios({ forks: true, steps: 40 }, 200)).toEqual([]);
  });
});

/** The emitter agrees with its registers now, and with every peer once all envelopes are in. */
function agrees(x: ReturnType<typeof room>): void {
  for (const r of x.reps) expect(r.s()).toEqual(materialized(r));
  x.deliverAll();
  for (const r of x.reps) {
    expect(r.s()).toEqual(materialized(r));
    expect(r.s()).toEqual(x.reps[0].s());
  }
}

describe('plain emitOps: the emitter shows what its registers fold the write to', () => {
  it('a child op under a parent a peer deleted vivifies nothing, and the root object stays', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(b, [del(['a'], b.s().a)]);
    x.deliverAll();
    const before = a.s();
    a.sync.emitOps([set(['a', 'x'], 2)]);
    expect(Object.hasOwn(a.s(), 'a')).toBe(false);
    expect(a.s()).toBe(before);
    agrees(x);
    x.destroy();
  });

  it('a child op under a parent a peer turned into a scalar keeps the scalar', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(b, [set(['a'], 5)]);
    x.deliverAll();
    const before = a.s();
    a.sync.emitOps([set(['a', 'x'], 2)]);
    expect(a.s().a).toBe(5);
    expect(a.s()).toBe(before);
    agrees(x);
    x.destroy();
  });

  for (const bump of [false, true]) {
    for (const [what, peer] of [
      ['deleted the parent', (b: Rep) => write(b, [del(['a'], b.s().a)])],
      [
        'turned the parent into a scalar',
        (b: Rep) => write(b, [set(['a'], 5)]),
      ],
    ] as const) {
      it(`re-authoring recorded raw ops ${bump ? 'with' : 'without'} bump after a peer ${what}`, () => {
        const x = room(2);
        const [a, b] = x.reps;
        write(a, [set(['a', 'x'], 3)]);
        const intent = a.ctxs[a.ctxs.length - 1];
        x.deliverAll();
        peer(b);
        x.deliverAll();
        const before = a.s();
        a.sync.emitOps(intent?.raws ?? [], { bump });
        expect(a.s()).toBe(before);
        const last = a.out[a.out.length - 1];
        expect(last.ops[0].epoch).toBe(bump ? 1 : 0);
        expect(a.ctxs[a.ctxs.length - 1]?.raws).toBe(intent?.raws);
        agrees(x);
        x.destroy();
      });
    }
  }

  it('re-authoring where the parent still stands lands the write, and the context root is the raw result', () => {
    const x = room(2);
    const [a] = x.reps;
    write(a, [set(['a', 'x'], 3)]);
    const intent = a.ctxs[a.ctxs.length - 1];
    write(a, [set(['a', 'x'], 4)]);
    const before = a.s();
    a.sync.emitOps(intent?.raws ?? [], { bump: true });
    expect((a.s().a as { x: number }).x).toBe(3);
    expect(a.s().b).toBe(before.b);
    const ctx = a.ctxs[a.ctxs.length - 1];
    expect(ctx?.root).toEqual(applyOps(before, intent?.raws ?? []));
    expect(ctx?.bump).toBe(true);
    agrees(x);
    x.destroy();
  });

  it('an emitOps that changes no fold result keeps the root object, top level and nested', () => {
    // the registers at `w` and `a.x` must hold the value already: a first write there is a change
    // of that register (from nothing), even when the store showed the same value through the seed
    const x = room(2);
    const [a] = x.reps;
    write(a, [set(['w'], 5), set(['a', 'x'], 4)]);
    const before = a.s();
    a.sync.emitOps([set(['w'], 5)]);
    expect(a.s()).toBe(before);
    a.sync.emitOps([{ kind: 'set', path: ['a', 'x'], next: 4, prev: 4 }]);
    expect(a.s()).toBe(before);
    expect(a.s().a).toBe(before.a);
    agrees(x);
    x.destroy();
  });
});

describe('fork commit reconcile: a commit that loses the fold leaves the root object itself', () => {
  type Lose = Pick<Row, 'mid' | 'edit' | 'raw'>;
  const LOSING: Record<string, Lose> = {
    'top level, a lower value under the max fold': {
      mid: (b) => write(b, [set(['m'], 9)]),
      edit: (r) => ({ ...r, m: 3 }),
      raw: [{ kind: 'set', path: ['m'], next: 3, prev: 9 }],
    },
    'nested, a leaf edit a bumped write outranks': {
      mid: (b) => b.sync.override(() => write(b, [set(['a', 'x'], 9)])),
      edit: (r) => ({ ...r, a: { ...(r.a as object), x: 3 } }),
      raw: [{ kind: 'set', path: ['a', 'x'], next: 3, prev: 9 }],
    },
  };
  for (const [seam, commit] of Object.entries(SEAMS)) {
    for (const [name, row] of Object.entries(LOSING)) {
      it(`${seam}: ${name}`, () => {
        const x = room(2);
        const [a, b] = x.reps;
        let before: Root | undefined;
        const base = (): void => {
          row.mid(b);
          x.deliverAll();
          before = a.s();
        };
        commit(a, base, row.edit, row.raw);
        expect(a.s()).toBe(before);
        expect(a.s().a).toBe(before?.a);
        expect(a.s().b).toBe(before?.b);
        agrees(x);
        x.destroy();
      });
    }
  }
});

describe('fork commit reconcile: every emit mode, a commit that partly wins and partly loses', () => {
  const MODES: Record<string, DiffOpsOptions> = {
    "arrays 'unit'": { arrays: 'unit' },
    "arrays 'index'": { arrays: 'index' },
    "added 'leaves'": { added: 'leaves' },
    "arrays 'index' with added 'leaves'": { arrays: 'index', added: 'leaves' },
  };
  for (const [name, emit] of Object.entries(MODES)) {
    it(name, () => {
      const x = room(3, emit);
      const [a, b] = x.reps;
      const fk = syncedFork(a.sync as OpSync, a.s);
      b.sync.override(() =>
        write(b, [set(['w'], 9), set(['arr'], [5, 0]), set(['c'], { p: 9 })]),
      );
      write(b, [
        set(
          ['list'],
          [
            { id: 'p', v: 0 },
            { id: 'q', v: 5 },
          ],
        ),
      ]);
      x.deliverAll();
      const before = a.s();
      fk.store.set({
        ...fk.store(),
        w: 3,
        m: 4,
        z: 4,
        arr: [0, 7],
        list: [{ id: 'p', v: 0 }],
        c: { p: 1, q: 2 },
      });
      fk.commit();
      expect(a.s().w).toBe(9);
      expect(a.s().z).toBe(4);
      expect(a.s().m).toBe(4);
      expect(a.s().a).toBe(before.a);
      expect(a.s().b).toBe(before.b);
      agrees(x);
      x.destroy();
    });
  }
});

describe('fork commit reconcile: a deferred notification', () => {
  it('a commit made while a drain is owed is reconciled on return; its authored envelope goes out later', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const fk = syncedFork(a.sync as OpSync, a.s);
    b.sync.override(() => write(b, [set(['w'], 9)]));
    a.s.set({ ...a.s(), z: 1 }); // pending: the receive below flushes it into the outbox
    expect(x.next(0, 1)).toBe(true);
    const sent = a.out.length;
    fk.store.set({ ...fk.store(), w: 3 });
    fk.commit();
    expect(a.out.length).toBe(sent);
    expect(a.s().w).toBe(9);
    expect(a.s()).toEqual(materialized(a));
    a.sync.flush();
    expect(a.out.length).toBe(sent + 2);
    const env = a.out[sent + 1];
    expect(
      env.ops.map((o) => [o.kind, o.path, (o as { next?: unknown }).next]),
    ).toEqual([['set', ['w'], 3]]);
    expect((a.ctxs[sent + 1]?.root as Root | undefined)?.w).toBe(3);
    expect(a.ctxs[sent + 1]?.raws).toEqual([
      { kind: 'set', path: ['w'], next: 3, prev: 9 },
    ]);
    agrees(x);
    x.destroy();
  });
});

describe('fork commit reconcile: history records what the store showed', () => {
  type Room = ReturnType<typeof room>;
  const attach = (a: Rep, track: boolean) =>
    TestBed.runInInjectionContext(() =>
      storeHistory(a.s, {
        ...(track ? { track: a.sync } : {}),
        folds: FOLDS,
        policies: POLICIES,
      }),
    );
  // the sync's pending emissions, then the tick a self-diffing history records on
  const settle = (a: Rep): void => {
    a.sync.flush();
    TestBed.tick();
  };
  const LOSING: Record<string, (x: Room, a: Rep, b: Rep) => () => void> = {
    'syncedFork().commit(), a lower value under the max fold': (x, a, b) => {
      const fk = syncedFork(a.sync as OpSync, a.s);
      write(b, [set(['m'], 9)]);
      x.deliverAll();
      return () => {
        fk.store.set({ ...fk.store(), m: 3 });
        fk.commit();
      };
    },
    'emitOps inside commitScope, a lower value under the max fold': (
      x,
      a,
      b,
    ) => {
      const frontier = a.sync.captureFrontier();
      write(b, [set(['m'], 9)]);
      x.deliverAll();
      return () =>
        a.sync.commitScope(frontier, () =>
          a.sync.emitOps([{ kind: 'set', path: ['m'], next: 3, prev: 9 }]),
        );
    },
    'plain emitOps, a child under a parent a peer deleted': (x, a, b) => {
      write(b, [del(['a'], b.s().a)]);
      x.deliverAll();
      return () => a.sync.emitOps([set(['a', 'x'], 2)]);
    },
  };

  for (const [mode, track] of [
    ['tracking the sync', true],
    ['self-diffing the store', false],
  ] as const) {
    describe(mode, () => {
      for (const [name, prepare] of Object.entries(LOSING)) {
        it(`${name}: no entry, and the root object stays`, () => {
          const x = room(2);
          const [a, b] = x.reps;
          const h = attach(a, track);
          const act = prepare(x, a, b);
          settle(a);
          h.clear();
          const before = a.s();
          act();
          settle(a);
          expect(a.s()).toBe(before);
          expect(h.canUndo()).toBe(false);
          expect(h.undo()).toBe(false);
          expect(a.s()).toBe(before);
          agrees(x);
          h.destroy();
          x.destroy();
        });
      }

      const commit = (
        loses: boolean,
      ): { x: Room; a: Rep; b: Rep; h: ReturnType<typeof attach> } => {
        const x = room(2);
        const [a, b] = x.reps;
        const h = attach(a, track);
        const fk = syncedFork(a.sync as OpSync, a.s);
        b.sync.override(() => write(b, [set(['w'], 9)]));
        x.deliverAll();
        settle(a);
        h.clear();
        fk.store.set({ ...fk.store(), ...(loses ? { w: 3 } : {}), z: 4 });
        fk.commit();
        settle(a);
        return { x, a, b, h };
      };
      const step = (r: { x: Room; a: Rep; b: Rep }): void => {
        expect(r.a.s()).toEqual(materialized(r.a));
        r.x.deliverAll();
        expect(r.b.s()).toEqual(r.a.s());
        expect(r.b.s()).toEqual(materialized(r.b));
      };

      for (const loses of [true, false]) {
        it(`a commit that ${loses ? 'partly loses' : 'wins'}: undo takes back what showed, redo puts it back`, () => {
          const r = commit(loses);
          const { a, h } = r;
          expect([a.s().w, a.s().z]).toEqual([9, 4]);
          expect(h.canUndo()).toBe(true);
          const sent = a.out.length;
          expect(h.undo()).toBe(true);
          settle(a);
          expect(a.s().w).toBe(9);
          expect(Object.hasOwn(a.s(), 'z')).toBe(false);
          expect(a.out.length - sent).toBe(1);
          step(r);
          expect(h.redo()).toBe(true);
          settle(a);
          expect([a.s().w, a.s().z]).toEqual([9, 4]);
          expect(a.out.length - sent).toBe(2);
          step(r);
          h.destroy();
          r.x.destroy();
        });
      }
    });
  }

  it('tracking the sync: undo of a partly losing commit leaves the lost path alone, even once a peer wrote the lost value there', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const h = attach(a, true);
    const fk = syncedFork(a.sync as OpSync, a.s);
    b.sync.override(() => write(b, [set(['w'], 9)]));
    x.deliverAll();
    fk.store.set({ ...fk.store(), w: 3, z: 4 });
    fk.commit();
    x.deliverAll();
    b.sync.override(() => write(b, [set(['w'], 3)]));
    x.deliverAll();
    expect([a.s().w, a.s().z]).toEqual([3, 4]);
    const sent = a.out.length;
    expect(h.undo()).toBe(true);
    expect(a.s().w).toBe(3);
    expect(Object.hasOwn(a.s(), 'z')).toBe(false);
    expect(a.out.length - sent).toBe(1);
    agrees(x);
    h.destroy();
    x.destroy();
  });

  it('tracking the sync: an undo that would only write the value already there returns false', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const h = attach(a, true);
    write(a, [set(['w'], 5)]);
    x.deliverAll();
    write(b, [set(['w'], 0)]);
    x.deliverAll();
    expect(h.canUndo()).toBe(true);
    const before = a.s();
    const sent = a.out.length;
    expect(h.undo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBe(false);
    expect(a.s()).toBe(before);
    expect(a.out.length).toBe(sent);
    agrees(x);
    h.destroy();
    x.destroy();
  });
});

describe('fork commit reconcile: nested scopes', () => {
  it('a fork commit inside a commit scope inside an override, then a write in the outer scope', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const outer = a.sync.captureFrontier();
    const fk = syncedFork(a.sync as OpSync, a.s);
    // two overrides raise `w` to epoch 2, above the one bump the nested commit gets
    b.sync.override(() => write(b, [set(['w'], 8)]));
    b.sync.override(() => write(b, [set(['w'], 9)]));
    write(b, [set(['m'], 9)]);
    x.deliverAll();
    a.sync.override(() =>
      a.sync.commitScope(outer, () => {
        fk.store.set({ ...fk.store(), w: 3, m: 3 });
        fk.commit();
        expect(a.s().w).toBe(9);
        expect(a.s()).toEqual(materialized(a));
        a.s.set({ ...a.s(), m: 2, z: 1 });
      }),
    );
    expect(a.s().w).toBe(9);
    expect(a.s().z).toBe(1);
    expect(a.s()).toEqual(materialized(a));
    agrees(x);
    x.destroy();
  });

  it('a losing commit inside an outer scope keeps the root object, and the outer write still reconciles', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const outer = a.sync.captureFrontier();
    const fk = syncedFork(a.sync as OpSync, a.s);
    write(b, [set(['m'], 9)]);
    x.deliverAll();
    const before = a.s();
    a.sync.commitScope(outer, () => {
      fk.store.set({ ...fk.store(), m: 3 });
      fk.commit();
      expect(a.s()).toBe(before);
      a.s.set({ ...a.s(), m: 1 });
    });
    expect(a.s()).toBe(before);
    agrees(x);
    x.destroy();
  });
});

describe('fork commit reconcile: the promise holds for a store that agreed with its registers', () => {
  it('seeded: the store agrees with its registers after an emitOps and a fork commit', () => {
    const x = room(2);
    const [a] = x.reps;
    a.sync.emitOps([set(['m'], 3)]);
    const fk = syncedFork(a.sync as OpSync, a.s);
    fk.store.set({ ...fk.store(), w: 5 });
    fk.commit();
    expect(a.s().m).toBe(3);
    expect(a.s().w).toBe(5);
    agrees(x);
    x.destroy();
  });

  it('unseeded: a base value no register knows stays in the store, it is not removed', () => {
    const r = replica('u');
    const before = r.s();
    r.sync.emitOps([set(['m'], 3)]);
    const fk = syncedFork(r.sync as OpSync, r.s);
    fk.store.set({ ...fk.store(), w: 5 });
    fk.commit();
    expect(r.s().m).toBe(3);
    expect(r.s().w).toBe(5);
    expect(r.s().a).toBe(before.a);
    expect(r.s().list).toBe(before.list);
    expect(materialized(r)).toEqual({ m: 3, w: 5 });
    r.sync.destroy();
  });
});

describe('restore: a re-injected outbox lands as the registers fold it', () => {
  it('an offline child write under a parent a peer deleted shows on the restorer as on the peer', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(b, [del(['a'], b.s().a)]);
    write(a, [set(['a', 'x'], 2)]); // offline: neither envelope crosses yet
    const tail = a.out.slice(-1);
    const snap = b.sync.snapshot();
    const fresh = replica('o0');
    fresh.sync.hydrate(snap, []);
    fresh.sync.restore(tail);
    b.sync.receive(tail[0]);
    expect(Object.hasOwn(b.s(), 'a')).toBe(false);
    expect(Object.hasOwn(fresh.s(), 'a')).toBe(false);
    expect(fresh.s()).toEqual(materialized(fresh));
    expect(fresh.s()).toEqual(b.s());
    fresh.sync.destroy();
    x.destroy();
  });

  it('on a fresh unseeded instance (restore first, hydrate later) a store-shaped tail lands exactly as its raw ops', () => {
    const broken: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const rng = rngOf(seed * 7907);
      const src = replica('o0');
      if (rng() < 0.5) src.sync.seed();
      for (let step = 0; step < 25; step++) {
        const op = (): void => write(src, [opFor(src.s(), rng)]);
        if (rng() < 0.2) src.sync.override(op);
        else op();
      }
      const tail = src.out.slice();
      const raw = tail.reduce<Root>((r, e) => applyOps(r, e.ops), INIT);
      const fresh = replica('o0');
      fresh.sync.restore(tail);
      if (!same(fresh.s(), raw) || !same(fresh.s(), src.s())) broken.push(seed);
      fresh.sync.destroy();
      src.sync.destroy();
    }
    expect(broken).toEqual([]);
  });
});

describe('reconciled emissions: the remaining edges', () => {
  it('a plain emitOps of a lower value under a custom fold supersedes what it observed and lands on both', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(b, [set(['m'], 9)]);
    x.deliverAll();
    a.sync.emitOps([set(['m'], 3)]);
    expect(a.s().m).toBe(3);
    agrees(x);
    expect(b.s().m).toBe(3);
    x.destroy();
  });

  it('a read inside a commit scope sees the raw write until the scope flushes, then the fold result', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const frontier = a.sync.captureFrontier();
    write(b, [set(['m'], 9)]);
    x.deliverAll();
    const seen: unknown[] = [];
    a.sync.commitScope(frontier, () => {
      a.s.set({ ...a.s(), m: 3 });
      seen.push(a.s().m);
      a.sync.flush();
      seen.push(a.s().m);
    });
    expect(seen).toEqual([3, 9]);
    expect(a.s().m).toBe(9);
    agrees(x);
    x.destroy();
  });

  it('the context of a losing emitOps: root is the raw result, from and shown are the store as it stood', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(b, [del(['a'], b.s().a)]);
    x.deliverAll();
    const before = a.s();
    a.sync.emitOps([set(['a', 'x'], 2)]);
    const ctx = a.ctxs[a.ctxs.length - 1];
    expect(ctx?.root).toEqual(applyOps(before, [set(['a', 'x'], 2)]));
    expect(ctx?.from).toBe(before);
    expect(ctx?.shown).toBe(before);
    expect(a.s()).toBe(before);
    x.destroy();
  });

  it('a plain store write is not reconciled: the store keeps the very root it was given', () => {
    const x = room(2);
    const [a] = x.reps;
    const next: Root = { ...a.s(), m: 4, a: { x: 1, y: 2 } };
    a.s.set(next);
    a.sync.flush();
    expect(a.s()).toBe(next);
    expect(a.ctxs[a.ctxs.length - 1]?.shown).toBe(next);
    agrees(x);
    x.destroy();
  });

  it('a plain store write is not reconciled even where a fold breaks the lone-sibling law (the writer keeps its value)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doubling: FoldFn = (s) => ({
      kind: 'set',
      value: ((s[0] as { value?: number }).value ?? 0) * 2,
    });
    const { s, sync } = TestBed.runInInjectionContext(() => {
      const s = store<Root>({ m: 0 });
      const sync = opSync(s, {
        origin: 'law',
        writer: 'w-law',
        clock: createHlcClock(() => 1),
        folds: [{ path: 'm', fold: doubling }],
      }) as OpSync<Root>;
      return { s, sync };
    });
    s.set({ m: 3 });
    sync.flush();
    expect(s().m).toBe(3);
    const conv = createConvergingApply({
      folds: [{ path: 'm', fold: doubling }],
    });
    conv.load(sync.snapshot().registers);
    expect((conv.materialize() as Root).m).toBe(6);
    sync.destroy();
    warn.mockRestore();
  });
});
