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
  syncedFork,
  validateEnvelope,
  type Conflicted,
  type Dot,
  type MergeFn,
  type OpEnvelope,
  type OpSync,
  type SyncOp,
} from './op-sync';
import { store } from './store';

// NB an op WITHOUT explicit `cites` is a CONCURRENT write here (it observed nothing at its
// path). Fixtures asserting causal supersession must cite the superseded dot explicitly.
type WireOp = StoreOp & { cites?: Dot[]; epoch?: number };

function env(
  ops: WireOp[],
  stamp: { p?: number; l?: number; writer?: string; origin?: string; version?: number },
): OpEnvelope {
  return {
    proto: OP_PROTO_VERSION,
    origin: stamp.origin ?? stamp.writer ?? 'o',
    writer: stamp.writer ?? 'w',
    version: stamp.version ?? 1,
    hlc: { p: stamp.p ?? 1, l: stamp.l ?? 0 },
    policyVersion: 0,
    ops: ops.map((o) => ({ cites: [], epoch: 0, ...o })) as unknown as OpEnvelope['ops'],
  };
}

const dot = (origin: string, p: number, l = 0): Dot => ({ origin, hlc: { p, l } });

const set = (path: (string | number)[], next: unknown, prev?: unknown): StoreOp =>
  prev === undefined
    ? { kind: 'set', path, next }
    : { kind: 'set', path, next, prev };

const del = (path: (string | number)[], prev: unknown): StoreOp => ({ kind: 'delete', path, prev });

describe('createConvergingApply', () => {
  it('accepts a newer op at a path; an older concurrent op arriving later loses the fold', () => {
    const conv = createConvergingApply();
    let root: unknown = { a: 0 };

    root = applyOps(root, conv.ingest(env([set(['a'], 2)], { p: 2, writer: 'x' })));
    root = applyOps(root, conv.ingest(env([set(['a'], 1)], { p: 1, writer: 'y' })));

    expect(root).toEqual({ a: 2 });
  });

  it('parent set vs newer child write converges in BOTH arrival orders (per-path registers + deepest-live-wins grafting)', () => {
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
    expect(ab).toEqual({ a: { x: 'P', b: 'C' } }); // parent applied, live child grafted on top
  });

  it('a concurrent descendant edit CATEGORICALLY survives an uncited parent replace (both never observed each other)', () => {
    // FLIPPED with the MV register: the old stamp-dominance swallowed the late child write;
    // now survival is by kind, not by clock: an uncited descendant write stays live and grafts.
    const conv = createConvergingApply();
    let root: unknown = { a: { b: 0 } };

    root = applyOps(root, conv.ingest(env([set(['a', 'b'], 1)], { p: 1, writer: 'x' })));
    root = applyOps(root, conv.ingest(env([set(['a'], { fresh: true })], { p: 2, writer: 'y' })));
    root = applyOps(root, conv.ingest(env([set(['a', 'b'], 99)], { p: 1, l: 1, writer: 'x' })));

    expect(root).toEqual({ a: { fresh: true, b: 99 } });
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
    expect(ab.note.siblings).toEqual(['A', 'B']); // the full live set, winner first
  });

  it('sequential edits (the second cites the first) never trigger the merge policy', () => {
    const conv = createConvergingApply({
      policies: [{ path: 'note', merge: preserve }],
    });
    let root: unknown = { note: 'base' };

    root = applyOps(root, conv.ingest(env([set(['note'], 'v1', 'base')], { p: 1, writer: 'a' })));
    root = applyOps(
      root,
      conv.ingest(
        env([{ ...set(['note'], 'v2', 'v1'), cites: [dot('a', 1)] }], { p: 2, writer: 'b' }),
      ),
    );

    expect(root).toEqual({ note: 'v2' }); // b observed + superseded a's dot, no conflict to preserve
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
  // Under the MV register every policy fold runs over the full live sibling set in a canonical
  // order, so convergence no longer depends on the merge being associative/commutative; the
  // preserve/keyedArray divergence of the single-winner register is gone. These used to be
  // characterization tests asserting the divergence; they now assert convergence.
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

  it('preserve: 4 concurrent leaf writes CONVERGE (flipped when the MV register landed)', () => {
    // The single-winner register nested Conflicted-in-Conflicted order-dependently for a 3rd
    // writer. The register now retains all live siblings and preserve folds them into ONE
    // Conflicted carrying the whole set, identically on every peer.
    expect(converges(preserve, 'v', { v: 'base' }, leafEnvs)).toBe(true);
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

  it('keyedArray: 3 concurrent array edits CONVERGE (flipped when the MV register landed)', () => {
    // Pairwise item-merge at arrival order was not associative; the register fold now merges
    // the N live sibling arrays in a canonical (set-derived) order, so the result is a pure
    // function of the delivered op set.
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
    expect(converges(byId, 'list', { list: anc }, envs)).toBe(true);
  });

  it('mergeThree: 3 concurrent writers to the SAME field + a nested object converge', () => {
    // harder case — 'a' changed by ALL three to distinct values, nested fields overlap. mergeThree
    // degrades to lww on a leaf conflict, and the fold order is canonical, so it converges.
    const base = { a: 0, nested: { p: 0, q: 0 } };
    const envs = [
      env([set(['o'], { a: 1, nested: { p: 1, q: 0 } }, base)], { p: 1, writer: 'w1' }),
      env([set(['o'], { a: 2, nested: { p: 0, q: 2 } }, base)], { p: 2, writer: 'w2' }),
      env([set(['o'], { a: 3, nested: { p: 3, q: 3 } }, base)], { p: 3, writer: 'w3' }),
    ];
    expect(converges(mergeThree, 'o', { o: base }, envs)).toBe(true);
  });
});

describe('createConvergingApply — dot-citation register semantics', () => {
  it('a CAUSAL write (cites the winner) supersedes it regardless of clocks', () => {
    const conv = createConvergingApply();
    let root: unknown = { v: 0 };
    root = applyOps(root, conv.ingest(env([set(['v'], 'W')], { p: 5, writer: 'x', origin: 'x' })));
    root = applyOps(
      root,
      conv.ingest(
        env([{ ...set(['v'], 'corrected', 'W'), cites: [dot('x', 5)] }], { p: 3, writer: 'y', origin: 'y' }),
      ),
    );
    expect(root).toEqual({ v: 'corrected' }); // lower clock, but causal knowledge wins
  });

  it('a cite arriving BEFORE the op it kills leaves that op born-dead (delivery-order-robust)', () => {
    const late = env([set(['v'], 'A')], { p: 5, writer: 'a', origin: 'a' });
    const citing = env([{ ...set(['v'], 'B', 'A'), cites: [dot('a', 5)] }], { p: 7, writer: 'b', origin: 'b' });
    const run = (order: OpEnvelope[]) => {
      const conv = createConvergingApply();
      let root: unknown = { v: 0 };
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return root;
    };
    expect(run([citing, late])).toEqual({ v: 'B' });
    expect(run([late, citing])).toEqual({ v: 'B' });
  });

  it('duplicate delivery is idempotent: no delta the second time', () => {
    const conv = createConvergingApply();
    const e = env([set(['v'], 'A')], { p: 5, writer: 'a', origin: 'a' });
    expect(conv.ingest(e).length).toBe(1);
    expect(conv.ingest(e)).toEqual([]);
  });

  it('a higher EPOCH wins the fold regardless of hlc', () => {
    const conv = createConvergingApply();
    let root: unknown = { v: 0 };
    root = applyOps(root, conv.ingest(env([{ ...set(['v'], 'fast'), epoch: 0 }], { p: 9, writer: 'x', origin: 'x' })));
    root = applyOps(
      root,
      conv.ingest(env([{ ...set(['v'], 'authoritative'), epoch: 1 }], { p: 2, writer: 'y', origin: 'y' })),
    );
    expect(root).toEqual({ v: 'authoritative' });
  });

  it('preserve: a concurrent set-vs-delete race surfaces Conflicted (the tombstone competes as a value)', () => {
    const conv = createConvergingApply({ policies: [{ path: 'v', merge: preserve }] });
    let root: unknown = { v: 'base' };
    root = applyOps(root, conv.ingest(env([set(['v'], 'A', 'base')], { p: 5, writer: 'a', origin: 'a' })));
    root = applyOps(root, conv.ingest(env([del(['v'], 'base')], { p: 6, writer: 'b', origin: 'b' })));
    const v = (root as { v: unknown }).v;
    expect(isConflicted(v)).toBe(true);
    expect((v as Conflicted).siblings).toEqual([undefined, 'A']); // the delete won the order → surfaces as undefined
  });

  it('preserve carries the FULL sibling set (not just two) for 3 concurrent writers, canonically ordered', () => {
    const conv = createConvergingApply({ policies: [{ path: 'v', merge: preserve }] });
    let root: unknown = { v: 'base' };
    for (const [origin, p, val] of [['a', 5, 'A'], ['b', 6, 'B'], ['c', 7, 'C']] as const) {
      root = applyOps(root, conv.ingest(env([set(['v'], val, 'base')], { p, writer: origin, origin })));
    }
    const v = (root as { v: unknown }).v as Conflicted;
    expect(isConflicted(v)).toBe(true);
    expect(v.siblings).toEqual(['C', 'B', 'A']); // every live sibling, ordered high→low by the total order
    expect([v.mine, v.theirs]).toEqual(['C', 'B']); // the two-sided seam aliases the top two
  });

  it('stamp: emission cites the live dots and adopts max(observed epoch, own floor)', () => {
    const conv = createConvergingApply();
    conv.ingest(env([{ ...set(['k'], 'X'), epoch: 3 }], { p: 5, writer: 'o', origin: 'o' }));
    const [op] = conv.stamp([{ kind: 'set', path: ['k'], next: 'Y', prev: 'X' }]);
    expect(op.cites).toEqual([dot('o', 5)]);
    expect(op.epoch).toBe(3); // carries the observed epoch forward without bumping
    const [bumped] = conv.stamp([{ kind: 'set', path: ['k'], next: 'Z', prev: 'X' }], { bump: true });
    expect(bumped.epoch).toBe(4);
  });

  it('epoch floor survives tombstone → re-create; a stale prior-epoch straggler cannot outrank the reborn value', () => {
    const conv = createConvergingApply();
    let root: unknown = {};
    root = applyOps(root, conv.ingest(env([{ ...set(['k'], 'SETTLED'), epoch: 3 }], { p: 5, writer: 'owner', origin: 'owner' })));
    root = applyOps(
      root,
      conv.ingest(
        env([{ kind: 'delete', path: ['k'], prev: 'SETTLED', cites: [dot('owner', 5)], epoch: 3 }], {
          p: 8,
          writer: 'u',
          origin: 'u',
        }),
      ),
    );
    expect(root).toEqual({});
    root = applyOps(
      root,
      conv.ingest(env([{ ...set(['k'], 'REBORN'), cites: [dot('u', 8)], epoch: 3 }], { p: 10, writer: 'v', origin: 'v' })),
    );
    expect(root).toEqual({ k: 'REBORN' });
    root = applyOps(root, conv.ingest(env([{ ...set(['k'], 'OLD'), epoch: 2 }], { p: 2, writer: 's', origin: 's' })));
    expect(root).toEqual({ k: 'REBORN' }); // epoch 3 > 2, no resurrection
  });

  it('GC seam: prune drops settled state without changing the fold; the admission frontier rejects stragglers', () => {
    const conv = createConvergingApply();
    let root: unknown = {};
    const A = env([set(['v'], 'A')], { p: 5, writer: 'a', origin: 'a' });
    root = applyOps(root, conv.ingest(A));
    root = applyOps(
      root,
      conv.ingest(env([{ ...set(['v'], 'B', 'A'), cites: [dot('a', 5)] }], { p: 20, writer: 'b', origin: 'b' })),
    );
    expect(root).toEqual({ v: 'B' });

    conv.prune({ p: 10, l: 0 }); // drops a's superseded sibling AND its watermark (state bounding)
    expect(conv.liveAt(['v']).map((s) => s.origin)).toEqual(['b']); // fold-equivalent

    // a below-frontier straggler is rejected at admission, so pruning cannot resurrect it
    expect(conv.ingest(A, { frontier: { p: 10, l: 0 } })).toEqual([]);
    expect(conv.liveAt(['v']).map((s) => s.origin)).toEqual(['b']);
  });
});

describe('createConvergingApply — subtree replace/delete groups (clear)', () => {
  // Emission derives the group from the emitter's OWN register map: `set A` + one CLEAR per
  // observed live descendant register. A clear retires a register (fold-winning clear abstains
  // at materialization); it is NOT a delete, so an uncontended replace keeps its own fields.
  const seedEnv = env([set(['settings'], { theme: 'old', lang: 'en' })], { p: 1, writer: 'w0', origin: 'w0' });
  const editOldEnv = env([set(['settings', 'theme'], 'w1-old')], { p: 2, writer: 'w1', origin: 'w1' });

  /** a replica that observed seed + editOld: the emission frontier for the replace groups */
  const observed = () => {
    const conv = createConvergingApply();
    conv.ingest(seedEnv);
    conv.ingest(editOldEnv);
    return conv;
  };
  const groupEnv = (ops: SyncOp[], stamp: { p: number; writer: string }): OpEnvelope => ({
    proto: OP_PROTO_VERSION,
    origin: stamp.writer,
    writer: stamp.writer,
    version: 1,
    hlc: { p: stamp.p, l: 0 },
    policyVersion: 0,
    ops,
  });
  const run = (order: OpEnvelope[]): unknown => {
    const conv = createConvergingApply();
    let root: unknown = {};
    for (const e of order) root = applyOps(root, conv.ingest(e));
    return root;
  };
  // w1's SECOND edit, concurrent with the replace (the replace never observed it)
  const editNewEnv = env(
    [{ ...set(['settings', 'theme'], 'w1-new', 'w1-old'), cites: [dot('w1', 2)] }],
    { p: 7, writer: 'w1', origin: 'w1', version: 2 },
  );

  it('stamp expands a container set into per-descendant clears citing exactly the observed dots', () => {
    const group = observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'new', extra: 1 } }]);
    expect(group.map((o) => o.kind)).toEqual(['set', 'clear']);
    expect(group[0].cites).toEqual([dot('w0', 1)]);
    expect(group[1].path).toEqual(['settings', 'theme']);
    expect(group[1].cites).toEqual([dot('w1', 2)]);
  });

  it('UN-BUMPED replace: the concurrent edit survives as "new settings, your theme" (both orders)', () => {
    const group = observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'new', extra: 1 } }]);
    const ge = groupEnv(group, { p: 6, writer: 'w2' });
    const forward = run([seedEnv, editOldEnv, ge, editNewEnv]); // edit arrives LATE, after the applied replace
    const reverse = run([editNewEnv, ge, editOldEnv, seedEnv]);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({ settings: { theme: 'w1-new', extra: 1 } });
  });

  it('survival is CATEGORICAL (kind), not an hlc race: a LOWER-clock concurrent edit also survives', () => {
    const group = observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'new', extra: 1 } }]);
    const ge = groupEnv(group, { p: 6, writer: 'w2' });
    const editLow = env(
      [{ ...set(['settings', 'theme'], 'w3-low', 'w1-old'), cites: [dot('w1', 2)] }],
      { p: 4, writer: 'w3', origin: 'w3' },
    );
    expect(run([seedEnv, editOldEnv, ge, editLow])).toEqual({
      settings: { theme: 'w3-low', extra: 1 },
    });
  });

  it('EPOCH-BUMPED replace CLEARS the concurrent edit: the authoritative subtree veto, same mechanic', () => {
    const group = observed().stamp(
      [{ kind: 'set', path: ['settings'], next: { theme: 'new', extra: 1 } }],
      { bump: true },
    );
    const ge = groupEnv(group, { p: 6, writer: 'w2' });
    expect(run([seedEnv, editOldEnv, ge, editNewEnv])).toEqual({
      settings: { theme: 'new', extra: 1 },
    });
    expect(run([editNewEnv, ge, seedEnv, editOldEnv])).toEqual({
      settings: { theme: 'new', extra: 1 },
    });
  });

  it('an UNCONTENDED replace keeps its own fields intact (a clear abstains; nothing is erased)', () => {
    const group = observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'new', extra: 1 } }]);
    const ge = groupEnv(group, { p: 6, writer: 'w2' });
    expect(run([seedEnv, editOldEnv, ge])).toEqual({ settings: { theme: 'new', extra: 1 } });
  });

  it('two CONCURRENT replaces converge: the fold winner keeps its own fields (all orders)', () => {
    const g2 = groupEnv(
      observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'from-w2' } }]),
      { p: 6, writer: 'w2' },
    );
    const g3 = groupEnv(
      observed().stamp([{ kind: 'set', path: ['settings'], next: { theme: 'from-w3' } }]),
      { p: 8, writer: 'w3' },
    );
    expect(run([seedEnv, editOldEnv, g2, g3])).toEqual({ settings: { theme: 'from-w3' } });
    expect(run([g3, g2, editOldEnv, seedEnv])).toEqual({ settings: { theme: 'from-w3' } });
    expect(run([g2, seedEnv, g3, editOldEnv])).toEqual({ settings: { theme: 'from-w3' } });
  });

  it('subtree DELETE: a concurrent edit under the deleted parent drops at materialization and REVIVES on re-create', () => {
    const world = createConvergingApply();
    const seedA = env([set(['a'], { x: 1 })], { p: 1, writer: 'w0', origin: 'w0' });
    world.ingest(seedA);
    const group = groupEnv(world.stamp([{ kind: 'delete', path: ['a'], prev: { x: 1 } }]), {
      p: 5,
      writer: 'w1',
    });
    const editUnder = env([set(['a', 'x'], 'survivor')], { p: 6, writer: 'w2', origin: 'w2' });

    const conv = createConvergingApply();
    let root: unknown = {};
    for (const e of [seedA, group, editUnder]) root = applyOps(root, conv.ingest(e));
    expect(root).toEqual({}); // 'a' deleted; the edit's graft has no container → dropped

    // re-create 'a' as a container (citing the tombstone) → the still-live edit RESURFACES
    root = applyOps(
      root,
      conv.ingest(env([{ ...set(['a'], {}), cites: [dot('w1', 5)] }], { p: 9, writer: 'w3', origin: 'w3' })),
    );
    expect(root).toEqual({ a: { x: 'survivor' } });
  });

  it('type-change graft determinism: an edit under a SCALAR parent drops the same way in every order', () => {
    const scalar = env([set(['a'], 42)], { p: 5, writer: 'w0', origin: 'w0' });
    const under = env([set(['a', 'x'], 'lost')], { p: 6, writer: 'w1', origin: 'w1' });
    expect(run([scalar, under])).toEqual(run([under, scalar]));
    expect(run([scalar, under])).toEqual({ a: 42 });
  });
});

describe('PROPERTY: the real register + materialization converge (impl parity with the proof model)', () => {
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T,>(arr: readonly T[], seed: number): T[] => {
    const r = mulberry32(seed);
    const c = [...arr];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  };

  const PATHS: (string | number)[][] = [
    [],
    ['a'],
    ['a', 'x'],
    ['a', 'y'],
    ['a', 'x', 'deep'],
    ['b'],
    ['b', 'z'],
  ];

  // a mixed workload emitted through the REAL emission path (stamp: cites + epochs + clear
  // groups, some bumped) against a sequential world replica; tests deliver in arbitrary orders
  function genEnvs(seed: number, rounds: number): OpEnvelope[] {
    const r = mulberry32(seed);
    const world = createConvergingApply();
    const out: OpEnvelope[] = [];
    let clock = 0;
    for (let i = 0; i < rounds; i++) {
      const writer = 'w' + Math.floor(r() * 3);
      const hlc = { p: ++clock, l: 0 };
      const path = PATHS[Math.floor(r() * PATHS.length)];
      const roll = r();
      let ops: SyncOp[];
      if (roll < 0.18) {
        ops = world.stamp(
          [{ kind: 'set', path, next: { v: `${writer}:${clock}` } }],
          { bump: r() < 0.3 },
        );
      } else if (roll < 0.28 && path.length > 0) {
        ops = world.stamp([{ kind: 'delete', path, prev: undefined }], { bump: r() < 0.3 });
      } else {
        const [stamped] = world.stamp([{ kind: 'set', path, next: `${writer}:${clock}` }]);
        // 30%: the writer never saw the path → a genuinely concurrent (uncited) write
        ops = r() < 0.3 ? [{ ...stamped, cites: [] }] : [stamped];
      }
      const e: OpEnvelope = {
        proto: OP_PROTO_VERSION,
        origin: writer,
        writer,
        version: i + 1,
        hlc,
        policyVersion: 0,
        ops,
      };
      world.ingest(e, { local: true });
      out.push(e);
    }
    return out;
  }

  const run = (units: readonly OpEnvelope[], seed: number): unknown => {
    const conv = createConvergingApply();
    let root: unknown = {};
    for (const e of shuffle(units, seed)) root = applyOps(root, conv.ingest(e));
    return root;
  };

  it('any arrival order of the same envelopes yields the identical tree (12 seeds × 6 orders)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const envs = genEnvs(seed * 41, 24);
      const base = run(envs, 1);
      for (let order = 2; order <= 6; order++) {
        expect(run(envs, order + seed * 13)).toEqual(base);
      }
    }
  });

  it('groups delivered SPLIT (one op per envelope) and DUPLICATED still converge to the same tree', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const envs = genEnvs(seed * 53, 20);
      const base = run(envs, 1);
      const split = envs.flatMap((e) => e.ops.map((op) => ({ ...e, ops: [op] })));
      for (let order = 2; order <= 5; order++) {
        expect(run(split, order + seed * 7)).toEqual(base);
        expect(run([...split, ...split], order + seed * 19)).toEqual(base);
      }
    }
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

  it('passes a clear through untouched (a register intent, not a value change)', () => {
    const root = { a: 1 };
    const clear: StoreOp = { kind: 'clear', path: ['a', 'b'] };
    const out = rebaseOps(root, [[clear]], [set(['a'], 2, 1)]);
    expect(out.root).toEqual({ a: 2 });
    expect(out.pending).toEqual([[clear]]);
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

    // resolution is just a later write: it cites every surviving dot, so it collapses the
    // sibling set on the peer instead of nesting another conflict
    a.update((s) => ({ ...s, v: 'resolved' }));
    syncA.flush();
    deliverAB();
    expect(b().v).toBe('resolved');
  });

  it('drops foreign-proto envelopes with a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { a, syncA } = pair();
      syncA.receive({
        ...env([set(['v'], 'evil')], { p: 99, writer: 'z' }),
        proto: OP_PROTO_VERSION + 1,
      });
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

describe('opSync — override (scoped authority bump)', () => {
  function scoped() {
    return TestBed.runInInjectionContext(() => {
      const sa = signal<{ v: string }>({ v: 'init' });
      const sb = signal<{ v: string }>({ v: 'init' });
      const a = opSync(sa, { writer: 'wa', origin: 'oa', clock: createHlcClock(() => 1) });
      const b = opSync(sb, { writer: 'wb', origin: 'ob', clock: createHlcClock(() => 100) });
      const aOut: OpEnvelope[] = [];
      const bOut: OpEnvelope[] = [];
      a.subscribe((e) => aOut.push(e));
      b.subscribe((e) => bOut.push(e));
      return { sa, sb, a, b, aOut, bOut };
    });
  }
  const exchange = (x: { a: OpSync; b: OpSync; aOut: OpEnvelope[]; bOut: OpEnvelope[] }) => {
    for (const e of x.bOut.splice(0)) x.a.receive(e);
    for (const e of x.aOut.splice(0)) x.b.receive(e);
  };

  it('a bumped write beats a concurrent write with a HIGHER clock, on both peers', () => {
    const x = scoped();
    x.sb.set({ v: 'fast' });
    x.b.flush();
    x.a.override(() => x.sa.set({ v: 'authoritative' }));
    exchange(x);
    expect(x.sa().v).toBe('authoritative');
    expect(x.sb().v).toBe('authoritative');
  });

  it('control: without the bump, the higher clock wins the same race', () => {
    const x = scoped();
    x.sb.set({ v: 'fast' });
    x.b.flush();
    x.sa.set({ v: 'plain' });
    x.a.flush();
    exchange(x);
    expect(x.sa().v).toBe('fast');
    expect(x.sb().v).toBe('fast');
  });

  it('a later normal write adopts the bumped epoch and competes normally again', () => {
    const x = scoped();
    x.sb.set({ v: 'fast' });
    x.b.flush();
    x.a.override(() => x.sa.set({ v: 'authoritative' }));
    exchange(x);
    x.sb.set({ v: 'follow-up' }); // cites the bumped dot → carries its epoch, no privilege needed
    x.b.flush();
    exchange(x);
    expect(x.sa().v).toBe('follow-up');
    expect(x.sb().v).toBe('follow-up');
  });

  it('bumped replace clears a concurrent descendant edit; un-bumped lets it survive (through real emission)', () => {
    // the same veto-vs-merge pair as the conv-level group tests, driven end-to-end through
    // opSync writes: replace via type change (object → null → object) so the diff emits
    // container sets, with b's second theme edit concurrent to a's replace
    type S = { settings: { theme: string } | null };
    const build = (bump: boolean) =>
      TestBed.runInInjectionContext(() => {
        const sa = signal<S>({ settings: { theme: 'old' } });
        const sb = signal<S>({ settings: { theme: 'old' } });
        const a = opSync(sa, { writer: 'wa', origin: 'oa', clock: createHlcClock(() => 10) });
        const b = opSync(sb, { writer: 'wb', origin: 'ob', clock: createHlcClock(() => 20) });
        const aOut: OpEnvelope[] = [];
        const bOut: OpEnvelope[] = [];
        a.subscribe((e) => aOut.push(e));
        b.subscribe((e) => bOut.push(e));
        const deliver = () => {
          for (const e of bOut.splice(0)) a.receive(e);
          for (const e of aOut.splice(0)) b.receive(e);
        };

        // b edits the theme; a observes it (it is now in a's register map)
        sb.update((s) => ({ settings: { theme: 'seen', ...(s.settings ?? {}) } }));
        sb.set({ settings: { theme: 'seen' } });
        b.flush();
        deliver();
        expect(sa().settings?.theme).toBe('seen');

        // CONCURRENT: b edits again; a replaces the whole subtree (type change → container set)
        sb.set({ settings: { theme: 'b-concurrent' } });
        b.flush();
        const replace = () => {
          sa.set({ settings: null });
          a.flush();
          sa.set({ settings: { theme: 'fresh' } });
          a.flush();
        };
        if (bump) a.override(replace);
        else replace();
        deliver();
        deliver(); // second wave settles cross-deliveries
        return { av: sa().settings, bv: sb().settings };
      });

    const bumped = build(true);
    expect(bumped.av).toEqual({ theme: 'fresh' }); // the authoritative replace vetoed the edit
    expect(bumped.bv).toEqual(bumped.av);

    const polite = build(false);
    expect(polite.av).toEqual({ theme: 'b-concurrent' }); // the concurrent edit survived the replace
    expect(polite.bv).toEqual(polite.av);
  });
});

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
    expect(r2).toEqual({ a: 9 }); // older delete loses the fold
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

  it('reset() clears registers so a previously-losing older op applies again', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set(['a'], 2)], { p: 5, writer: 'x' })); // register a newer winner
    expect(conv.ingest(env([set(['a'], 1)], { p: 1, writer: 'y' }))).toEqual([]); // loses the fold

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
      sync.hydrate({ root: { v: 'init', keep: 'from-room' }, registers: [], wm: {} }); // remote changed a different field
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
      sync.hydrate({ root: { v: 'from-room' }, registers: [], wm: { o1: 1 } }); // my v1 is already applied
      return s();
    });
    expect(out.v).toBe('from-room'); // offline write not re-applied — the room already has it
  });

  it('hydrate folds the incoming watermark (max per origin)', () => {
    const wm = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: number }>({ v: 0 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      sync.hydrate({ root: { v: 0 }, registers: [], wm: { r1: 5, r2: 3 } });
      return sync.watermark();
    });
    expect(wm['r1']).toBe(5);
    expect(wm['r2']).toBe(3);
  });

  it('seed emits a whole-root set of the current value (fresh room: no cites, no clears)', () => {
    const emitted = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; n: number }>({ v: 'x', n: 1 });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      sync.seed();
      return out;
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].ops).toEqual([
      { kind: 'set', path: [], next: { v: 'x', n: 1 }, cites: [], epoch: 0 },
    ]);
  });

  it('snapshot returns the checkpoint: root, register state, and the per-origin watermark', () => {
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
    const paths = snap.registers.map((r) => r.path.join('.')).sort();
    expect(paths).toEqual(['v', 'x']); // register state ships alongside the root, never folded away
  });
});

describe('opSync — checkpoint carries register state (the seed/hydrate contract)', () => {
  it('a joiner hydrated from a checkpoint treats a pre-checkpoint straggler exactly like the base peer', () => {
    TestBed.runInInjectionContext(() => {
      const sa = signal<{ v: string }>({ v: 'init' });
      const a = opSync(sa, { writer: 'wa', origin: 'oa' });
      // r1 wrote 'A' at clock 9; r2 causally replaced it at a LOWER clock (cites r1's dot)
      a.receive(env([set(['v'], 'A', 'init')], { p: 9, writer: 'r1', origin: 'r1', version: 1 }));
      a.receive(
        env([{ ...set(['v'], 'B', 'A'), cites: [dot('r1', 9)] }], { p: 5, writer: 'r2', origin: 'r2', version: 1 }),
      );
      expect(sa().v).toBe('B');

      const checkpoint = a.snapshot();

      const sj = signal<{ v: string }>({ v: 'init' });
      const j = opSync(sj, { writer: 'wj', origin: 'oj' });
      j.hydrate(checkpoint);
      expect(sj().v).toBe('B');

      // a straggler from r1 BELOW its supersession watermark: born-dead on base AND joiner
      const straggler = env([set(['v'], 'A-again', 'init')], { p: 8, writer: 'r1', origin: 'r1', version: 2 });
      a.receive(straggler);
      j.receive(straggler);
      expect(sa().v).toBe('B');
      expect(sj().v).toBe('B'); // register state travelled: no resurrection on the joiner

      // control: hydrating the VALUE alone (registers stripped) resurrects the straggler,
      // the divergence the register-state checkpoint exists to prevent
      const sn = signal<{ v: string }>({ v: 'init' });
      const naive = opSync(sn, { writer: 'wn', origin: 'on' });
      naive.hydrate({ root: checkpoint.root, registers: [], wm: checkpoint.wm });
      naive.receive(straggler);
      expect(sn().v).toBe('A-again');
    });
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
    // `receive` freezes the pending local write's stamp BEFORE observing the remote clock, so the
    // write keeps its original stamp and the higher physical clock wins the same-path conflict —
    // identically at every replica (no self-favouring re-stamp).
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
      sync.hydrate({ root: { a: '0', b: '0', keep: 'from-room' }, registers: [], wm: {} }); // both uncovered
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
      sync.hydrate({ root: { v: 'init', keep: 'from-room' }, registers: [], wm: {} }); // reconnect: room changed a different field
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
      sync.hydrate({ root: { v: 'from-room' }, registers: [], wm: { o1: 7 } }); // the room already saw our writes through v7
      s.set({ v: 'after' });
      sync.flush();
      return out;
    });
    expect(emitted[0]?.version).toBe(8); // next mint continues past the hydrated watermark, not 1
  });
});

describe('opSync — syncedFork (fork.commit as an emission path)', () => {
  type S = { v: string };

  function twoPeers(opt?: { policies?: Parameters<typeof opSync>[1]['policies'] }) {
    return TestBed.runInInjectionContext(() => {
      const sa = store<S>({ v: 'init' });
      const sb = store<S>({ v: 'init' });
      const a = opSync(sa, {
        writer: 'wa',
        origin: 'oa',
        clock: createHlcClock(() => 1),
        policies: opt?.policies,
      });
      const b = opSync(sb, {
        writer: 'wb',
        origin: 'ob',
        clock: createHlcClock(() => 2),
        policies: opt?.policies,
      });
      const aOut: OpEnvelope[] = [];
      const bOut: OpEnvelope[] = [];
      a.subscribe((e) => aOut.push(e));
      b.subscribe((e) => bOut.push(e));
      const deliverAB = () => {
        for (const e of aOut.splice(0)) b.receive(e);
      };
      const deliverBA = () => {
        for (const e of bOut.splice(0)) a.receive(e);
      };
      return { sa, sb, a, b, aOut, bOut, deliverAB, deliverBA };
    });
  }

  it('a commit is CONCURRENT with a mid-flight edit — preserve surfaces both (the fold decides, not the approval click)', () => {
    const x = twoPeers({ policies: [{ path: 'v', merge: preserve }] });
    x.sa.v.set('base');
    x.a.flush();
    x.deliverAB(); // both peers observe 'base'

    const fk = syncedFork(x.a, x.sa); // observes 'base', nothing newer

    x.sb.v.set('mid'); // a mid-flight edit, delivered onto the base before the commit
    x.b.flush();
    x.deliverBA();
    expect((x.sa().v as unknown) === 'mid').toBe(true); // base moved on under the fork

    fk.store.v.set('fork');
    fk.commit(); // cites only 'base' (fork-time frontier), NOT 'mid'
    x.deliverAB();

    // both survive as concurrent siblings on BOTH peers — 'mid' is not steamrolled
    expect(isConflicted(x.sa().v)).toBe(true);
    expect(x.sa().v).toEqual(x.sb().v);
    const sibs = (x.sa().v as unknown as Conflicted).siblings;
    expect([...sibs].sort()).toEqual(['fork', 'mid']);
  });

  it('PROPERTY: the emitted commit + mid-flight ops converge under every delivery order (incl. duplicates)', () => {
    const x = twoPeers();
    x.sa.v.set('base');
    x.a.flush();
    const baseEnv = x.aOut[0];
    x.deliverAB();

    const fk = syncedFork(x.a, x.sa);
    x.sb.v.set('mid');
    x.b.flush();
    const midEnv = x.bOut[0];
    x.deliverBA();

    fk.store.v.set('fork');
    fk.commit();
    const forkEnv = x.aOut.find((e) => e.ops.some((o) => o.kind === 'set' && (o as { next?: unknown }).next === 'fork'));
    if (!baseEnv || !midEnv || !forkEnv) throw new Error('missing an envelope');

    const orders: OpEnvelope[][] = [
      [baseEnv, midEnv, forkEnv],
      [baseEnv, forkEnv, midEnv],
      [midEnv, baseEnv, forkEnv], // a cite before its op
      [forkEnv, midEnv, baseEnv],
      [forkEnv, baseEnv, midEnv, forkEnv], // duplicate delivery
      [midEnv, forkEnv, baseEnv, midEnv],
    ];
    const results = orders.map((order) => {
      const conv = createConvergingApply({});
      let root: unknown = { v: 'init' };
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return (root as S).v;
    });
    expect(new Set(results).size).toBe(1); // one converged value across every order
    expect(['fork', 'mid']).toContain(results[0]); // and it is one of the true siblings
  });

  it('with NO mid-flight edit a commit behaves exactly like a live write: it cites what it saw and supersedes it', () => {
    const x = twoPeers();
    x.sa.v.set('base');
    x.a.flush();
    const baseDot = { origin: 'oa', hlc: x.aOut[0].hlc };
    x.deliverAB();

    const fk = syncedFork(x.a, x.sa);
    fk.store.v.set('fork');
    fk.commit();
    const forkEnv = x.aOut.find((e) => e.ops.some((o) => o.kind === 'set' && (o as { next?: unknown }).next === 'fork'));
    if (!forkEnv) throw new Error('missing fork commit envelope');

    const op = forkEnv.ops[0] as SyncOp;
    expect(op.cites).toEqual([baseDot]); // cited exactly the dot it observed
    expect(x.sa().v).toBe('fork'); // supersedes locally
    x.deliverAB();
    expect(x.sb().v).toBe('fork'); // and on the peer — a plain live write
  });

  it('honors the per-path own-prior epoch floor on commit: an observed override keeps its epoch', () => {
    const x = twoPeers();
    x.a.override(() => x.sa.v.set('authoritative')); // bumps epoch to 1 at ['v']
    x.deliverAB();

    const fk = syncedFork(x.a, x.sa); // observes the bumped write
    fk.store.v.set('fork');
    fk.commit();
    const forkEnv = x.aOut.find((e) => e.ops.some((o) => o.kind === 'set' && (o as { next?: unknown }).next === 'fork'));
    if (!forkEnv) throw new Error('missing fork commit envelope');

    expect((forkEnv.ops[0] as SyncOp).epoch).toBe(1); // carried the bumped epoch, never regressed to 0
    x.deliverAB();
    expect(x.sa().v).toBe('fork');
    expect(x.sb().v).toBe('fork');
  });

  // rebase advances the observed frontier: the SAME scenario is a concurrent conflict WITHOUT a
  // rebase and a clean supersession WITH one — proving rebase() actually moves what commit cites
  const rebaseScenario = (rebase: boolean) => {
    const x = twoPeers({ policies: [{ path: 'v', merge: preserve }] });
    x.sa.v.set('base');
    x.a.flush();
    x.deliverAB();

    const fk = syncedFork(x.a, x.sa);
    x.sb.v.set('mid');
    x.b.flush();
    x.deliverBA(); // the mid-flight edit lands on a's base

    if (rebase) fk.rebase(); // the reviewer re-observes the base, including 'mid'
    fk.store.v.set('fork');
    fk.commit();
    x.deliverAB();
    expect(x.sa().v).toEqual(x.sb().v); // converged either way
    return x.sa().v;
  };

  it('WITHOUT a rebase the commit stays concurrent with the mid-flight edit (preserve → both survive)', () => {
    const v = rebaseScenario(false);
    expect(isConflicted(v)).toBe(true);
    expect([...(v as unknown as Conflicted).siblings].sort()).toEqual(['fork', 'mid']);
  });

  it('WITH a rebase the commit cites the post-rebase frontier and supersedes the once-concurrent write', () => {
    const v = rebaseScenario(true);
    expect(isConflicted(v)).toBe(false);
    expect(v).toBe('fork');
  });
});

describe('createConvergingApply — untrusted ingress (crafted origins/writers)', () => {
  it('a crafted origin cannot collide the live-set signature and skip a fold update (order-independence holds)', () => {
    // The change-detector must not confuse two DISTINCT live sets. With a separator-joined sig a
    // crafted origin makes sig({C}) == sig({A,B}); the fold-skip on an equal sig then makes the
    // SAME op set converge to different values by arrival order. Origins are caller-supplied on a
    // P2P peer, so this must be robust regardless of what the string contains.
    const A = env([set(['v'], 'VA', 'base')], { p: 1, writer: 'A', origin: 'A' });
    const B = env([set(['v'], 'VB', 'base')], { p: 2, writer: 'B', origin: 'B' });
    const C = env([{ ...set(['v'], 'VC', 'base'), cites: [dot('A', 1), dot('B', 2)] }], {
      p: 2,
      l: 0,
      writer: 'wc',
      origin: 'A@1.0#0s|B', // engineered so a naive `${origin}@${p}.${l}#${epoch}${kind}` sig collides
    });

    const run = (order: OpEnvelope[]) => {
      const conv = createConvergingApply();
      let root: unknown = { v: 'base' };
      for (const e of order) root = applyOps(root, conv.ingest(e));
      return (root as { v: unknown }).v;
    };
    // C cites A and B → the live set is {C} in every order; the materialized value must be VC always
    expect(run([C, A, B])).toBe('VC');
    expect(run([A, B, C])).toBe('VC');
    expect(run([A, C, B])).toBe('VC');
  });
});

describe('createConvergingApply — path key integrity', () => {
  it('distinct paths whose segments concatenate the same stay INDEPENDENT registers', () => {
    // keyOf must not fold ['a','b'] and ['ab'] onto one register (an empty path separator does)
    const conv = createConvergingApply();
    let root: unknown = {};
    root = applyOps(root, conv.ingest(env([set(['a', 'b'], 'X')], { p: 1, writer: 'w1', origin: 'o1' })));
    root = applyOps(root, conv.ingest(env([set(['ab'], 'Y')], { p: 2, writer: 'w2', origin: 'o2' })));
    expect(root).toEqual({ a: { b: 'X' }, ab: 'Y' });
  });

  it('a sibling key that shares a prefix is NOT treated as a subtree descendant', () => {
    // descendantsOf uses a startsWith prefix test; ['ax'] must not count as living under ['a']
    const conv = createConvergingApply();
    let root: unknown = {};
    root = applyOps(root, conv.ingest(env([set(['a'], { x: 1 })], { p: 1, writer: 'w1', origin: 'o1' })));
    root = applyOps(root, conv.ingest(env([set(['ax'], 'sibling')], { p: 2, writer: 'w2', origin: 'o2' })));
    expect(root).toEqual({ a: { x: 1 }, ax: 'sibling' });
    expect(conv.materialize()).toEqual({ a: { x: 1 }, ax: 'sibling' });
  });
});

describe('createConvergingApply — prune bounds lone tombstones (GC finding 1)', () => {
  it('reclaims lone winning tombstones below the frontier under set-then-delete key churn', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set([], {})], { p: 1, writer: 'seed', origin: 'seed' }));
    const N = 20;
    for (let i = 1; i <= N; i++) {
      const h = 2 * i;
      conv.ingest(env([set(['k' + i], i)], { p: h, writer: 'w', origin: 'w' }));
      conv.ingest(env([{ ...del(['k' + i], i), cites: [dot('w', h)] }], { p: h + 1, writer: 'w', origin: 'w' }));
    }
    // each key set then cited-deleted → each ['kᵢ'] register is a lone tombstone; nothing else
    // materializes the key, so a below-frontier prune must reclaim every one of them
    conv.prune({ p: 10 * N, l: 0 });
    expect(conv.checkpoint().length).toBeLessThanOrEqual(1); // only the root set survives
  });
});

describe('createConvergingApply — malformed op robustness (finding B2/B3)', () => {
  it('ignores a stray clear/delete at the ROOT path: materialize and delta peers agree', () => {
    const conv = createConvergingApply();
    let root: unknown = {};
    root = applyOps(root, conv.ingest(env([set([], { a: 1 })], { p: 1, writer: 'x', origin: 'x' })));
    // a stray high-epoch clear at the root has no parent register to abstain to; it must not blank the doc
    root = applyOps(
      root,
      conv.ingest(env([{ kind: 'clear', path: [], epoch: 5 } as unknown as StoreOp], { p: 2, writer: 'y', origin: 'y' })),
    );
    expect(root).toEqual({ a: 1 }); // delta peer keeps the value
    expect(conv.materialize()).toEqual({ a: 1 }); // a joiner deriving via materialize agrees
    // and a root delete is equally meaningless
    root = applyOps(
      root,
      conv.ingest(env([{ kind: 'delete', path: [], prev: undefined, epoch: 6 } as unknown as StoreOp], { p: 3, writer: 'z', origin: 'z' })),
    );
    expect(root).toEqual({ a: 1 });
    expect(conv.materialize()).toEqual({ a: 1 });
  });

  it('drops an op that cites its OWN dot rather than letting it self-supersede into nothing', () => {
    const conv = createConvergingApply();
    // the op cites (origin X, hlc 5) which is its own dot; a naive watermark would born-dead it
    const root = applyOps(
      {},
      conv.ingest(env([{ ...set(['a'], 42), cites: [dot('X', 5)] }], { p: 5, writer: 'X', origin: 'X' })),
    );
    expect(root).toEqual({ a: 42 }); // the write survives
    expect(conv.liveAt(['a']).length).toBe(1);
  });
});

describe('opSync — hydrate reconciles a same-path conflict through the fold (crash finding 1)', () => {
  it('a pending local write that LOSES the fold to a loaded higher-epoch sibling does not linger in the store', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string }>({ v: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ v: 'LOCAL' }); // an offline pending write, epoch 0, version 1
      sync.flush();
      // reconnect: the room's register at ['v'] holds a higher-epoch remote winner the pending never saw
      sync.hydrate({
        root: { v: 'REMOTE' },
        registers: [
          {
            path: ['v'],
            siblings: [{ kind: 'set', value: 'REMOTE', writer: 'wrem', origin: 'rem', hlc: { p: 100, l: 0 }, epoch: 5 }],
            water: {},
          },
        ],
        wm: { rem: 1 }, // does not cover o1:1, so LOCAL stays pending
      });
      return s();
    });
    // the fold picks REMOTE (epoch 5 > 0); the store must not show LOCAL, which no peer agrees with
    expect(out).toEqual({ v: 'REMOTE' });
  });

  it('a pending local write that WINS the fold still shows locally (read-your-writes preserved)', () => {
    const out = TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; keep: string }>({ v: 'init', keep: 'x' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      s.set({ v: 'LOCAL', keep: 'x' });
      sync.flush();
      sync.hydrate({ root: { v: 'init', keep: 'from-room' }, registers: [], wm: {} });
      return s();
    });
    expect(out).toEqual({ v: 'LOCAL', keep: 'from-room' }); // local edit survives, room's other field taken
  });
});

describe('createConvergingApply — prune reclaims nested lone tombstones (GC finding 2 parity)', () => {
  it('drops an ancestor tombstone even when its descendant tombstone is collected the same pass', () => {
    const conv = createConvergingApply();
    conv.ingest(env([set([], {})], { p: 1, writer: 'oa', origin: 'oa' }));
    conv.ingest(env([set(['items'], { a: 1 })], { p: 2, writer: 'oa', origin: 'oa' }));
    conv.ingest(env([set(['items', 'deep'], 9)], { p: 3, writer: 'oa', origin: 'oa' }));
    conv.ingest(env([del(['items'], { a: 1 })], { p: 4, writer: 'oa', origin: 'oa' }));
    conv.ingest(env([del(['items', 'deep'], 9)], { p: 5, writer: 'oa', origin: 'oa' }));
    conv.prune({ p: 100, l: 0 });
    const paths = conv.checkpoint().map((c) => c.path.join('.'));
    expect(paths).not.toContain('items'); // ancestor tombstone reclaimed, not stranded
    expect(paths).not.toContain('items.deep');
  });
});

describe('createConvergingApply — prune is fold-equivalent + bounds state (GC property)', () => {
  // A small deterministic PRNG (mulberry32) so the sweep is reproducible.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Build a random-but-well-formed op stream over a few paths and origins, with deletes/sets that
  // cite the dot they observed (so supersession, tombstones, and subtree replaces really happen).
  const buildStream = (seed: number) => {
    const r = rng(seed);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
    const paths: (string | number)[][] = [['a'], ['a', 'b'], ['a', 'c'], ['d'], ['d', 'e']];
    const origins = ['o1', 'o2', 'o3'];
    const envs: OpEnvelope[] = [];
    let p = 1;
    const lastDotAt = new Map<string, Dot>();
    const nOps = 12 + Math.floor(r() * 16);
    for (let i = 0; i < nOps; i++) {
      const path = pick(paths);
      const origin = pick(origins);
      const key = path.join('/');
      const observed = lastDotAt.get(key);
      const cites = observed && r() < 0.6 ? [observed] : []; // 60% causal, else concurrent
      const hlc = { p: p++, l: 0 };
      const kind = r() < 0.75 ? 'set' : 'delete';
      const op =
        kind === 'set'
          ? { kind: 'set' as const, path, next: `v${i}`, cites, epoch: 0 }
          : { kind: 'delete' as const, path, prev: null, cites, epoch: 0 };
      envs.push({ proto: OP_PROTO_VERSION, origin, writer: origin, version: i + 1, hlc, policyVersion: 0, ops: [op] });
      lastDotAt.set(key, { origin, hlc });
    }
    return envs;
  };

  const materializeAll = (envs: OpEnvelope[]) => {
    const conv = createConvergingApply();
    for (const e of envs) conv.ingest(e);
    return conv;
  };

  it('prune at ANY frontier leaves materialize() unchanged (fold-equivalence, 40 seeds × 4 frontiers)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const envs = buildStream(seed);
      const maxP = envs.length; // hlc p values run 1..nOps
      for (const frac of [0, 0.33, 0.66, 1]) {
        const conv = materializeAll(envs);
        const before = conv.materialize();
        conv.prune({ p: Math.floor(maxP * frac), l: 0 });
        const after = conv.materialize();
        expect(after, `seed ${seed} frontier ${frac}: prune changed the fold`).toEqual(before);
      }
    }
  });

  it('prune at the top frontier bounds state: no superseded sibling and no droppable lone tombstone survives', () => {
    // re-derive the drop guard here so the check is independent of the implementation: a lone
    // tombstone is droppable (and so must be gone after a top-frontier prune) when nothing else
    // materializes its key — no live ancestor set holds it, and no live descendant would resurface.
    const holdsKey = (value: unknown, rel: readonly (string | number)[]): boolean => {
      let cur: unknown = value;
      for (const seg of rel) {
        if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, String(seg))) return false;
        cur = (cur as Record<string, unknown>)[String(seg)];
      }
      return true;
    };
    for (let seed = 1; seed <= 40; seed++) {
      const envs = buildStream(seed);
      const conv = materializeAll(envs);
      const live = conv.materialize();
      conv.prune({ p: envs.length + 1, l: 0 }); // above every op
      const regs = conv.checkpoint();
      for (const reg of regs) {
        const liveSet = conv.liveAt(reg.path);
        expect(liveSet.length, `seed ${seed}: superseded-only register retained at ${reg.path.join('/')}`).toBeGreaterThan(0);
        const loneTomb = liveSet.length === 1 && liveSet[0].kind === 'delete';
        if (!loneTomb) continue;
        const key = reg.path.join('/');
        const hasLiveDescendant = regs.some(
          (o) => o.path.join('/') !== key && o.path.join('/').startsWith(key + '/') && conv.liveAt(o.path).length > 0,
        );
        const ancestorHoldsKey = regs.some((o) => {
          const ok = o.path.join('/');
          if (ok === key || !key.startsWith(ok === '' ? '' : ok + '/')) return false;
          const rel = reg.path.slice(o.path.length);
          return conv.liveAt(o.path).some((s) => s.kind === 'set' && holdsKey(s.value, rel));
        });
        expect(
          hasLiveDescendant || ancestorHoldsKey,
          `seed ${seed}: droppable lone tombstone leaked at ${key} (nothing materializes the key)`,
        ).toBe(true);
      }
      expect(conv.materialize(), `seed ${seed}: top-frontier prune changed the fold`).toEqual(live);
    }
  });
});

describe('opSync — hydrate reconcile correctness (self-review oracle)', () => {
  // Oracle: hydrating a checkpoint WITH pending writes must converge to the same store as a peer that
  // hydrates the same checkpoint and then RECEIVES those pending ops through the canonical fold path.
  // Exercises multi/nested/overlapping/delete pending against a contended, epoch-bumped loaded sibling
  // and against an unregistered checkpoint field — the intricate paths the single Crash-1 test misses.
  it('store == a peer that hydrates then receives the same pending (nested, overlapping, delete)', () => {
    type S = {
      contended: string;
      roomOnly: string;
      newField?: string;
      nested: { deep: string; other: string };
      toDelete?: string;
    };
    const init = (): S => ({ contended: 'i', roomOnly: 'i', nested: { deep: 'i', other: 'i' }, toDelete: 'i' });

    const out = TestBed.runInInjectionContext(() => {
      // remote peer R establishes a room state, including an AUTHORITY bump on `contended`. `nested.deep`
      // and `toDelete` stay at their init values on R, so they live in the checkpoint ROOT with NO register.
      const sr = signal<S>(init());
      const R = opSync(sr, { writer: 'wr', origin: 'r', clock: createHlcClock(() => 100) });
      sr.set({ ...sr(), roomOnly: 'ROOM', nested: { deep: 'i', other: 'ROOM' } });
      R.flush();
      R.override(() => sr.set({ ...sr(), contended: 'REMOTE' })); // epoch 1
      R.flush();
      const checkpoint = R.snapshot();

      // local peer A edits offline (never delivered to R): loses `contended`, wins new/nested, deletes a
      // key, and writes the SAME field twice (o1's later write replaces its earlier in the register)
      const sa = signal<S>(init());
      const A = opSync(sa, { writer: 'wa', origin: 'o1', clock: createHlcClock(() => 10) });
      const pending: OpEnvelope[] = [];
      A.subscribe((e) => pending.push(e));
      sa.set({ ...sa(), contended: 'local-x', newField: 'A1' });
      A.flush();
      sa.set({ ...sa(), newField: 'A2', nested: { deep: 'A-deep', other: 'i' } }); // newField rewritten
      A.flush();
      sa.update((s) => { const c = { ...s }; delete c.toDelete; return c; });
      A.flush();
      A.hydrate(checkpoint);
      const storeAfter = sa();

      // ORACLE peer B: hydrate the SAME checkpoint with no pending, then RECEIVE A's pending envelopes
      // through the ordinary fold path. Same delivered op set -> must converge to the same store.
      const sb = signal<S>(init());
      const B = opSync(sb, { writer: 'wb', origin: 'b', clock: createHlcClock(() => 200) });
      B.hydrate(checkpoint);
      for (const e of pending) B.receive(e);
      const oracle = sb();

      A.destroy();
      R.destroy();
      B.destroy();
      return { storeAfter, oracle };
    });

    expect(out.storeAfter).toEqual(out.oracle); // hydrate-with-pending == hydrate-then-receive
    // and spot-check the intent: contended lost to the epoch-1 remote, everything else is A's
    expect(out.storeAfter.contended).toBe('REMOTE');
    expect(out.storeAfter.roomOnly).toBe('ROOM');
    expect(out.storeAfter.newField).toBe('A2');
    expect(out.storeAfter.nested.deep).toBe('A-deep');
    expect(out.storeAfter.nested.other).toBe('ROOM'); // R's edit to a sibling field survives
    expect(Object.hasOwn(out.storeAfter, 'toDelete')).toBe(false);
  });
});

describe('createConvergingApply — fork subtree replace only clears OBSERVED descendants (3a self-review)', () => {
  it('a frontier-scoped subtree set clears descendants seen at fork time, never ones that arrived after', () => {
    const conv = createConvergingApply();
    // fork-time state: a descendant register the fork observes
    conv.ingest(env([set(['settings', 'theme'], 'x')], { p: 1, writer: 'o1', origin: 'o1' }));
    const frontier = conv.captureFrontier();
    // AFTER the fork: a concurrent descendant the fork never saw
    conv.ingest(env([set(['settings', 'font'], 'y')], { p: 2, writer: 'o2', origin: 'o2' }));

    // the fork commits a subtree replace at ['settings'], stamped against the frozen frontier
    const stamped = conv.stamp([{ kind: 'set', path: ['settings'], next: { theme: 'fresh' } }], { frontier });
    const clears = stamped.filter((o) => o.kind === 'clear').map((o) => o.path.join('/'));
    expect(clears).toContain('settings/theme'); // observed at fork time -> cleared
    expect(clears).not.toContain('settings/font'); // arrived after the fork -> NOT cleared

    // and it converges: applying the group, the post-fork font survives the replace as a sibling
    const env2: OpEnvelope = { proto: OP_PROTO_VERSION, origin: 'o1', writer: 'o1', version: 1, hlc: { p: 3, l: 0 }, policyVersion: 0, ops: stamped };
    // fresh peer sees theme, font, then the replace group -> font must remain
    const peer = createConvergingApply();
    peer.ingest(env([set(['settings', 'theme'], 'x')], { p: 1, writer: 'o1', origin: 'o1' }));
    peer.ingest(env([set(['settings', 'font'], 'y')], { p: 2, writer: 'o2', origin: 'o2' }));
    const root = applyOps({}, peer.ingest(env2));
    expect(root).toEqual({ settings: { theme: 'fresh', font: 'y' } }); // theme replaced, font survived
  });
});

describe('validateEnvelope — deterministic, total well-formedness', () => {
  const CTRL = String.fromCharCode(0x1f); // the path-key separator; must never enter an id or segment
  const valid = (): OpEnvelope => ({
    proto: OP_PROTO_VERSION,
    origin: 'o1',
    writer: 'w1',
    version: 1,
    hlc: { p: 5, l: 0 },
    policyVersion: 0,
    ops: [
      { kind: 'set', path: ['a', 'b'], next: 1, cites: [{ origin: 'o2', hlc: { p: 2, l: 0 } }], epoch: 0 },
    ],
  });
  // deep-clone + patch, so each case mutates an otherwise valid envelope
  const mutate = (fn: (e: any) => void): OpEnvelope => {
    const e = structuredClone(valid());
    fn(e as any);
    return e as OpEnvelope;
  };

  it('accepts a well-formed envelope (incl. a set at the root path)', () => {
    expect(validateEnvelope(valid())).toBeNull();
    expect(validateEnvelope(mutate((e) => (e.ops = [{ kind: 'set', path: [], next: {}, cites: [], epoch: 0 }])))).toBeNull();
    // a subtree group (set at A + clears at descendants) is many ops on DIFFERENT paths: fine
    expect(
      validateEnvelope(
        mutate(
          (e) =>
            (e.ops = [
              { kind: 'set', path: ['a'], next: {}, cites: [], epoch: 0 },
              { kind: 'clear', path: ['a', 'b'], cites: [], epoch: 0 },
            ]),
        ),
      ),
    ).toBeNull();
  });

  const cases: Array<[string, OpEnvelope, string]> = [
    ['empty origin', mutate((e) => (e.origin = '')), 'origin'],
    ['control char in origin (forged separator)', mutate((e) => (e.origin = `a${CTRL}b`)), 'origin'],
    ['empty writer', mutate((e) => (e.writer = '')), 'writer'],
    ['control char in writer', mutate((e) => (e.writer = `w${CTRL}`)), 'writer'],
    ['non-finite hlc.p', mutate((e) => (e.hlc = { p: Infinity, l: 0 })), 'hlc'],
    ['missing hlc.l', mutate((e) => (e.hlc = { p: 1 } as any)), 'hlc'],
    ['version zero', mutate((e) => (e.version = 0)), 'version'],
    ['version non-integer', mutate((e) => (e.version = 1.5)), 'version'],
    ['version negative', mutate((e) => (e.version = -3)), 'version'],
    ['ops not an array', mutate((e) => (e.ops = null as any)), 'ops'],
    ['a null op element (totality: reject, never throw)', mutate((e) => (e.ops = [null as any])), 'op'],
    ['a non-object op element', mutate((e) => (e.ops = ['nope' as any])), 'op'],
    ['unknown op kind', mutate((e) => (e.ops = [{ kind: 'weird', path: ['a'], cites: [], epoch: 0 } as any])), 'kind'],
    ['path not an array', mutate((e) => (e.ops[0] = { ...e.ops[0], path: 'a' as any })), 'path'],
    ['control char in a path segment', mutate((e) => (e.ops[0] = { ...e.ops[0], path: [`a${CTRL}`] })), 'path-control'],
    ['delete at root', mutate((e) => (e.ops = [{ kind: 'delete', path: [], prev: 0, cites: [], epoch: 0 }])), 'root-op'],
    ['clear at root', mutate((e) => (e.ops = [{ kind: 'clear', path: [], cites: [], epoch: 0 }])), 'root-op'],
    ['negative epoch', mutate((e) => (e.ops[0] = { ...e.ops[0], epoch: -1 })), 'epoch'],
    ['non-finite epoch', mutate((e) => (e.ops[0] = { ...e.ops[0], epoch: NaN })), 'epoch'],
    ['missing epoch', mutate((e) => (e.ops[0] = { kind: 'set', path: ['a'], next: 1, cites: [] } as any)), 'epoch'],
    ['cites not an array', mutate((e) => (e.ops[0] = { ...e.ops[0], cites: 'x' as any })), 'cites'],
    ['cite with empty origin', mutate((e) => (e.ops[0] = { ...e.ops[0], cites: [{ origin: '', hlc: { p: 1, l: 0 } }] })), 'cites'],
    ['cite missing hlc', mutate((e) => (e.ops[0] = { ...e.ops[0], cites: [{ origin: 'o' } as any] })), 'cites'],
    ['two ops on one path', mutate((e) => (e.ops = [
      { kind: 'set', path: ['a'], next: 1, cites: [], epoch: 0 },
      { kind: 'set', path: ['a'], next: 2, cites: [], epoch: 0 },
    ])), 'dup-path'],
  ];

  it.each(cases)('rejects: %s', (_desc, env, reason) => {
    expect(validateEnvelope(env)).toBe(reason);
  });

  it('is total and pure: same envelope → same verdict, no local state', () => {
    const bad = mutate((e) => (e.origin = ''));
    expect(validateEnvelope(bad)).toBe(validateEnvelope(bad));
    const good = valid();
    expect(validateEnvelope(good)).toBe(validateEnvelope(good));
  });

  it('is total on hostile non-envelope input: returns a reason, never throws', () => {
    // a forged/corrupt wire frame must be rejected cleanly, not crash receive
    expect(validateEnvelope(null as any)).toBe('envelope');
    expect(validateEnvelope(undefined as any)).toBe('envelope');
    expect(validateEnvelope('nope' as any)).toBe('envelope');
    expect(() => validateEnvelope({ origin: 'o', writer: 'w', version: 1, hlc: { p: 1, l: 0 }, proto: 2, policyVersion: 0, ops: [null] } as any)).not.toThrow();
  });
});

describe('opSync.receive — rejects malformed envelopes whole', () => {
  it('drops a malformed remote envelope, reports the reason, and never mutates the store', () => {
    TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string }>({ v: 'init' });
      const rejects: Array<{ origin: string; reason: string }> = [];
      const sync = opSync(s, { writer: 'w', onReject: (e, reason) => rejects.push({ origin: e.origin, reason }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      sync.receive({
        proto: OP_PROTO_VERSION,
        origin: `evil${String.fromCharCode(0x1f)}peer`,
        writer: 'w2',
        version: 1,
        hlc: { p: 9, l: 0 },
        policyVersion: 0,
        ops: [{ kind: 'set', path: ['v'], next: 'HACK', cites: [], epoch: 0 }],
      });
      expect(s()).toEqual({ v: 'init' }); // store untouched
      expect(rejects).toEqual([{ origin: `evil${String.fromCharCode(0x1f)}peer`, reason: 'origin' }]);
      warn.mockRestore();
      sync.destroy();
    });
  });
});

describe('release-review fixes', () => {
  it('rejects a __proto__ path segment at ingress and never lets it reach the object graph', () => {
    const forged = env([{ kind: 'set', path: ['__proto__'], next: { polluted: true } }], {
      writer: 'evil',
    });
    expect(validateEnvelope(forged)).toBe('path-proto');

    // even if such an op is constructed past validation, apply drops it (no prototype swap)
    const out = applyOps({ a: 1 }, [
      { kind: 'set', path: ['__proto__'], next: { polluted: true } },
    ]);
    expect(out).toEqual({ a: 1 });
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('opSync exposes prune: it reclaims settled state without changing the value', () => {
    TestBed.runInInjectionContext(() => {
      const s = signal<{ k: string }>({ k: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      // two concurrent writes to one path: the older is superseded and prunable below the frontier
      sync.receive(
        env([set(['k'], 'A')], { p: 5, writer: 'wx', origin: 'ox', version: 1 }),
      );
      sync.receive(
        env([set(['k'], 'B', 'A')], { p: 20, writer: 'wy', origin: 'oy', version: 1 }),
      );
      const before = s().k;
      sync.prune({ p: 10, l: 0 }); // frontier above the superseded 'A' write
      expect(s().k).toBe(before); // value unchanged by prune
      expect(s().k).toBe('B');
      sync.destroy();
    });
  });

  it('rejects a first-contact straggler at or below the pruned frontier (no resurrection)', () => {
    TestBed.runInInjectionContext(() => {
      const s = signal<Record<string, string>>({ k: 'live' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      sync.prune({ p: 10, l: 0 }); // frontier at p10
      // a never-seen origin's straggler BELOW the frontier: first-contact, so version dedup (no prior
      // entry) cannot catch it; the frontier gate must reject it or a settled value could resurrect
      sync.receive(
        env([set(['stale'], 'x')], { p: 5, writer: 'wz', origin: 'oz', version: 1 }),
      );
      expect(s()['stale']).toBeUndefined();
      // control: an above-frontier write from a fresh origin still lands
      sync.receive(
        env([set(['fresh'], 'y')], { p: 20, writer: 'wq', origin: 'oq', version: 1 }),
      );
      expect(s()['fresh']).toBe('y');
      sync.destroy();
    });
  });

  it('hydrate rebases from the passed pending outbox, not only the bounded recent-local ring', () => {
    TestBed.runInInjectionContext(() => {
      const s = signal<{ k: string }>({ k: 'x' });
      const sync = opSync(s, { writer: 'w', origin: 'o1' });
      // an own pending write that is NOT in recentLocal (stands in for an outbox entry beyond the
      // in-memory ring); hydrate must still rebase it on top of the incoming checkpoint root
      const pendingEnv = env([set(['k'], 'local')], {
        p: 100,
        writer: 'w',
        origin: 'o1',
        version: 5,
      });
      sync.hydrate({ root: { k: 'remote' }, registers: [], wm: {} }, [pendingEnv]);
      expect(s().k).toBe('local');
      sync.destroy();
    });
  });

  it('a checkpoint-seeded joiner materializes an orphan grandchild identically to an incremental peer', () => {
    // a set at a grandchild whose parent has no register: the incremental peer vivifies the parent
    const peer = createConvergingApply();
    const incremental = applyOps({}, peer.ingest(env([set(['b', 'x'], 1)], { writer: 'o1' })));
    expect(incremental).toEqual({ b: { x: 1 } });

    // a joiner seeded from register state alone must fold to the SAME tree (invariant: no orphan drop)
    const joiner = createConvergingApply();
    joiner.load(peer.checkpoint());
    expect(joiner.materialize()).toEqual({ b: { x: 1 } });
  });
});
