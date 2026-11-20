import { TestBed } from '@angular/core/testing';
import { createHlcClock } from './hlc';
import { type EmitContext, type StoreOp } from './op-log';
import {
  createConvergingApply,
  opSync,
  type ConvergingApply,
  type FoldFn,
  type FoldPolicyEntry,
  type OpEnvelope,
  type OpSync,
  type SyncOp,
} from './op-sync';
import { store } from './store';
import type { WritableSignalStore } from './types';

// Several emissions inside one commitScope form one branch: each later emission observes what the
// frontier covers plus what this replica emitted since the scope was entered, and nothing else. The
// reference is a shadow: a plain converging register fed exactly the covered envelopes, making the
// same writes as plain sequential ones.

type Root = {
  a?: { x?: number; y?: number } | number;
  b?: { m?: number };
  m?: number;
};
const INIT: Root = { a: { x: 0, y: 0 }, b: { m: 0 }, m: 0 };
const A = { x: 1, y: 2 };

// numeric max among the top-epoch writes; a lone sibling folds to itself
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

type Rep = {
  readonly origin: string;
  readonly s: WritableSignalStore<Root>;
  readonly sync: OpSync<Root>;
  readonly out: OpEnvelope[];
  readonly ctxs: (EmitContext | undefined)[];
  /** Every envelope this replica ingested, own and received, in ingest order. */
  readonly seen: OpEnvelope[];
};

function replica(origin: string): Rep {
  return TestBed.runInInjectionContext(() => {
    const s = store<Root>(INIT);
    const sync = opSync(s, {
      writer: 'w-' + origin,
      origin,
      clock: createHlcClock(() => 1),
      folds: FOLDS,
    }) as OpSync<Root>;
    const out: OpEnvelope[] = [];
    const ctxs: (EmitContext | undefined)[] = [];
    const seen: OpEnvelope[] = [];
    sync.subscribe((e, c) => (out.push(e), ctxs.push(c), seen.push(e)));
    return { origin, s, sync, out, ctxs, seen };
  });
}

/** A seeded room; per-origin FIFO delivery, any interleaving across origins. */
function room(n: number) {
  const reps = Array.from({ length: n }, (_, i) => replica('o' + i));
  const cursor = reps.map(() => reps.map(() => 0));
  const next = (to: number, from: number): boolean => {
    if (to === from || cursor[to][from] >= reps[from].out.length) return false;
    const env = reps[from].out[cursor[to][from]++];
    reps[to].sync.receive(env);
    reps[to].seen.push(env);
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
  return {
    reps,
    next,
    deliverAll,
    destroy: () => reps.forEach((r) => r.sync.destroy()),
  };
}

function materialized(r: Rep): unknown {
  const conv = createConvergingApply({ folds: FOLDS });
  conv.load(r.sync.snapshot().registers);
  return conv.materialize();
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
function writeAt(root: unknown, path: readonly string[], op: Raw): unknown {
  if (!path.length) return op.kind === 'set' ? op.value : root;
  const base: Record<string, unknown> = isRec(root) ? { ...root } : {};
  const [head, ...rest] = path;
  if (!rest.length) {
    if (op.kind === 'delete') delete base[head];
    else base[head] = op.value;
    return base;
  }
  base[head] = writeAt(base[head], rest, op);
  return base;
}
function lookup(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const seg of path) cur = isRec(cur) ? cur[seg] : undefined;
  return cur;
}

type Raw = {
  readonly path: readonly string[];
  readonly kind: 'set' | 'delete';
  readonly value?: unknown;
};
const set = (path: string[], next: unknown): StoreOp => ({
  kind: 'set',
  path,
  next,
});
/** A store write as an app makes it, left pending until the next flush. */
const pend = (r: Rep, raw: Raw): void =>
  r.s.set(writeAt(r.s(), raw.path, raw) as Root);
/** A store write as an app makes it: the next root, diffed and emitted on flush. */
const write = (r: Rep, raw: Raw): void => {
  pend(r, raw);
  r.sync.flush();
};

const dk = (d: { origin: string; hlc: { p: number; l: number } }): string =>
  `${d.origin}@${d.hlc.p}.${d.hlc.l}`;
const wire = (ops: readonly SyncOp[]) =>
  ops.map((op) => ({
    path: op.path.join('.'),
    kind: op.kind,
    next: op.kind === 'set' ? op.next : undefined,
    cites: op.cites.map(dk).sort(),
    epoch: op.epoch,
  }));
const brief = (env: OpEnvelope) =>
  wire(env.ops).map(({ path, kind, cites, epoch }) => ({
    path,
    kind,
    cites,
    epoch,
  }));
const last = (r: Rep): OpEnvelope => r.out[r.out.length - 1];

describe('commitScope: two emissions in one scope (the defect trace)', () => {
  const seams: Record<string, (r: Rep) => void> = {
    'emitOps twice': (r) => {
      r.sync.emitOps([set(['a', 'x'], 4)]);
      r.sync.emitOps([set(['a'], A)]);
    },
    'store write, flush, store write': (r) => {
      write(r, { kind: 'set', path: ['a', 'x'], value: 4 });
      write(r, { kind: 'set', path: ['a'], value: 5 });
      write(r, { kind: 'set', path: ['a'], value: A });
    },
  };
  for (const [name, body] of Object.entries(seams)) {
    for (const scoped of [false, true]) {
      it(`${name}, ${scoped ? 'scoped' : 'unscoped'}: every replica ends at the ancestor value`, () => {
        const x = room(2);
        const [a, b] = x.reps;
        if (scoped) a.sync.commitScope(a.sync.captureFrontier(), () => body(a));
        else body(a);
        a.sync.flush();
        x.deliverAll();
        expect({
          a: a.s().a,
          b: b.s().a,
          reg: (materialized(a) as Root).a,
        }).toEqual({ a: A, b: A, reg: A });
        x.destroy();
      });
    }
  }

  it('emitOps twice: the second envelope clears the child the first one wrote', () => {
    const x = room(2);
    const [a] = x.reps;
    a.sync.commitScope(a.sync.captureFrontier(), () => {
      a.sync.emitOps([set(['a', 'x'], 4)]);
      a.sync.emitOps([set(['a'], A)]);
    });
    const [e1, e2] = a.out.slice(-2);
    expect(brief(e2)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a.x', kind: 'clear', cites: [dk(e1)], epoch: 0 },
    ]);
    x.destroy();
  });
});

describe('commitScope: what a scope must not observe', () => {
  it('an own live write made after the frontier and before the scope is not cleared', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(a, { kind: 'set', path: ['a', 'x'], value: 7 });
    a.sync.commitScope(F, () => a.sync.emitOps([set(['a'], A)]));
    expect(brief(last(a))).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual({ x: 7, y: 2 });
    expect(materialized(a)).toEqual(a.s());
    x.destroy();
  });

  it('a store write still pending when the scope opens is emitted before entry and not cleared', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    pend(a, { kind: 'set', path: ['a', 'x'], value: 7 });
    const before = a.out.length;
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['m'], 1)]);
      a.sync.emitOps([set(['a'], A)]);
    });
    const [pending, , scoped] = a.out.slice(before);
    expect(brief(pending)).toEqual([
      { path: 'a.x', kind: 'set', cites: [], epoch: 0 },
    ]);
    expect(brief(scoped)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual({ x: 7, y: 2 });
    expect(materialized(a)).toEqual(a.s());
    x.destroy();
  });

  it('a store write the frontier covers is cleared by a later scoped ancestor set', () => {
    const x = room(2);
    const [a, b] = x.reps;
    pend(a, { kind: 'set', path: ['a', 'x'], value: 7 });
    const F = a.sync.captureFrontier();
    const covered = last(a);
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['m'], 1)]);
      a.sync.emitOps([set(['a'], A)]);
    });
    expect(brief(last(a))).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a.x', kind: 'clear', cites: [dk(covered)], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual(A);
    x.destroy();
  });

  it('a peer write that landed after the frontier stays concurrent with a later emission', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['b', 'm'], value: 9 });
    x.deliverAll();
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['m'], 1)]);
      a.sync.emitOps([set(['b', 'm'], 3)]);
    });
    expect(brief(last(a))).toEqual([
      { path: 'b.m', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().b).toEqual({ m: 9 });
    expect(materialized(a)).toEqual(a.s());
    x.destroy();
  });

  it('a peer write delivered while the scope runs is not observed', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['a', 'x'], value: 9 });
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['m'], 1)]);
      x.next(0, 1);
      a.sync.emitOps([set(['a'], A)]);
    });
    expect(brief(last(a))).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual({ x: 9, y: 2 });
    x.destroy();
  });

  it('two emissions with different bumps keep their own epochs, which one merged envelope cannot', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['b', 'm'], value: 7 });
    x.deliverAll();
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['m'], 5)], { bump: true });
      a.sync.emitOps([set(['b', 'm'], 2)]);
    });
    const [e1, e2] = a.out.slice(-2);
    expect([brief(e1), brief(e2)]).toEqual([
      [{ path: 'm', kind: 'set', cites: [], epoch: 1 }],
      [{ path: 'b.m', kind: 'set', cites: [], epoch: 0 }],
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s()).toMatchObject({ m: 5, b: { m: 7 } });
    x.destroy();
  });

  it('a single-emission scope stamps the same wire as before: covered dots only', () => {
    const x = room(3);
    const [a, b, c] = x.reps;
    write(b, { kind: 'set', path: ['a', 'x'], value: 3 });
    x.next(0, 1);
    write(a, { kind: 'set', path: ['a', 'y'], value: 1 });
    const F = a.sync.captureFrontier();
    write(c, { kind: 'set', path: ['a', 'x'], value: 9 });
    x.next(0, 2);
    write(a, { kind: 'set', path: ['m'], value: 7 });
    a.sync.commitScope(F, () => a.sync.emitOps([set(['a'], A), set(['m'], 3)]));
    const bx = dk(b.out[b.out.length - 1]);
    const ay = dk(a.out[a.out.length - 3]);
    expect(brief(last(a))).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a.x', kind: 'clear', cites: [bx], epoch: 0 },
      { path: 'a.y', kind: 'clear', cites: [ay], epoch: 0 },
      { path: 'm', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    expect(a.s()).toEqual(b.s());
    expect(c.s()).toEqual(b.s());
    // the scoped `m` replaces the own live write in this origin's one sibling slot, though uncited
    expect(a.s()).toMatchObject({ a: { x: 9, y: 2 }, m: 3 });
    x.destroy();
  });
});

describe('commitScope: nested scopes', () => {
  it('an inner scope whose frontier predates the outer emission does not observe it', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['a', 'x'], 4)]);
      a.sync.commitScope(F, () => a.sync.emitOps([set(['a'], A)]));
    });
    expect(brief(last(a))).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual({ x: 4, y: 2 });
    x.destroy();
  });

  it('an inner scope whose frontier covers the outer emission observes it', () => {
    const x = room(2);
    const [a] = x.reps;
    a.sync.commitScope(a.sync.captureFrontier(), () => {
      a.sync.emitOps([set(['a', 'x'], 4)]);
      a.sync.commitScope(a.sync.captureFrontier(), () =>
        a.sync.emitOps([set(['a'], A)]),
      );
    });
    const [e1, inner] = a.out.slice(-2);
    expect(brief(inner)[1]).toEqual({
      path: 'a.x',
      kind: 'clear',
      cites: [dk(e1)],
      epoch: 0,
    });
    x.destroy();
  });

  it('the outer scope observes what a returned inner scope emitted', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    a.sync.commitScope(F, () => {
      a.sync.commitScope(F, () => a.sync.emitOps([set(['a', 'x'], 4)]));
      a.sync.emitOps([set(['a'], A)]);
    });
    const [inner, outer] = a.out.slice(-2);
    expect(brief(outer)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a.x', kind: 'clear', cites: [dk(inner)], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual(A);
    x.destroy();
  });
});

describe('commitScope: nested scopes, after the inner one returns', () => {
  it('the outer scope still observes its own emission from before the inner scope', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['a', 'x'], 4)]);
      const e1 = last(a);
      a.sync.commitScope(a.sync.captureFrontier(), () =>
        a.sync.emitOps([set(['m'], 1)]),
      );
      a.sync.emitOps([set(['a'], A)]);
      expect(brief(last(a))).toEqual([
        { path: 'a', kind: 'set', cites: [], epoch: 0 },
        { path: 'a.x', kind: 'clear', cites: [dk(e1)], epoch: 0 },
      ]);
    });
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual(A);
    x.destroy();
  });
});

describe('commitScope: when the scope body throws', () => {
  it('the writes made before the throw are emitted against the frontier before control returns, and the error reaches the caller', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['a', 'x'], value: 9 });
    x.deliverAll();
    const peer = dk(last(b));
    const boom = new Error('boom');
    const before = a.out.length;
    let caught: unknown;
    let emitted: OpEnvelope[] = [];
    try {
      a.sync.commitScope(F, () => {
        pend(a, { kind: 'set', path: ['a', 'x'], value: 4 });
        throw boom;
      });
    } catch (e) {
      caught = e;
      emitted = a.out.slice(before);
    }
    expect(caught).toBe(boom);
    expect(emitted.map(brief)).toEqual([
      [{ path: 'a.x', kind: 'set', cites: [], epoch: 0 }],
    ]);
    const scoped = dk(emitted[0]);
    write(a, { kind: 'set', path: ['a', 'x'], value: 5 });
    expect(brief(last(a))).toEqual([
      { path: 'a.x', kind: 'set', cites: [peer, scoped].sort(), epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s().a).toEqual({ x: 5, y: 0 });
    x.destroy();
  });

  const failingFlush = (bodyThrows: boolean) => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['a', 'x'], value: 9 });
    x.deliverAll();
    const body = new Error('body');
    const flush = new Error('flush');
    let armed = true;
    const off = a.sync.subscribe(() => {
      if (armed) {
        armed = false;
        throw flush;
      }
    });
    let caught: unknown;
    try {
      a.sync.commitScope(F, () => {
        pend(a, { kind: 'set', path: ['a', 'x'], value: 4 });
        if (bodyThrows) throw body;
      });
    } catch (e) {
      caught = e;
    }
    off();
    write(a, { kind: 'set', path: ['a', 'x'], value: 5 });
    const plain = last(a).ops[0].cites.map((c) => c.origin);
    x.destroy();
    return { caught, body, flush, armed, plain };
  };

  it('a body error wins over a flush error behind it, and the frontier is still handed back', () => {
    const r = failingFlush(true);
    expect(r.armed).toBe(false);
    expect(r.caught).toBe(r.body);
    expect(r.plain).toContain('o1');
  });

  it('a flush error with no body error propagates', () => {
    const r = failingFlush(false);
    expect(r.armed).toBe(false);
    expect(r.caught).toBe(r.flush);
    expect(r.plain).toContain('o1');
  });

  it('a nested scope that throws hands the outer scope back its frontier and entry', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(b, { kind: 'set', path: ['b', 'm'], value: 9 });
    x.deliverAll();
    const boom = new Error('inner');
    let caught: unknown;
    a.sync.commitScope(F, () => {
      a.sync.emitOps([set(['a', 'x'], 4)]);
      const e1 = last(a);
      try {
        a.sync.commitScope(a.sync.captureFrontier(), () => {
          pend(a, { kind: 'set', path: ['a', 'y'], value: 7 });
          throw boom;
        });
      } catch (e) {
        caught = e;
      }
      const inner = last(a);
      expect(brief(inner)).toEqual([
        { path: 'a.y', kind: 'set', cites: [], epoch: 0 },
      ]);
      a.sync.emitOps([set(['b', 'm'], 3), set(['a'], A)]);
      expect(brief(last(a))).toEqual([
        { path: 'b.m', kind: 'set', cites: [], epoch: 0 },
        { path: 'a', kind: 'set', cites: [], epoch: 0 },
        { path: 'a.x', kind: 'clear', cites: [dk(e1)], epoch: 0 },
        { path: 'a.y', kind: 'clear', cites: [dk(inner)], epoch: 0 },
      ]);
    });
    expect(caught).toBe(boom);
    x.deliverAll();
    for (const r of [a, b]) expect(r.s()).toMatchObject({ a: A, b: { m: 9 } });
    x.destroy();
  });
});

describe('commitScope: authority across emissions', () => {
  const two = (
    first: [StoreOp, boolean],
    second: [StoreOp, boolean],
  ): { e1: OpEnvelope; e2: OpEnvelope } => {
    const x = room(1);
    const [a] = x.reps;
    a.sync.commitScope(a.sync.captureFrontier(), () => {
      a.sync.emitOps([first[0]], { bump: first[1] });
      a.sync.emitOps([second[0]], { bump: second[1] });
    });
    const [e1, e2] = a.out.slice(-2);
    expect(materialized(a)).toEqual(a.s());
    x.destroy();
    return { e1, e2 };
  };

  it('bumped then unbumped at the same path: the second cites the first and keeps its epoch', () => {
    const { e1, e2 } = two(
      [set(['a', 'x'], 4), true],
      [set(['a', 'x'], 5), false],
    );
    expect(brief(e1)).toEqual([
      { path: 'a.x', kind: 'set', cites: [], epoch: 1 },
    ]);
    expect(brief(e2)).toEqual([
      { path: 'a.x', kind: 'set', cites: [dk(e1)], epoch: 1 },
    ]);
  });

  it('bumped child then unbumped ancestor: the ancestor set is epoch 0, its clear of the child keeps 1', () => {
    const { e1, e2 } = two([set(['a', 'x'], 4), true], [set(['a'], A), false]);
    expect(brief(e2)).toEqual([
      { path: 'a', kind: 'set', cites: [], epoch: 0 },
      { path: 'a.x', kind: 'clear', cites: [dk(e1)], epoch: 1 },
    ]);
  });
});

// Today's single-emission behavior where the engine's frontier encoding differs from the shadow; the
// property counts these as skips.
describe('commitScope: pinned single-emission behavior the shadow does not share', () => {
  it('a covered dot that an uncovered write superseded is not cited and its epoch is not counted', () => {
    const x = room(3);
    const [a, b, c] = x.reps;
    b.sync.override(() =>
      write(b, { kind: 'set', path: ['a', 'x'], value: 3 }),
    );
    expect(brief(last(b))[0].epoch).toBe(1);
    x.next(0, 1);
    x.next(2, 1);
    const F = a.sync.captureFrontier();
    write(c, { kind: 'set', path: ['a', 'x'], value: 9 });
    expect(brief(last(c))[0].cites).toEqual([dk(last(b))]);
    x.next(0, 2);
    a.sync.commitScope(F, () => a.sync.emitOps([set(['a', 'x'], 5)]));
    expect(brief(last(a))).toEqual([
      { path: 'a.x', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.destroy();
  });

  it('an own bumped write made after the frontier and before entry raises the scoped epoch at that path', () => {
    const x = room(2);
    const [a] = x.reps;
    const F = a.sync.captureFrontier();
    a.sync.override(() => write(a, { kind: 'set', path: ['m'], value: 7 }));
    a.sync.commitScope(F, () => a.sync.emitOps([set(['m'], 3)]));
    expect(brief(last(a))).toEqual([
      { path: 'm', kind: 'set', cites: [], epoch: 1 },
    ]);
    x.destroy();
  });

  it('the clear-skip reads the current fold result, not the one as of the frontier', () => {
    const x = room(3);
    const [a, b, c] = x.reps;
    write(b, { kind: 'set', path: ['a', 'y'], value: 5 });
    x.deliverAll();
    b.sync.emitOps([set(['a'], { x: 1 })]);
    const bClear = dk(last(b));
    x.next(0, 1);
    const F = a.sync.captureFrontier();
    write(c, { kind: 'set', path: ['a', 'y'], value: 6 });
    x.next(0, 2);
    a.sync.commitScope(F, () => a.sync.emitOps([set(['a'], A)]));
    expect(brief(last(a)).find((op) => op.path === 'a.y')).toEqual({
      path: 'a.y',
      kind: 'clear',
      cites: [bClear],
      epoch: 0,
    });
    x.destroy();
  });

  it('a scoped op replaces the same origin unobserved live write at a path it touches', () => {
    const x = room(2);
    const [a, b] = x.reps;
    const F = a.sync.captureFrontier();
    write(a, { kind: 'set', path: ['m'], value: 7 });
    a.sync.commitScope(F, () => a.sync.emitOps([set(['m'], 3)]));
    expect(brief(last(a))).toEqual([
      { path: 'm', kind: 'set', cites: [], epoch: 0 },
    ]);
    x.deliverAll();
    for (const r of [a, b]) {
      expect(r.s().m).toBe(3);
      expect(r.sync.liveAt(['m']).map((s) => s.origin)).toEqual(['o0']);
    }
    x.destroy();
  });
});

// ---- the seeded property: S1 against a shadow, S3 and S5 -------------------------------------

const PATHS: string[][] = [
  ['a'],
  ['a', 'x'],
  ['a', 'y'],
  ['b'],
  ['b', 'm'],
  ['m'],
];
const rngOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const num = (rng: () => number): number => 1 + Math.floor(rng() * 9);
function valueFor(path: readonly string[], rng: () => number): unknown {
  const k = path.join('.');
  if (k === 'a')
    return rng() < 0.1
      ? num(rng)
      : rng() < 0.5
        ? { x: num(rng) }
        : { x: num(rng), y: num(rng) };
  if (k === 'b') return { m: num(rng) };
  return num(rng);
}
const related = (p: readonly string[]): string[][] =>
  PATHS.filter(
    (q) =>
      (p.length <= q.length && p.every((s, i) => q[i] === s)) ||
      (q.length <= p.length && q.every((s, i) => p[i] === s)),
  );

type Frame = {
  readonly conv: ConvergingApply;
  readonly parent?: Frame;
  /** Own dots emitted inside this scope, nested scopes included. */
  readonly own: Set<string>;
  gap: boolean;
};
type Violation = {
  readonly law: string;
  /** The difference is only the cites (and the clears) of own dots emitted inside the scope. */
  readonly ownScopeOnly: boolean;
  readonly msg: string;
};
type Outcome = {
  violations: Violation[];
  checked: number;
  skipped: number;
  multi: number;
};
type Opts = { readonly multi: boolean; readonly shadowAll?: boolean };

/** The shadow's ops without the cites of `own` dots, dropping clears left citing nothing. */
const withoutOwn = (ops: readonly SyncOp[], own: ReadonlySet<string>) =>
  ops
    .map((op) => ({ ...op, cites: op.cites.filter((c) => !own.has(dk(c))) }))
    .filter((op) => op.kind !== 'clear' || op.cites.length);

/**
 * One seeded run. `multi` allows scopes of several emissions and nested scopes; otherwise every
 * scope emits once. A scope whose shadow cannot match the engine's frontier encoding is skipped:
 * a covered dot no longer live (superseded or replaced in its slot after the frontier), a later
 * clear the engine already folds to, or an own write with an epoch made after the frontier.
 */
function runEngine(seed: number, opts: Opts, steps = 24): Outcome {
  const multi = opts.multi;
  const rng = rngOf(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const x = room(3);
  const caps: { F: ReturnType<OpSync['captureFrontier']>; idx: number }[][] =
    x.reps.map(() => []);
  const out: Outcome = { violations: [], checked: 0, skipped: 0, multi: 0 };
  const fail = (law: string, msg: string, ownScopeOnly = false) => {
    if (out.violations.length < 5)
      out.violations.push({ law, ownScopeOnly, msg: `${seed} ${msg}` });
  };

  const capture = (r: Rep) => {
    const F = r.sync.captureFrontier();
    return { F, idx: r.seen.length };
  };
  const shadowOf = (r: Rep, idx: number, parent?: Frame): Frame => {
    const conv = createConvergingApply({ folds: FOLDS, origin: r.origin });
    const covered = opts.shadowAll ? r.seen : r.seen.slice(0, idx);
    for (const env of covered)
      conv.ingest(env, { local: env.origin === r.origin });
    const gap = r.seen
      .slice(idx)
      .some((e) => e.origin === r.origin && e.ops.some((op) => op.epoch > 0));
    return { conv, parent, own: new Set(), gap };
  };
  const checkGap = (r: Rep, f: Frame): void => {
    for (const p of PATHS) {
      const mine = f.conv.liveAt(p);
      const mineKeys = new Set(mine.map(dk));
      const real = r.sync.liveAt(p);
      const realKeys = new Set(real.map(dk));
      if (mine.some((s) => !realKeys.has(dk(s)))) f.gap = true;
      const extra = real.filter((s) => !mineKeys.has(dk(s)));
      const top = Math.max(...mine.map((s) => s.epoch));
      const abstains =
        mine.length > 0 &&
        mine.filter((s) => s.epoch === top).every((s) => s.kind === 'clear');
      if (extra.length && (abstains || extra.some((s) => s.kind === 'clear')))
        f.gap = true;
    }
  };
  const emitIn = (r: Rep, f: Frame, prev: { p?: string[] }): void => {
    checkGap(r, f);
    const path = prev.p && rng() < 0.7 ? pick(related(prev.p)) : pick(PATHS);
    const raw: Raw =
      rng() < 0.2
        ? { kind: 'delete', path }
        : { kind: 'set', path, value: valueFor(path, rng) };
    const bump = rng() < 0.2;
    const before = r.out.length;
    if (rng() < 0.5) {
      const op: StoreOp =
        raw.kind === 'set'
          ? set([...path], raw.value)
          : { kind: 'delete', path: [...path], prev: lookup(r.s(), path) };
      r.sync.emitOps([op], { bump });
    } else if (bump) r.sync.override(() => write(r, raw));
    else write(r, raw);
    for (let i = before; i < r.out.length; i++) {
      const env = r.out[i];
      const ctx = r.ctxs[i] as EmitContext;
      if (!f.gap) {
        const shadow = f.conv.stamp(ctx.raws ?? [], { bump: ctx.bump });
        if (!deepEq(wire(shadow), wire(env.ops)))
          fail(
            'S1',
            `${dk(env)} engine ${JSON.stringify(brief(env))} shadow ${JSON.stringify(brief({ ...env, ops: shadow }))}`,
            deepEq(wire(withoutOwn(shadow, f.own)), wire(env.ops)),
          );
      }
      for (let g: Frame | undefined = f; g; g = g.parent) {
        g.conv.ingest(env, { local: true });
        g.own.add(dk(env));
      }
      prev.p = [...env.ops[0].path].map(String);
    }
  };
  const scope = (
    r: Rep,
    F: (typeof caps)[number][number],
    depth: number,
    parent?: Frame,
  ) => {
    const f = shadowOf(r, F.idx, parent);
    const prev: { p?: string[] } = {};
    const items = multi ? 1 + Math.floor(rng() * 3) : 1;
    if (multi && items > 1) out.multi++;
    r.sync.commitScope(F.F, () => {
      for (let i = 0; i < items; i++) {
        const k = rng();
        if (multi && k < 0.2) {
          const from = Math.floor(rng() * x.reps.length);
          x.next(x.reps.indexOf(r), from);
        } else if (multi && k < 0.4 && depth < 1) {
          const inner = pick([F, capture(r), ...caps[x.reps.indexOf(r)]]);
          scope(r, inner, depth + 1, f);
          continue;
        }
        emitIn(r, f, prev);
      }
    });
    if (f.gap) out.skipped++;
    else out.checked++;
  };

  for (let step = 0; step < steps; step++) {
    const ri = Math.floor(rng() * x.reps.length);
    const r = x.reps[ri];
    const roll = rng();
    if (roll < 0.25) {
      const path = pick(PATHS);
      write(r, { kind: 'set', path, value: valueFor(path, rng) });
    } else if (roll < 0.37) caps[ri].push(capture(r));
    else if (roll < 0.65) x.next(ri, Math.floor(rng() * x.reps.length));
    else {
      const F = caps[ri].length && rng() < 0.7 ? pick(caps[ri]) : capture(r);
      if (rng() < 0.3) {
        const path = pick(PATHS);
        write(r, { kind: 'set', path, value: valueFor(path, rng) });
      }
      scope(r, F, 0);
    }
    for (const q of x.reps)
      if (!deepEq(q.s(), materialized(q))) fail('S5', `${q.origin}@${step}`);
  }
  x.deliverAll();
  const fresh = createConvergingApply({ folds: FOLDS });
  for (const r of x.reps) for (const env of r.out) fresh.ingest(env);
  const want = fresh.materialize();
  for (const q of x.reps) {
    if (!deepEq(q.s(), materialized(q))) fail('S5', `${q.origin}@end`);
    if (!deepEq(q.s(), want)) fail('S3', q.origin);
  }
  x.destroy();
  return out;
}

describe('commitScope: seeded property against a shadow replica', () => {
  const SEEDS = 60;
  const sweep = (opts: Opts) => {
    const total: Outcome = { violations: [], checked: 0, skipped: 0, multi: 0 };
    for (let s = 1; s <= SEEDS; s++) {
      const o = runEngine(s * 7919, opts);
      total.violations.push(...o.violations);
      total.checked += o.checked;
      total.skipped += o.skipped;
      total.multi += o.multi;
    }
    return total;
  };

  it('single-emission scopes: each envelope equals the shadow stamp; S3 and S5 hold', () => {
    const t = sweep({ multi: false });
    expect(t.violations).toEqual([]);
    expect(t.checked).toBeGreaterThan(100);
  });

  it('control: a shadow fed every envelope, not only the covered ones, disagrees with stale scopes', () => {
    const t = sweep({ multi: false, shadowAll: true });
    expect(t.violations.filter((v) => v.law === 'S1').length).toBeGreaterThan(
      0,
    );
  });

  it('scopes of several emissions, nested scopes and mid-scope deliveries: S1, S3 and S5 hold', () => {
    const t = sweep({ multi: true });
    expect(t.violations).toEqual([]);
    expect(t.multi).toBeGreaterThan(50);
    expect(t.checked).toBeGreaterThan(100);
  });

  it('every difference from the shadow is the cite of an own dot emitted inside the scope', () => {
    const t = sweep({ multi: true });
    expect(t.violations.filter((v) => !v.ownScopeOnly)).toEqual([]);
  });

  it('the S3 and S5 comparators see registers that differ from a store', () => {
    const x = room(2);
    const [a, b] = x.reps;
    write(a, { kind: 'set', path: ['m'], value: 4 });
    expect(deepEq(a.s(), materialized(b))).toBe(false);
    expect(deepEq(b.s(), materialized(a))).toBe(false);
    x.deliverAll();
    expect(deepEq(a.s(), materialized(b))).toBe(true);
    x.destroy();
  });
});
