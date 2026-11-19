import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  applyOps,
  invertBatch,
  opLog,
  type EmitContext,
  type OpBatch,
  type StoreOp,
} from './op-log';

const op = (path: readonly unknown[], next: unknown): StoreOp =>
  ({ kind: 'set', path, next }) as unknown as StoreOp;

describe('applyOps: path segments are strings or non-negative integers', () => {
  const invalid: [string, unknown][] = [
    ['an array holding __proto__', ['__proto__']],
    ['a nested array', [['x']]],
    ['a negative index', -1],
    ['a fractional index', 1.5],
    ['NaN', Number.NaN],
    ['an object', { toString: () => 'k' }],
    ['null', null],
    ['a boolean', true],
  ];

  it.each(invalid)('ignores a set whose segment is %s', (_, seg) => {
    const root = { a: { b: 1 } };
    const polluted = { polluted: true };
    for (const path of [[seg], ['a', seg], ['missing', seg]]) {
      const out = applyOps(root, [op(path, polluted)]) as Record<
        string,
        unknown
      >;
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(out['a'])).toBe(Object.prototype);
      expect(out).toStrictEqual({ a: { b: 1 } });
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    }
  });

  it('ignores a delete whose segment is invalid', () => {
    const root = { a: { b: 1 } };
    const out = applyOps(root, [
      { kind: 'delete', path: ['a', ['b']], prev: 1 } as unknown as StoreOp,
    ]);
    expect(out).toStrictEqual({ a: { b: 1 } });
  });

  it('applies the valid ops of a batch around an invalid one', () => {
    const out = applyOps({ a: 1 } as Record<string, unknown>, [
      op(['b'], 2),
      op([['__proto__']], { polluted: true }),
      op(['list', 0], 'x'),
    ]);
    expect(out).toStrictEqual({ a: 1, b: 2, list: ['x'] });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('still applies string keys and non-negative integer indices', () => {
    expect(
      applyOps({ m: [[0, 0]] }, [op(['m', 0, 1], 5), op(['k', 'x'], 1)]),
    ).toStrictEqual({ m: [[0, 5]], k: { x: 1 } });
  });
});

describe('applyOps and invertBatch contracts', () => {
  it('vivifies a missing array for a deep write at a nonzero index without filling earlier slots', () => {
    const out = applyOps({} as Record<string, unknown>, [op(['a', 1], 'x')]);
    const a = out['a'] as unknown[];
    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBe(2);
    expect(0 in a).toBe(false);
    expect(a[1]).toBe('x');
  });

  it('skips a clear when inverting, so undoing [clear p, set p] restores p', () => {
    const inv = invertBatch([
      { kind: 'clear', path: ['a'] },
      { kind: 'set', path: ['a'], prev: 1, next: 2 },
    ]);
    expect(inv.some((o) => o.kind !== 'set')).toBe(false);
    expect(applyOps({ a: 2 }, inv)).toStrictEqual({ a: 1 });
  });
});

describe('opLog contracts', () => {
  it('defaults origin to a random non-empty id, distinct per log', () => {
    const origins = TestBed.runInInjectionContext(() =>
      [0, 1].map(() => {
        const s = signal({ v: 0 });
        const seen: string[] = [];
        const log = opLog(s);
        log.subscribe((b) => seen.push(b.origin));
        s.set({ v: 1 });
        log.flush();
        return seen[0];
      }),
    );
    for (const o of origins) {
      expect(typeof o).toBe('string');
      expect(o.length).toBeGreaterThan(0);
    }
    expect(origins[0]).not.toBe(origins[1]);
  });

  it('constructs with a random origin where crypto.randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});
    try {
      const s = signal({ v: 0 });
      const seen: string[] = [];
      const log = TestBed.runInInjectionContext(() => opLog(s));
      log.subscribe((b) => seen.push(b.origin));
      s.set({ v: 1 });
      log.flush();
      expect(typeof seen[0]).toBe('string');
      expect(seen[0].length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never mints an empty origin on the fallback, even when Math.random() returns 0', () => {
    vi.stubGlobal('crypto', {});
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const s = signal({ v: 0 });
      const seen: string[] = [];
      const log = TestBed.runInInjectionContext(() => opLog(s));
      log.subscribe((b) => seen.push(b.origin));
      s.set({ v: 1 });
      log.flush();
      expect(seen[0].length).toBeGreaterThan(0);
    } finally {
      random.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("passes the root the batch was diffed to as the subscriber's ctx.root", () => {
    const s = signal({ v: 0 });
    const got: [OpBatch, EmitContext | undefined][] = [];
    const log = TestBed.runInInjectionContext(() => opLog(s));
    log.subscribe((b, ctx) => got.push([b, ctx]));
    s.set({ v: 1 });
    const written = s();
    log.flush();
    expect(got.length).toBe(1);
    expect(got[0][1]?.root).toBe(written);
  });

  it('runs outside an injection context with an explicit injector', () => {
    const s = signal({ v: 0 });
    const log = opLog(s, { injector: TestBed.inject(Injector) });
    const seen: OpBatch[] = [];
    log.subscribe((b) => seen.push(b));
    s.set({ v: 1 });
    TestBed.tick();
    expect(seen.map((b) => b.ops)).toEqual([
      [{ kind: 'set', path: ['v'], prev: 0, next: 1 }],
    ]);
    log.destroy();
  });

  it('destroy() stops a custom driver through the handle it returned', () => {
    const stop = vi.fn();
    const log = opLog(signal({ v: 0 }), {
      driver: (run) => {
        run();
        return { destroy: stop };
      },
    });
    expect(stop).not.toHaveBeenCalled();
    log.destroy();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
