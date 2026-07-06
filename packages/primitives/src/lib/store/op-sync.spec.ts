import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createHlcClock } from './hlc';
import { applyOps, type StoreOp } from './op-log';
import {
  createConvergingApply,
  isConflicted,
  keyedArray,
  lww,
  mergeThree,
  OP_PROTO_VERSION,
  opSync,
  preserve,
  policyStrategy,
  rebaseOps,
  type Conflicted,
  type MergeFn,
  type OpEnvelope,
  type OpSync,
} from './op-sync';

function env(
  ops: StoreOp[],
  stamp: { p?: number; l?: number; writer?: string; origin?: string; version?: number },
): OpEnvelope {
  return {
    proto: OP_PROTO_VERSION,
    origin: stamp.origin ?? stamp.writer ?? 'o',
    writer: stamp.writer ?? 'w',
    version: stamp.version ?? 1,
    hlc: { p: stamp.p ?? 1, l: stamp.l ?? 0 },
    policyVersion: 0,
    ops,
  };
}

const set = (path: (string | number)[], next: unknown, prev?: unknown): StoreOp =>
  prev === undefined
    ? { kind: 'set', path, next }
    : { kind: 'set', path, next, prev };

describe('createConvergingApply', () => {
  it('accepts a newer op at a path and rejects an older one arriving later', () => {
    const conv = createConvergingApply();
    let root: unknown = { a: 0 };

    root = applyOps(root, conv.ingest(env([set(['a'], 2)], { p: 2, writer: 'x' })));
    root = applyOps(root, conv.ingest(env([set(['a'], 1)], { p: 1, writer: 'y' })));

    expect(root).toEqual({ a: 2 });
  });

  it('parent set vs newer child write converges in BOTH arrival orders (dominance + replay)', () => {
    const parent = env([set(['a'], { x: 'P' })], { p: 1, writer: 'p' });
    const child = env([set(['a', 'b'], 'C')], { p: 2, writer: 'c' });
    const initial = { a: { x: 'orig', b: 'orig-b' } };

    const run = (order: OpEnvelope[]) => {
      const conv = createConvergingApply();
      let root: unknown = initial;
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return root;
    };

    const ab = run([parent, child]);
    const ba = run([child, parent]);
    expect(ab).toEqual(ba);
    expect(ab).toEqual({ a: { x: 'P', b: 'C' } }); // parent applied, newer child replayed on top
  });

  it('a newer parent set clears older descendant winners entirely', () => {
    const conv = createConvergingApply();
    let root: unknown = { a: { b: 0 } };

    root = applyOps(root, conv.ingest(env([set(['a', 'b'], 1)], { p: 1, writer: 'x' })));
    root = applyOps(root, conv.ingest(env([set(['a'], { fresh: true })], { p: 2, writer: 'y' })));
    root = applyOps(root, conv.ingest(env([set(['a', 'b'], 99)], { p: 1, l: 1, writer: 'x' })));

    expect(root).toEqual({ a: { fresh: true } }); // late child older than parent → dominated
  });

  it('breaks exact-stamp ties on writer identically in both orders', () => {
    const e1 = env([set(['v'], 'from-a')], { p: 5, writer: 'a' });
    const e2 = env([set(['v'], 'from-b')], { p: 5, writer: 'b' });

    const run = (order: OpEnvelope[]) => {
      const conv = createConvergingApply();
      let root: unknown = { v: 0 };
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return root;
    };

    expect(run([e1, e2])).toEqual({ v: 'from-b' });
    expect(run([e2, e1])).toEqual({ v: 'from-b' });
  });

  it('local envelopes register without echoing ops back', () => {
    const conv = createConvergingApply();
    const local = env([set(['a'], 'mine')], { p: 5, writer: 'me' });

    expect(conv.ingest(local, { local: true })).toEqual([]);
    // an older remote now loses to the locally-registered winner
    expect(conv.ingest(env([set(['a'], 'theirs')], { p: 4, writer: 'them' }))).toEqual([]);
  });

  it('preserve policy yields the SAME Conflicted value regardless of arrival order', () => {
    const mine = env([set(['note'], 'A', 'base')], { p: 5, writer: 'a' });
    const theirs = env([set(['note'], 'B', 'base')], { p: 4, writer: 'b' });

    const run = (order: OpEnvelope[]) => {
      const conv = createConvergingApply({
        policies: [{ path: 'note', merge: preserve }],
      });
      let root: unknown = { note: 'base' };
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return root as { note: Conflicted<string> };
    };

    const ab = run([mine, theirs]);
    const ba = run([theirs, mine]);
    expect(ab).toEqual(ba);
    expect(isConflicted(ab.note)).toBe(true);
    expect(ab.note.mine).toBe('A'); // total-order winner is always `mine`
    expect(ab.note.theirs).toBe('B');
  });

  it('sequential edits (prev chain intact) never trigger the merge policy', () => {
    const conv = createConvergingApply({
      policies: [{ path: 'note', merge: preserve }],
    });
    let root: unknown = { note: 'base' };

    root = applyOps(root, conv.ingest(env([set(['note'], 'v1', 'base')], { p: 1, writer: 'a' })));
    root = applyOps(root, conv.ingest(env([set(['note'], 'v2', 'v1')], { p: 2, writer: 'b' })));

    expect(root).toEqual({ note: 'v2' }); // b built on a's value — no conflict to preserve
  });

  it('mergeThree policy merges concurrent object edits field-wise', () => {
    const base = { name: 'n', done: false };
    const mine = env([set(['todo'], { name: 'renamed', done: false }, base)], { p: 5, writer: 'a' });
    const theirs = env([set(['todo'], { name: 'n', done: true }, base)], { p: 4, writer: 'b' });

    const conv = createConvergingApply({
      policies: [{ path: 'todo', merge: mergeThree }],
    });
    let root: unknown = { todo: base };
    root = applyOps(root, conv.ingest(mine));
    root = applyOps(root, conv.ingest(theirs));

    expect(root).toEqual({ todo: { name: 'renamed', done: true } });
  });

  it('wildcard policy paths match one segment', () => {
    const conv = createConvergingApply({
      policies: [{ path: 'todos.*.title', merge: preserve }],
    });
    const a = env([set(['todos', 0, 'title'], 'A', 'base')], { p: 5, writer: 'a' });
    const b = env([set(['todos', 0, 'title'], 'B', 'base')], { p: 4, writer: 'b' });

    let root: unknown = { todos: [{ title: 'base' }] };
    root = applyOps(root, conv.ingest(a));
    root = applyOps(root, conv.ingest(b));

    expect(isConflicted((root as { todos: { title: unknown }[] }).todos[0].title)).toBe(true);
  });

  it('PROPERTY: any arrival order of the same envelope set converges to the same state', () => {
    // deterministic PRNG — reproducible without Math.random
    const mulberry32 = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const PATHS: (string | number)[][] = [
      [],
      ['a'],
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['a', 'd'],
      ['e'],
      ['e', 0],
      ['e', 0, 'f'],
    ];

    for (let seed = 1; seed <= 5; seed++) {
      const rnd = mulberry32(seed * 7919);
      const writers = ['w1', 'w2', 'w3'];
      const clocks = new Map(writers.map((w) => [w, 0]));

      const envelopes: OpEnvelope[] = Array.from({ length: 24 }, (_, i) => {
        const writer = writers[Math.floor(rnd() * writers.length)];
        const tick = (clocks.get(writer) ?? 0) + 1 + Math.floor(rnd() * 3);
        clocks.set(writer, tick);
        const path = PATHS[Math.floor(rnd() * PATHS.length)];
        const value =
          path.length === 0
            ? { a: { b: { c: rnd() } }, e: [{ f: rnd() }] }
            : path[path.length - 1] === 'b' || path.length === 1
              ? { c: rnd(), z: i }
              : rnd();
        return env([set(path, value)], {
          p: tick,
          l: i,
          writer,
          origin: writer,
          version: i,
        });
      });

      const initial = { a: { b: { c: 0 }, d: 0 }, e: [{ f: 0 }] };
      const shuffle = (arr: OpEnvelope[], r: () => number) => {
        const copy = [...arr];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      };

      const results: unknown[] = [];
      for (let s = 0; s < 8; s++) {
        const conv = createConvergingApply();
        let root: unknown = initial;
        for (const e of shuffle(envelopes, mulberry32(seed * 100 + s))) {
          root = applyOps(root, conv.ingest(e));
        }
        results.push(root);
      }

      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(results[0]);
      }
    }
  });
});

describe('createConvergingApply — policy convergence under 3+ CONCURRENT same-path writes', () => {
  // The existing PROPERTY test only covers default lww. resolveConcurrent merges a policy PAIRWISE in
  // the single-winner register, so 3+ concurrent writers need the merge to be associative/commutative
  // or the register diverges by arrival order (the ranking Condorcet-cycle lesson). Genuinely
  // concurrent = every write branches from the SAME ancestor (prev = ancestor), distinct stamps.
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = (arr: OpEnvelope[], seed: number) => {
    const r = mulberry32(seed);
    const c = [...arr];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  };
  const converges = (
    policy: MergeFn,
    path: string,
    initial: unknown,
    envs: OpEnvelope[],
  ): boolean => {
    const results: string[] = [];
    for (let s = 1; s <= 20; s++) {
      const conv = createConvergingApply({ policies: [{ path, merge: policy }] });
      let root: unknown = initial;
      for (const e of shuffle(envs, s * 131)) root = applyOps(root, conv.ingest(e));
      results.push(JSON.stringify(root));
    }
    return results.every((r) => r === results[0]);
  };

  const leafEnvs = ['a', 'b', 'c', 'd'].map((v, i) =>
    env([set(['v'], v, 'base')], { p: i + 1, writer: 'w' + i }),
  );

  it('lww: 4 concurrent leaf writes converge (control)', () => {
    expect(converges(lww, 'v', { v: 'base' }, leafEnvs)).toBe(true);
  });

  it('preserve: 4 concurrent leaf writes DIVERGE (known limitation, found 2026-07-06)', () => {
    // preserve keeps a BINARY Conflicted, so a 3rd concurrent writer nests Conflicted-in-Conflicted
    // order-dependently → the single-winner register diverges. Same class as the ranking Condorcet
    // trap. The fix is an MV-register (retain all concurrent siblings, resolve at read); this
    // expectation FLIPS to converge when that lands. Two concurrent writers are fine (see the 2-way
    // preserve tests above).
    expect(converges(preserve, 'v', { v: 'base' }, leafEnvs)).toBe(false);
  });

  it('mergeThree: 3 concurrent object edits converge', () => {
    const base = { x: 0, y: 0, z: 0 };
    const envs = [
      env([set(['o'], { x: 1, y: 0, z: 0 }, base)], { p: 1, writer: 'w1' }),
      env([set(['o'], { x: 0, y: 2, z: 0 }, base)], { p: 2, writer: 'w2' }),
      env([set(['o'], { x: 1, y: 2, z: 3 }, base)], { p: 3, writer: 'w3' }),
    ];
    expect(converges(mergeThree, 'o', { o: base }, envs)).toBe(true);
  });

  it('keyedArray: 3 concurrent array edits DIVERGE (known limitation, found 2026-07-06)', () => {
    // Pairwise item-merge in the single-winner register is not associative/commutative for 3+
    // concurrent whole-array writes (item order + theirs-only additions depend on which side is
    // "mine" at each pairwise step) → diverges by arrival order. Same MV-register fix as preserve;
    // this expectation FLIPS to converge when that lands. Two concurrent writers are fine.
    const byId = keyedArray((t) => (t as { id: number }).id);
    const anc = [
      { id: 1, v: 0 },
      { id: 2, v: 0 },
    ];
    const envs = [
      env([set(['list'], [{ id: 1, v: 1 }, anc[1]], anc)], { p: 1, writer: 'w1' }),
      env([set(['list'], [anc[0], { id: 2, v: 2 }], anc)], { p: 2, writer: 'w2' }),
      env([set(['list'], [...anc, { id: 3, v: 3 }], anc)], { p: 3, writer: 'w3' }),
    ];
    expect(converges(byId, 'list', { list: anc }, envs)).toBe(false);
  });

  it('mergeThree: 3 concurrent writers to the SAME field + a nested object converge', () => {
    // harder case — 'a' changed by ALL three to distinct values, nested fields overlap. mergeThree
    // degrades to lww on a leaf conflict (which IS associative), so it should still converge.
    const base = { a: 0, nested: { p: 0, q: 0 } };
    const envs = [
      env([set(['o'], { a: 1, nested: { p: 1, q: 0 } }, base)], { p: 1, writer: 'w1' }),
      env([set(['o'], { a: 2, nested: { p: 0, q: 2 } }, base)], { p: 2, writer: 'w2' }),
      env([set(['o'], { a: 3, nested: { p: 3, q: 3 } }, base)], { p: 3, writer: 'w3' }),
    ];
    expect(converges(mergeThree, 'o', { o: base }, envs)).toBe(true);
  });
});

describe('rebaseOps', () => {
  it('re-applies non-conflicting pending over the remote state with refreshed prevs', () => {
    const root = { a: 1, b: 'local' }; // pending already applied locally
    const pending: StoreOp[][] = [[set(['b'], 'local', 'orig')]];
    const remote: StoreOp[] = [set(['a'], 10, 1)];

    const out = rebaseOps(root, pending, remote);

    expect(out.root).toEqual({ a: 10, b: 'local' });
    expect(out.pending).toEqual([[set(['b'], 'local', 'orig')]]);
  });

  it('lww default: pending wins a direct conflict with the remote value', () => {
    const root = { v: 'local' };
    const out = rebaseOps(root, [[set(['v'], 'local', 'orig')]], [set(['v'], 'remote', 'orig')]);

    expect(out.root).toEqual({ v: 'local' });
    expect(out.pending[0][0]).toEqual(set(['v'], 'local', 'remote')); // prev refreshed to what it overwrote
  });

  it('preserve policy: a rebase conflict lands as Conflicted data', () => {
    const root = { v: 'local' };
    const out = rebaseOps(
      root,
      [[set(['v'], 'local', 'orig')]],
      [set(['v'], 'remote', 'orig')],
      [{ path: 'v', merge: preserve }],
    );

    const v = (out.root as { v: unknown }).v;
    expect(isConflicted(v)).toBe(true);
    expect((v as Conflicted).mine).toBe('local');
    expect((v as Conflicted).theirs).toBe('remote');
  });

  it('a pending add (no prev) survives a remote delete of its slot', () => {
    const root = { list: { x: 'mine' } };
    const out = rebaseOps(
      root,
      [[{ kind: 'set', path: ['list', 'x'], next: 'mine' }]],
      [{ kind: 'delete', path: ['list', 'x'], prev: 'server' }],
    );

    expect(out.root).toEqual({ list: { x: 'mine' } });
    expect(out.pending[0][0]).toEqual({ kind: 'set', path: ['list', 'x'], next: 'mine' });
  });

  it('matches the sequenced order (remote then pending) for disjoint paths', () => {
    const base = { a: 1, b: 2, c: 3 };
    const pendingOps: StoreOp[] = [set(['a'], 100, 1)];
    const remote: StoreOp[] = [set(['b'], 200, 2)];

    const local = applyOps(base, pendingOps);
    const out = rebaseOps(local, [pendingOps], remote);
    const sequenced = applyOps(applyOps(base, remote), pendingOps);

    expect(out.root).toEqual(sequenced);
  });
});

describe('keyedArray merge', () => {
  type Todo = { id: number; title: string; done?: boolean };
  const byId = keyedArray((t) => (t as Todo).id);
  const ctx = { path: ['todos'] as const };

  const anc: Todo[] = [
    { id: 1, title: 'one' },
    { id: 2, title: 'two' },
    { id: 3, title: 'three' },
  ];

  it('merges concurrent edits to DIFFERENT items (whole-array lww would lose one)', () => {
    const mine = [{ id: 1, title: 'one*' }, anc[1], anc[2]];
    const theirs = [anc[0], { id: 2, title: 'two*' }, anc[2]];

    expect(byId(anc, mine, theirs, ctx)).toEqual([
      { id: 1, title: 'one*' },
      { id: 2, title: 'two*' },
      { id: 3, title: 'three' },
    ]);
  });

  it('merges concurrent edits to different FIELDS of the same item via merge3', () => {
    const mine = [{ id: 1, title: 'renamed' }, anc[1], anc[2]];
    const theirs = [{ id: 1, title: 'one', done: true }, anc[1], anc[2]];

    expect(byId(anc, mine, theirs, ctx)).toEqual([
      { id: 1, title: 'renamed', done: true },
      anc[1],
      anc[2],
    ]);
  });

  it('keeps additions from both sides; mine-order wins, theirs additions append', () => {
    const mine = [...anc, { id: 4, title: 'four' }];
    const theirs = [{ id: 5, title: 'five' }, ...anc];

    expect(byId(anc, mine, theirs, ctx)).toEqual([
      ...anc,
      { id: 4, title: 'four' },
      { id: 5, title: 'five' },
    ]);
  });

  it('a removal sticks when the other side left the item untouched', () => {
    const mine = [anc[0], anc[2]]; // removed id 2
    const theirs = [...anc];

    expect(byId(anc, mine, theirs, ctx)).toEqual([anc[0], anc[2]]);
  });

  it('an edit beats a concurrent removal (the item survives with the edit)', () => {
    const mine = [anc[0], anc[2]]; // removed id 2
    const theirs = [anc[0], { id: 2, title: 'two-edited' }, anc[2]];

    expect(byId(anc, mine, theirs, ctx)).toEqual([
      anc[0],
      anc[2],
      { id: 2, title: 'two-edited' },
    ]);
  });

  it('is deterministic under swapped argument order for disjoint-item edits', () => {
    const a = [{ id: 1, title: 'one*' }, anc[1], anc[2]];
    const b = [anc[0], { id: 2, title: 'two*' }, anc[2]];

    const ab = byId(anc, a, b, ctx) as Todo[];
    const ba = byId(anc, b, a, ctx) as Todo[];
    expect(new Set(ab.map((t) => t.title))).toEqual(new Set(ba.map((t) => t.title)));
  });

  it('per-item preserve escalates a same-field conflict to Conflicted data', () => {
    const withPreserve = keyedArray((t) => (t as Todo).id, { item: preserve });
    const mine = [{ id: 1, title: 'A' }, anc[1], anc[2]];
    const theirs = [{ id: 1, title: 'B' }, anc[1], anc[2]];

    const out = withPreserve(anc, mine, theirs, ctx) as unknown[];
    expect(isConflicted(out[0])).toBe(true);
  });

  it('falls back to the total-order winner on a type conflict', () => {
    expect(byId(anc, 'not-an-array', [...anc], ctx)).toBe('not-an-array');
  });
});

describe('policyStrategy (fork reconcile from the shared rebase)', () => {
  const ancestor = { title: 'base', body: 'base-body', tags: { a: 1 } };

  it('resolves one-sided edits like merge3: fork edits kept, base edits taken', () => {
    const reconcile = policyStrategy<typeof ancestor>([]);
    const mine = { ...ancestor, title: 'fork-title' };
    const theirs = { ...ancestor, body: 'base-body-2' };

    expect(reconcile(ancestor, mine, theirs)).toEqual({
      title: 'fork-title',
      body: 'base-body-2',
      tags: { a: 1 },
    });
  });

  it('routes both-sides-edited paths through the matching policy', () => {
    const reconcile = policyStrategy<typeof ancestor>([
      { path: 'title', merge: preserve },
    ]);
    const mine = { ...ancestor, title: 'fork-title' };
    const theirs = { ...ancestor, title: 'base-title-2' };

    const out = reconcile(ancestor, mine, theirs);
    expect(isConflicted(out.title)).toBe(true);
    expect((out.title as unknown as Conflicted).mine).toBe('fork-title');
    expect((out.title as unknown as Conflicted).theirs).toBe('base-title-2');
  });

  it('defaults conflicting paths to lww: the fork wins, matching the fine strategy', () => {
    const reconcile = policyStrategy<typeof ancestor>([]);
    const mine = { ...ancestor, title: 'fork-title' };
    const theirs = { ...ancestor, title: 'base-title-2' };

    expect(reconcile(ancestor, mine, theirs).title).toBe('fork-title');
  });
});

describe('opSync', () => {
  function pair(opt?: { policies?: Parameters<typeof opSync>[1]['policies'] }) {
    return TestBed.runInInjectionContext(() => {
      const a = signal<{ v: string; n: { x: number } }>({ v: 'init', n: { x: 0 } });
      const b = signal<{ v: string; n: { x: number } }>({ v: 'init', n: { x: 0 } });
      const syncA = opSync(a, { writer: 'wa', policies: opt?.policies });
      const syncB = opSync(b, { writer: 'wb', policies: opt?.policies });
      return { a, b, syncA, syncB };
    });
  }

  const pipe = (from: OpSync, to: OpSync) => {
    const buffer: OpEnvelope[] = [];
    from.subscribe((e) => buffer.push(e));
    return () => {
      for (const e of buffer.splice(0)) to.receive(e);
    };
  };

  it('replicates local writes to the peer, echo-free', () => {
    const { a, b, syncA, syncB } = pair();
    const deliverAB = pipe(syncA, syncB);
    const deliverBA = pipe(syncB, syncA);

    a.update((s) => ({ ...s, v: 'from-a' }));
    syncA.flush();
    deliverAB();
    deliverBA(); // B's apply produced no echo envelope

    expect(b()).toEqual({ v: 'from-a', n: { x: 0 } });
    expect(a()).toEqual({ v: 'from-a', n: { x: 0 } });
  });

  it('receiving your own envelope is a no-op', () => {
    const { a, syncA } = pair();
    let captured: OpEnvelope | undefined;
    syncA.subscribe((e) => (captured = e));

    a.update((s) => ({ ...s, v: 'x' }));
    syncA.flush();
    if (!captured) throw new Error('expected a captured frame');
    syncA.receive(captured);

    expect(a().v).toBe('x');
  });

  it('concurrent writes to one leaf converge to the same value on both peers', () => {
    const { a, b, syncA, syncB } = pair();
    const deliverAB = pipe(syncA, syncB);
    const deliverBA = pipe(syncB, syncA);

    a.update((s) => ({ ...s, v: 'A' }));
    syncA.flush();
    b.update((s) => ({ ...s, v: 'B' }));
    syncB.flush();

    deliverAB();
    deliverBA();

    expect(a().v).toBe(b().v);
    expect(['A', 'B']).toContain(a().v);
  });

  it('concurrent writes with a preserve policy land as Conflicted on both peers', () => {
    const { a, b, syncA, syncB } = pair({
      policies: [{ path: 'v', merge: preserve }],
    });
    const deliverAB = pipe(syncA, syncB);
    const deliverBA = pipe(syncB, syncA);

    a.update((s) => ({ ...s, v: 'A' }));
    syncA.flush();
    b.update((s) => ({ ...s, v: 'B' }));
    syncB.flush();
    deliverAB();
    deliverBA();

    expect(isConflicted(a().v)).toBe(true);
    expect(a().v).toEqual(b().v);

    // resolution is just a later write — sequential on top of the replicated conflict,
    // so it must NOT nest another conflict on the peer
    a.update((s) => ({ ...s, v: 'resolved' }));
    syncA.flush();
    deliverAB();
    expect(b().v).toBe('resolved');
  });

  it('drops foreign-proto envelopes with a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { a, syncA } = pair();
      syncA.receive({ ...env([set(['v'], 'evil')], { p: 99, writer: 'z' }), proto: 2 });
      expect(a().v).toBe('init');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports version gaps per origin (the resync hook)', () => {
    const gaps: [string, number, number][] = [];
    const { a } = TestBed.runInInjectionContext(() => {
      const s = signal({ v: 0 });
      return {
        a: opSync(s, {
          writer: 'w',
          onGap: (origin, expected, got) => gaps.push([origin, expected, got]),
        }),
      };
    });

    a.receive(env([set(['v'], 1)], { p: 1, writer: 'r', origin: 'r', version: 1 }));
    a.receive(env([set(['v'], 3)], { p: 3, writer: 'r', origin: 'r', version: 3 }));

    expect(gaps).toEqual([['r', 2, 3]]);
  });

  it('watermark tracks the latest version per origin, including its own', () => {
    const { a, syncA } = pair();
    a.update((s) => ({ ...s, v: 'x' }));
    syncA.flush();
    syncA.receive(env([set(['v'], 'y', 'x')], { p: 999, writer: 'r', origin: 'r', version: 4 }));

    const wm = syncA.watermark();
    expect(wm[syncA.origin]).toBe(1);
    expect(wm['r']).toBe(4);
  });
});

const del = (path: (string | number)[], prev: unknown): StoreOp => ({ kind: 'delete', path, prev });

describe('createConvergingApply — deletes, reset, multi-op', () => {
  it('a newer delete removes the key; an older delete arriving later is dropped', () => {
    const conv = createConvergingApply();
    let root: unknown = { a: 1 };
    root = applyOps(root, conv.ingest(env([set(['a'], 5)], { p: 1, writer: 'x' })));
    root = applyOps(root, conv.ingest(env([del(['a'], 5)], { p: 2, writer: 'y' })));
    expect('a' in (root as object)).toBe(false); // newer delete wins

    const conv2 = createConvergingApply();
    let r2: unknown = { a: 1 };
    r2 = applyOps(r2, conv2.ingest(env([set(['a'], 9)], { p: 5, writer: 'x' })));
    r2 = applyOps(r2, conv2.ingest(env([del(['a'], 1)], { p: 2, writer: 'y' })));
    expect(r2).toEqual({ a: 9 }); // older delete dropped
  });

  it('a set and a concurrent newer delete converge in BOTH arrival orders', () => {
    const setE = env([set(['a'], 'v')], { p: 1, writer: 'x' });
    const delE = env([del(['a'], 'orig')], { p: 2, writer: 'y' });
    const run = (order: OpEnvelope[]) => {
      const c = createConvergingApply();
      let r: unknown = { a: 'orig' };
      for (const e of order) r = applyOps(r, c.ingest(e));
      return r;
    };
    expect(run([setE, delE])).toEqual(run([delE, setE]));
    expect('a' in (run([setE, delE]) as object)).toBe(false);
  });

  it('reset() clears registers so a previously-dominated older op applies again', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['a'], 2)], { p: 5, writer: 'x' })); // register a newer winner
    expect(conv.ingest(env([set(['a'], 1)], { p: 1, writer: 'y' }))).toEqual([]); // dominated

    conv.reset();
    expect(conv.ingest(env([set(['a'], 1)], { p: 1, writer: 'y' }))).toEqual([set(['a'], 1)]);
  });

  it('applies multiple ops in one envelope', () => {
    const conv = createConvergingApply();
    expect(conv.ingest(env([set(['a'], 1), set(['b'], 2)], { p: 1, writer: 'x' }))).toEqual([
      set(['a'], 1),
      set(['b'], 2),
    ]);
  });
});

describe('rebaseOps — multi-batch, empty edges, deletes', () => {
  it('rebases MULTIPLE pending batches in order onto the remote', () => {
    const base = { a: 0, b: 0, c: 0 };
    const p1 = [set(['a'], 1, 0)];
    const p2 = [set(['b'], 2, 0)];
    const local = applyOps(applyOps(base, p1), p2);
    const out = rebaseOps(local, [p1, p2], [set(['c'], 9, 0)]);
    expect(out.root).toEqual({ a: 1, b: 2, c: 9 });
  });

  it('empty pending → root becomes base + remote', () => {
    expect(rebaseOps({ a: 0 }, [], [set(['a'], 5, 0)]).root).toEqual({ a: 5 });
  });

  it('empty remote → pending re-applied unchanged', () => {
    expect(rebaseOps({ a: 1 }, [[set(['a'], 1, 0)]], []).root).toEqual({ a: 1 });
  });

  it('a pending delete composes with a disjoint remote edit', () => {
    const base = { a: 1, b: 2 };
    const pending = [del(['a'], 1)];
    const local = applyOps(base, pending);
    const out = rebaseOps(local, [pending], [set(['b'], 20, 2)]);
    expect(out.root).toEqual({ b: 20 }); // a deleted (pending), b updated (remote)
  });
});

describe('opSync — hydrate / seed / snapshot (boot & reconnect seam)', () => {
  it('hydrate adopts the remote root and re-applies uncovered local pending on top', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; keep: string }>({ v: 'init', keep: 'base' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ v: 'offline', keep: 'base' }); // offline edit to v
      sync.flush(); // recentLocal now holds version 1
      sync.hydrate({ v: 'init', keep: 'from-room' }, {}); // remote changed a different field
      return s();
    });
    expect(out).toEqual({ v: 'offline', keep: 'from-room' }); // both preserved (merge, not clobber)
  });

  it('hydrate drops pending the incoming watermark already covers (acked, not duplicated)', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string }>({ v: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ v: 'offline' });
      sync.flush(); // version 1
      sync.hydrate({ v: 'from-room' }, { o1: 1 }); // watermark says my v1 is already applied
      return s();
    });
    expect(out.v).toBe('from-room'); // offline write not re-applied — the room already has it
  });

  it('hydrate folds the incoming watermark (max per origin)', () => {
    const wm = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: number }>({ v: 0 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      sync.hydrate({ v: 0 }, { r1: 5, r2: 3 });
      return sync.watermark();
    });
    expect(wm['r1']).toBe(5);
    expect(wm['r2']).toBe(3);
  });

  it('seed emits a whole-root set of the current value', () => {
    const emitted = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; n: number }>({ v: 'x', n: 1 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      sync.seed();
      return out;
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].ops).toEqual([{ kind: 'set', path: [], next: { v: 'x', n: 1 } }]);
  });

  it('snapshot returns the current root and per-origin watermark', () => {
    const snap = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; x?: number }>({ v: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ v: 'edited' });
      sync.flush();
      sync.receive(env([set(['x'], 1)], { p: 9, writer: 'r', origin: 'r', version: 3 }));
      return sync.snapshot();
    });
    expect(snap.root).toMatchObject({ v: 'edited' });
    expect(snap.wm['o1']).toBe(1);
    expect(snap.wm['r']).toBe(3);
  });
});

describe('opSync — durability & watermark invariants (locked before the branch refactor)', () => {
  it('a pending local write survives a remote that arrives first — never swallowed', () => {
    const { emitted, final } = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; other: string }>({ v: 'init', other: 'base' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const emitted: OpEnvelope[] = [];
      sync.subscribe((e) => emitted.push(e));
      s.set({ v: 'init', other: 'local' }); // pending local (a different field)
      sync.receive(env([set(['v'], 'remote', 'init')], { p: 5, writer: 'r', origin: 'r', version: 1 }));
      sync.flush();
      return { emitted, final: s() };
    });
    // durable invariant, framed to survive the local-pending-as-branch refactor:
    expect(final.other).toBe('local'); // the local write is in state
    expect(final.v).toBe('remote'); // the remote applied
    expect(emitted.some((e) => e.ops.some((o) => o.path[0] === 'other'))).toBe(true); // and it emitted
  });

  it('version dedup: an older or duplicate envelope for a known origin is ignored (invariant 4)', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: number }>({ v: 0 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      sync.receive(env([set(['v'], 3)], { p: 3, writer: 'r', origin: 'r', version: 3 }));
      const afterV3 = s().v;
      sync.receive(env([set(['v'], 99)], { p: 4, writer: 'r', origin: 'r', version: 3 })); // duplicate version
      sync.receive(env([set(['v'], 88)], { p: 5, writer: 'r', origin: 'r', version: 1 })); // older version
      return { afterV3, finalV: s().v, wm: sync.watermark() };
    });
    expect(out.afterV3).toBe(3);
    expect(out.finalV).toBe(3); // both the duplicate and the older envelope were ignored
    expect(out.wm['r']).toBe(3); // the watermark never regressed
  });

  it('local-pending-as-branch: a pending write keeps its ORIGINAL (pre-observe) stamp, so a same-path conflict resolves by honest physical clocks', () => {
    const run = (localNow: number, remoteP: number) =>
      TestBed.runInInjectionContext(() => {
        const s = signal<{ v: string }>({ v: 'init' });
        const sync = opSync(s, { writer: 'wl', origin: 'o1', clock: createHlcClock(() => localNow) });
        s.set({ v: 'local' }); // pending, SAME path as the remote
        sync.receive(env([set(['v'], 'remote', 'init')], { p: remoteP, writer: 'wr', origin: 'r', version: 1 }));
        sync.flush();
        return s().v;
      });
    // `receive` now freezes the pending local write's stamp BEFORE observing the remote clock, so the
    // write keeps its original stamp and the higher physical clock wins the same-path conflict —
    // identically at every replica (no self-favouring re-stamp). This is the flip from the old
    // flush-then-apply behaviour where the local write always won.
    expect(run(1, 100)).toBe('remote'); // remote clock ahead → remote wins; local rolls back visibly
    expect(run(100, 1)).toBe('local'); // local clock ahead → local wins
  });

  it('hydrate replays MULTIPLE uncovered offline writes on top of the remote root', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ a: string; b: string; keep: string }>({ a: '0', b: '0', keep: 'base' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ a: '1', b: '0', keep: 'base' });
      sync.flush(); // offline write 1
      s.set({ a: '1', b: '2', keep: 'base' });
      sync.flush(); // offline write 2
      sync.hydrate({ a: '0', b: '0', keep: 'from-room' }, {}); // both uncovered
      return s();
    });
    expect(out).toEqual({ a: '1', b: '2', keep: 'from-room' });
  });

  it('destroy stops emission', () => {
    const emitted = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: number }>({ v: 0 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      sync.destroy();
      s.set({ v: 1 });
      sync.flush();
      return out;
    });
    expect(emitted).toEqual([]);
  });
});

describe('opSync — restore (durable outbox boot seam)', () => {
  it('re-injects persisted offline envelopes: applies them and re-emits for resend, versions verbatim', () => {
    const { emitted, final, wm } = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; n: number }>({ v: 'init', n: 0 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const emitted: OpEnvelope[] = [];
      sync.subscribe((e) => emitted.push(e));
      const persisted: OpEnvelope[] = [
        env([set(['v'], 'offline', 'init')], { p: 10, writer: 'w', origin: 'o1', version: 1 }),
        env([set(['n'], 5, 0)], { p: 11, writer: 'w', origin: 'o1', version: 2 }),
      ];
      sync.restore(persisted, 2);
      return { emitted, final: s(), wm: sync.watermark() };
    });
    expect(final).toEqual({ v: 'offline', n: 5 }); // offline edits applied to the store
    expect(emitted.map((e) => e.version)).toEqual([1, 2]); // re-emitted verbatim (no new versions)
    expect(wm['o1']).toBe(2); // watermark at the restored high-water
  });

  it('bumps the emit counter to highWater so a later write skips a version acked-but-dropped from the outbox', () => {
    const firstNew = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string }>({ v: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const emitted: OpEnvelope[] = [];
      sync.subscribe((e) => emitted.push(e));
      // only v3 is still unacked, but v1..v5 were emitted before the reboot (highWater 5)
      sync.restore([env([set(['v'], 'x', 'init')], { p: 1, writer: 'w', origin: 'o1', version: 3 })], 5);
      s.set({ v: 'y' });
      sync.flush();
      return emitted.find((e) => e.ops.some((o) => o.kind === 'set' && o.next === 'y'));
    });
    expect(firstNew?.version).toBe(6); // continues past highWater(5), never re-mints 4
  });

  it('restored offline pending survives a reconnect hydrate and merges with room changes', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; keep: string }>({ v: 'init', keep: 'base' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      sync.restore([env([set(['v'], 'offline', 'init')], { p: 10, writer: 'w', origin: 'o1', version: 1 })], 1);
      sync.hydrate({ v: 'init', keep: 'from-room' }, {}); // reconnect: room changed a different field
      return s();
    });
    expect(out).toEqual({ v: 'offline', keep: 'from-room' }); // offline edit + room edit both survive
  });

  it('a hydrate that raises our own watermark advances the next mint above it (structural: no version regression)', () => {
    const emitted = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string }>({ v: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      sync.hydrate({ v: 'from-room' }, { o1: 7 }); // the room already saw our writes through v7
      s.set({ v: 'after' });
      sync.flush();
      return out;
    });
    expect(emitted[0]?.version).toBe(8); // next mint continues past the hydrated watermark, not 1
  });
});
