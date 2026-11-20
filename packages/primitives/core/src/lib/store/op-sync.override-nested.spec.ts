import { TestBed } from '@angular/core/testing';
import { createHlcClock } from './hlc';
import { opSync, type OpEnvelope, type OpSync } from './op-sync';
import { store } from './store';

type Doc = { x: number; y: number; z: number };

function replica() {
  return TestBed.runInInjectionContext(() => {
    const s = store<Doc>({ x: 0, y: 0, z: 0 });
    const sync = opSync(s, {
      writer: 'w',
      origin: 'o0',
      clock: createHlcClock(() => 1),
    }) as OpSync<Doc>;
    const out: OpEnvelope[] = [];
    sync.subscribe((e) => out.push(e));
    sync.seed();
    return { s, sync, out };
  });
}

const wire = (out: readonly OpEnvelope[]) =>
  out.map((e) => e.ops.map((o) => `${o.path.join('.')}@${o.epoch}`));

describe('opSync override: nested', () => {
  it('a nested override keeps the outer bump for the writes after it, and bumps each write once', () => {
    const { s, sync, out } = replica();
    const before = out.length;
    sync.override(() => {
      sync.override(() => s.set({ ...s(), x: 1 }));
      s.set({ ...s(), y: 1 });
    });
    s.set({ ...s(), z: 1 });
    sync.flush();
    expect(wire(out.slice(before))).toEqual([['x@1'], ['y@1'], ['z@0']]);
    sync.destroy();
  });

  it('a bumped emitOps, then a nested override, then a write: every write is bumped once', () => {
    const { s, sync, out } = replica();
    const before = out.length;
    sync.override(() => {
      sync.emitOps([{ kind: 'set', path: ['x'], next: 2, prev: 0 }], {
        bump: true,
      });
      sync.override(() => s.set({ ...s(), y: 2 }));
      s.set({ ...s(), z: 2 });
    });
    expect(wire(out.slice(before))).toEqual([['x@1'], ['y@1'], ['z@1']]);
    expect(s()).toEqual({ x: 2, y: 2, z: 2 });
    sync.destroy();
  });
});

function peer(origin: string) {
  return TestBed.runInInjectionContext(() => {
    const s = store<Doc>({ x: 0, y: 0, z: 0 });
    const sync = opSync(s, {
      writer: 'w-' + origin,
      origin,
      clock: createHlcClock(() => 1),
    }) as OpSync<Doc>;
    const out: OpEnvelope[] = [];
    sync.subscribe((e) => out.push(e));
    return { s, sync, out };
  });
}

function catching(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('opSync override: when the body throws', () => {
  it('the write made before the throw is emitted bumped before control returns, the error reaches the caller, and a later plain write is not bumped', () => {
    const { s, sync, out } = replica();
    const before = out.length;
    const boom = new Error('boom');
    let emitted: string[][] = [];
    const caught = catching(() => {
      try {
        sync.override(() => {
          s.set({ ...s(), x: 1 });
          throw boom;
        });
      } finally {
        emitted = wire(out.slice(before));
      }
    });
    expect(caught).toBe(boom);
    expect(emitted).toEqual([['x@1']]);
    s.set({ ...s(), y: 1 });
    sync.flush();
    expect(wire(out.slice(before))).toEqual([['x@1'], ['y@0']]);
    sync.destroy();
  });

  it('a throwing override inside an outer override: its write is bumped once, and the outer write after it is still bumped once', () => {
    const { s, sync, out } = replica();
    const before = out.length;
    const boom = new Error('inner');
    let caught: unknown;
    let emitted: string[][] = [];
    sync.override(() => {
      caught = catching(() =>
        sync.override(() => {
          s.set({ ...s(), x: 1 });
          throw boom;
        }),
      );
      emitted = wire(out.slice(before));
      s.set({ ...s(), y: 1 });
    });
    s.set({ ...s(), z: 1 });
    sync.flush();
    expect(caught).toBe(boom);
    expect(emitted).toEqual([['x@1']]);
    expect(wire(out.slice(before))).toEqual([['x@1'], ['y@1'], ['z@0']]);
    sync.destroy();
  });

  it('a throwing override inside a commitScope: its write is emitted bumped and stamped against the frontier', () => {
    const a = peer('o0');
    const b = peer('o1');
    a.sync.seed();
    a.out.forEach((e) => b.sync.receive(e));
    const F = a.sync.captureFrontier();
    b.s.set({ ...b.s(), x: 9 });
    b.sync.flush();
    b.out.forEach((e) => a.sync.receive(e));
    const peerWrite = b.out[b.out.length - 1];
    const boom = new Error('boom');
    const before = a.out.length;
    let caught: unknown;
    let emitted: OpEnvelope[] = [];
    a.sync.commitScope(F, () => {
      caught = catching(() =>
        a.sync.override(() => {
          a.s.set({ ...a.s(), x: 4 });
          throw boom;
        }),
      );
      emitted = a.out.slice(before);
    });
    expect(caught).toBe(boom);
    expect(wire(emitted)).toEqual([['x@1']]);
    expect(emitted[0].ops[0].cites).toEqual([]);
    expect(a.out.slice(before)).toEqual(emitted);
    a.out.slice(before).forEach((e) => b.sync.receive(e));
    a.s.set({ ...a.s(), y: 1 });
    a.sync.flush();
    expect(wire(a.out.slice(before + 1))).toEqual([['y@0']]);
    expect(peerWrite.ops[0].path).toEqual(['x']);
    for (const r of [a, b]) expect(r.s().x).toBe(4);
    a.sync.destroy();
    b.sync.destroy();
  });

  const failingFlush = (bodyThrows: boolean) => {
    const { s, sync, out } = replica();
    const before = out.length;
    const body = new Error('body');
    const flush = new Error('flush');
    let armed = true;
    const off = sync.subscribe(() => {
      if (armed) {
        armed = false;
        throw flush;
      }
    });
    let armedOnReturn = true;
    const caught = catching(() => {
      try {
        sync.override(() => {
          s.set({ ...s(), x: 1 });
          if (bodyThrows) throw body;
        });
      } finally {
        armedOnReturn = armed;
      }
    });
    off();
    s.set({ ...s(), y: 1 });
    sync.flush();
    const seen = wire(out.slice(before));
    sync.destroy();
    return { caught, body, flush, armedOnReturn, seen };
  };

  it('a body error wins over a flush error behind it, and the write is emitted bumped', () => {
    const r = failingFlush(true);
    expect(r.armedOnReturn).toBe(false);
    expect(r.caught).toBe(r.body);
    expect(r.seen).toEqual([['x@1'], ['y@0']]);
  });

  it('a flush error with no body error propagates, and a later plain write is not bumped', () => {
    const r = failingFlush(false);
    expect(r.armedOnReturn).toBe(false);
    expect(r.caught).toBe(r.flush);
    expect(r.seen).toEqual([['x@1'], ['y@0']]);
  });
});
