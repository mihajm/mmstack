import { Injector, isSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  PROXY_CACHE,
  PROXY_CLEANUP,
  mutableStore,
  store,
  toStore,
} from './store';

/** Simulate the GC reclaiming a cached child proxy: its WeakRef now derefs to undefined. */
function simulateCollected(target: object, prop: PropertyKey): void {
  PROXY_CACHE.get(target)?.set(prop, {
    deref: () => undefined,
  } as WeakRef<never>);
}

describe('store vivification (deep / e2e)', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  describe('off by default', () => {
    it('drops a deep write through null when vivify is unset', () => {
      const s = store({ a: null as { b: number } | null }, { injector });
      s.a.b.set(2);
      expect(s().a).toBeNull();
    });

    it('drops a deep write through null when vivify is explicitly false', () => {
      const s = store(
        { a: null as { b: number } | null },
        { injector, vivify: false },
      );
      s.a.b.set(2);
      expect(s().a).toBeNull();
    });

    it('reads through a null path without throwing', () => {
      const s = store({ a: null as { b: number } | null }, { injector });
      expect(s.a.b()).toBeUndefined();
    });
  });

  describe('shape resolution for unknown (null) levels', () => {
    it('creates an object for a named key (auto)', () => {
      const s = store(
        { a: null as { b: number } | null },
        { injector, vivify: 'auto' },
      );
      s.a.b.set(2);
      expect(s()).toEqual({ a: { b: 2 } });
    });

    it('creates a real array for an index key (auto)', () => {
      const s = store(
        { a: null as number[] | null },
        { injector, vivify: 'auto' },
      );
      s.a[0].set(5);
      expect(Array.isArray(s().a)).toBe(true);
      expect(s()).toEqual({ a: [5] });
    });

    it('treats true the same as auto', () => {
      const s = store(
        { a: null as { b: number } | null },
        { injector, vivify: true },
      );
      s.a.b.set(2);
      expect(s()).toEqual({ a: { b: 2 } });
    });

    it('an explicit object option still creates objects for named keys', () => {
      const s = store(
        { a: null as Record<string, number> | null },
        { injector, vivify: 'object' },
      );
      s.a['x'].set(5);
      expect(s()).toEqual({ a: { x: 5 } });
    });
  });

  describe('depth', () => {
    it('vivifies a three-level object chain through undefined', () => {
      const s = store({} as { a?: { b?: { c?: { d: number } } } }, {
        injector,
        vivify: 'auto',
      });
      s.a.b.c.d.set(4);
      expect(s()).toEqual({ a: { b: { c: { d: 4 } } } });
    });

    it('vivifies a mixed object → array → object path', () => {
      const s = store(
        { a: null as { list: { x: number }[] } | null },
        { injector, vivify: 'auto' },
      );
      s.a.list[0].x.set(7);
      expect(s()).toEqual({ a: { list: [{ x: 7 }] } });
    });
  });

  describe('known-shape baking (survives nulling)', () => {
    it('re-creates a nulled object node as an object', () => {
      const s = store(
        { a: { b: 1 } as { b: number } | null },
        {
          injector,
          vivify: 'auto',
        },
      );
      expect(s.a.b()).toBe(1); // establish derivations while `a` is an object
      s.a.set(null);
      expect(s().a).toBeNull();
      s.a.b.set(2);
      expect(s()).toEqual({ a: { b: 2 } });
    });

    it('re-creates a nulled array node as a real array', () => {
      const s = store(
        { a: [1, 2, 3] as number[] | null },
        {
          injector,
          vivify: 'auto',
        },
      );
      expect(s.a[0]()).toBe(1);
      s.a.set(null);
      s.a[0].set(9);
      expect(Array.isArray(s().a)).toBe(true);
      expect(s().a).toEqual([9]);
    });

    it('keeps an array element an object after the element is nulled', () => {
      const s = store(
        { list: [{ x: 1 }] as ({ x: number } | null)[] },
        { injector, vivify: 'auto' },
      );
      expect(s.list[0].x()).toBe(1); // element established as an object
      s.list[0].set(null);
      s.list[0].x.set(5);
      expect(s().list[0]).toEqual({ x: 5 });
    });

    it('re-creates a nulled array property (inside an object) as an array', () => {
      const s = store(
        { a: { tags: ['x'] } as { tags: string[] } | null },
        { injector, vivify: 'auto' },
      );
      expect(s.a.tags[0]()).toBe('x');
      s.a.set(null);
      s.a.tags[0].set('y');
      expect(s().a).toEqual({ tags: ['y'] });
      expect(Array.isArray(s().a?.tags)).toBe(true);
    });
  });

  describe('mutableStore', () => {
    it('vivifies in place (root reference preserved)', () => {
      const src = { a: null as { b: number } | null };
      const s = mutableStore(src, { injector, vivify: 'auto' });
      s.a.b.set(2);
      expect(s()).toBe(src);
      expect(src.a).toEqual({ b: 2 });
    });

    it('vivifies a deep mutable chain in place', () => {
      const src = {} as { a?: { b?: { c: number } } };
      const s = mutableStore(src, { injector, vivify: 'auto' });
      s.a.b.c.set(3);
      expect(s()).toBe(src);
      expect(src).toEqual({ a: { b: { c: 3 } } });
    });
  });

  describe('reads & readonly', () => {
    it('reads deeply through nulls without throwing', () => {
      const s = store(
        { a: null as { b: { c: number } } | null },
        { injector, vivify: 'auto' },
      );
      expect(s.a.b.c()).toBeUndefined();
    });

    it('asReadonlyStore: writes are a no-op even with vivify on', () => {
      const s = store(
        { a: null as { b: number } | null },
        { injector, vivify: 'auto' },
      );
      const ro = s.asReadonlyStore();
      (ro.a.b as unknown as { set: (v: number) => void }).set(2);
      expect(s().a).toBeNull();
    });
  });

  describe('reconstruction (cache eviction is deterministic via PROXY_CACHE)', () => {
    it('rebuilds a child proxy after its cached WeakRef is cleared', () => {
      const sig = signal({ a: { b: 1 } });
      const s = toStore(sig, injector);
      const first = s.a;
      expect(first.b()).toBe(1);

      simulateCollected(sig, 'a'); // WeakRef now derefs to undefined

      const rebuilt = s.a;
      expect(rebuilt).not.toBe(first); // a fresh proxy
      expect(isSignal(rebuilt.b)).toBe(true);
      expect(rebuilt.b()).toBe(1); // still functional
    });

    it('rebuilds after the finalization registry prunes the cache entry', () => {
      const sig = signal({ a: { b: 1 } });
      const s = toStore(sig, injector);
      const first = s.a;

      PROXY_CACHE.get(sig)?.delete('a'); // simulate the finalizer callback

      const rebuilt = s.a;
      expect(rebuilt).not.toBe(first);
      expect(rebuilt.b()).toBe(1);
    });

    it('unregisters the stale finalizer when rebuilding over a dead WeakRef', () => {
      const sig = signal({ a: { b: 1 } });
      const s = toStore(sig, injector);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      s.a; // build + register the finalizer
      const deadRef = { deref: () => undefined } as WeakRef<never>;
      PROXY_CACHE.get(sig)?.set('a', deadRef);

      const spy = vi.spyOn(PROXY_CLEANUP, 'unregister');
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      s.a; // rebuild path must unregister the stale token
      expect(spy).toHaveBeenCalledWith(deadRef);
      spy.mockRestore();
    });

    it('rebuilds from scratch via auto after the value is nulled and the proxy is cleared', () => {
      const sig = signal({ a: { b: 1 } as { b: number } | null });
      const s = toStore(sig, injector, 'auto');
      expect(s.a.b()).toBe(1); // build while `a` is a record
      s.a.set(null); // `a` is now null — no live shape knowledge remains
      expect(sig().a).toBeNull();

      simulateCollected(sig, 'a'); // drop the cached proxy

      // Re-access rebuilds from scratch; with `a` null, the shape is resolved via auto.
      s.a.b.set(2);
      expect(sig().a).toEqual({ b: 2 });
    });

    it('rebuilds a vivified array path from scratch via auto', () => {
      const sig = signal({ a: [1] as number[] | null });
      const s = toStore(sig, injector, 'auto');
      expect(s.a[0]()).toBe(1);
      s.a.set(null);

      simulateCollected(sig, 'a');

      s.a[0].set(9);
      expect(Array.isArray(sig().a)).toBe(true);
      expect(sig().a).toEqual([9]);
    });
  });
});
