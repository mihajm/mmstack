import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { isDerivation } from './derived';
import { nestedEffect } from './effect';
import { mutable } from './mutable';
import { pipeable } from './pipeable';
import { tap } from './pipeable/operators';
import { isServer } from './platform';
import { pooled, pooledArray } from './pooled';
import { traced } from './traced';
import { createVivify } from './util';

const childEnv = () =>
  createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));

describe('nestedEffect contract', () => {
  it('a throwing cleanup is reported and the other cleanups and children still run', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const trigger = signal(0);
      const order: string[] = [];
      const boom = new Error('boom');
      TestBed.runInInjectionContext(() =>
        nestedEffect((cleanup) => {
          trigger();
          cleanup(() => {
            throw boom;
          });
          cleanup(() => order.push('second cleanup'));
          nestedEffect((c) => c(() => order.push('child cleanup')));
        }),
      );
      TestBed.tick();
      trigger.set(1);
      TestBed.tick();
      expect(order).toEqual(['second cleanup', 'child cleanup']);
      expect(err).toHaveBeenCalledWith(expect.any(String), boom);
    } finally {
      err.mockRestore();
    }
  });

  it('a child whose destroy throws is reported and later children still stop', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const trigger = signal(0);
      const stopped: string[] = [];
      TestBed.runInInjectionContext(() =>
        nestedEffect(() => {
          trigger();
          nestedEffect(() => undefined, {
            bindToFrame: (p) => {
              p?.children.add({
                destroy: () => {
                  throw new Error('child');
                },
              });
              return p;
            },
          });
          nestedEffect((c) => c(() => stopped.push('later')));
        }),
      );
      TestBed.tick();
      trigger.set(1);
      TestBed.tick();
      expect(stopped).toEqual(['later']);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('a child created during a run outside any injection context reacts', () => {
    const inner = signal(0);
    const seen: number[] = [];
    TestBed.runInInjectionContext(() =>
      nestedEffect(() => {
        nestedEffect(() => seen.push(inner()));
      }),
    );
    TestBed.tick();
    inner.set(1);
    TestBed.tick();
    expect(seen).toEqual([0, 1]);
  });

  it('a root with an explicit injector runs outside an injection context', () => {
    const spy = vi.fn();
    nestedEffect(spy, { injector: TestBed.inject(Injector) });
    TestBed.tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a manualCleanup root outlives its injector until destroyed, children included', () => {
    const env = childEnv();
    const outer = signal(0);
    const inner = signal(0);
    const seen: string[] = [];
    const ref = nestedEffect(
      () => {
        seen.push(`root ${outer()}`);
        nestedEffect(() => seen.push(`child ${inner()}`));
      },
      { injector: env, manualCleanup: true },
    );
    TestBed.tick();
    env.destroy();
    inner.set(1);
    TestBed.tick();
    expect(seen).toEqual(['root 0', 'child 0', 'child 1']);
    expect(() => ref.destroy()).not.toThrow();
    inner.set(2);
    outer.set(2);
    TestBed.tick();
    expect(seen).toHaveLength(3);
  });
});

describe('mutable equal option', () => {
  it('a custom equal suppresses an equal set, before and after a mutate', () => {
    const m = mutable(
      { id: 1, label: 'a' },
      { equal: (a, b) => a.id === b.id },
    );
    let runs = 0;
    const reader = computed(() => {
      runs++;
      return m();
    });
    reader();
    m.set({ id: 1, label: 'b' });
    reader();
    expect(runs).toBe(1);
    m.mutate((v) => ((v.label = 'c'), v));
    reader();
    expect(runs).toBe(2);
    m.set({ id: 1, label: 'd' });
    reader();
    expect(runs).toBe(2);
    m.set({ id: 2, label: 'e' });
    reader();
    expect(runs).toBe(3);
  });

  it('the default equal skips a set of the same reference', () => {
    const value = { n: 1 };
    const m = mutable(value);
    let runs = 0;
    const reader = computed(() => (runs++, m()));
    reader();
    m.set(value);
    reader();
    expect(runs).toBe(1);
  });
});

describe('pipeable options', () => {
  it.each([
    [
      'one step',
      (s: any) => s.map((n: number) => n % 2, { equal: () => true }),
    ],
    [
      'two steps',
      (s: any) =>
        s.map(
          (n: number) => n + 1,
          (n: number) => n % 2,
          { equal: () => true },
        ),
    ],
  ])('map(%s, opt) composes and honors equal', (_, build) => {
    const src = pipeable(signal(1));
    const mapped = build(src);
    let runs = 0;
    const reader = computed(() => (runs++, mapped()));
    expect(reader()).toBe(_ === 'one step' ? 1 : 0);
    src.set(2);
    reader();
    expect(runs).toBe(1);
  });

  it('map(f1, f2, opt) applies both steps in order', () => {
    const src = pipeable(signal(3));
    const mapped = src.map(
      (n: number) => n * 2,
      (n: number) => `#${n}`,
      { equal: Object.is },
    );
    expect(mapped()).toBe('#6');
  });

  it('tap(fn, injector) runs outside an injection context', () => {
    const spy = vi.fn();
    const src = pipeable(signal(1));
    src.pipe(tap(spy, TestBed.inject(Injector)));
    TestBed.tick();
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe('isServer in an injection context without a platform', () => {
  it('counts as not the server and does not throw', () => {
    const bare = Injector.create({ providers: [] });
    expect(runInInjectionContext(bare, () => isServer())).toBe(false);
  });
});

describe('pooled contract', () => {
  it('eager: consecutive reads return different identities and notify readers', () => {
    const src = signal(1);
    const p = pooled<{ n: number }>({
      create: () => ({ n: 0 }),
      reset: (c) => {
        c.n = 0;
      },
      computation: (c) => ((c.n = src()), c),
      eager: true,
    });
    let runs = 0;
    const reader = computed(() => (runs++, p().n));
    const first = p();
    expect(reader()).toBe(1);
    src.set(2);
    const second = p();
    expect(second).not.toBe(first);
    expect(reader()).toBe(2);
    src.set(3);
    expect(p()).not.toBe(second);
    expect(reader()).toBe(3);
    expect(runs).toBe(3);
  });

  it('pooledArray(fn, opt) honors the signal options', () => {
    const src = signal([1, 2]);
    const p = pooledArray<number[]>(
      (buf) => (buf.push(...src()), buf),
      // the previous buffer is already recycled when equal runs, so judge by the new one only
      { equal: () => true },
    );
    let runs = 0;
    const reader = computed(() => (runs++, p().length));
    reader();
    src.set([3, 4]);
    reader();
    expect(runs).toBe(1);
  });
});

describe('traced', () => {
  it('the twin of a plain signal is not a derivation', () => {
    expect(isDerivation(traced(signal(0), () => undefined) as any)).toBe(false);
  });
});

describe('vivify boundary keys', () => {
  it.each(['', ' '])("'auto' treats %j as a named key", (key) => {
    expect(createVivify('auto')(null, key)).toEqual({});
    expect(Array.isArray(createVivify('auto')(null, key))).toBe(false);
  });

  it("'auto' keeps a present value", () => {
    const present = { a: 1 };
    expect(createVivify('auto')(present, 'k')).toBe(present);
  });

  it("'object' makes an object for an index key", () => {
    const made = createVivify<object | null>('object')(null, '0');
    expect(Array.isArray(made)).toBe(false);
    expect(made).toEqual({});
  });

  it('a factory seeds an undefined source too', () => {
    const seed = { seeded: true };
    expect(
      createVivify<typeof seed | undefined>(() => seed)(undefined, 'k'),
    ).toBe(seed);
  });
});
