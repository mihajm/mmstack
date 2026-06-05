import { Injector, isSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutableStore, store } from './store';

describe('store', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('should create a store', () => {
    const src = { a: 1 };
    const s = store(src, {
      injector,
    });
    expect(s).toBeDefined();
    expect(s()).toBe(src);
  });

  it('should support deep reactivity', () => {
    const src = { a: { b: 1 } };
    const s = store(src, { injector });
    expect(s().a.b).toBe(1);
    s.a.b.set(2);
    expect(s().a.b).toBe(2);
    expect(s()).not.toBe(src);
    expect(s()).toEqual({ a: { b: 2 } });
  });

  it('should support mutable reactivity', () => {
    const src = { a: { b: 1 } };
    const s = mutableStore(src, {
      injector,
    });
    expect(s().a.b).toBe(1);
    s.a.b.set(2);
    expect(s().a.b).toBe(2);
    expect(s()).toBe(src);
    expect(s()).toEqual({ a: { b: 2 } });
  });

  it('should return signals', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    expect(s.a).toBeDefined();
    expect(isSignal(s.a)).toBe(true);
  });

  it('should support key iteration', () => {
    const src = { a: 1, b: 2 };
    const s = store(src, { injector });
    const keys = Object.keys(s);
    expect(keys).toEqual(['a', 'b']);
  });

  it('should support key in object', () => {
    const src = { a: 1, b: 2 };
    const s = store(src, { injector });
    expect('a' in s).toBe(true);
    expect('c' in s).toBe(false);
  });

  it('should suport getOwnPropertyDescriptor', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const descriptor = Object.getOwnPropertyDescriptor(s, 'a');
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.configurable).toBe(true);
  });

  it('should return stable computations', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const a1 = s.a;
    const a2 = s.a;
    expect(a1).toBe(a2);
  });

  it('should return a new readonly store when asReadonlyStore is called', () => {
    const src = { a: 1 };
    const s = store(src, { injector });
    const readonly = s.asReadonlyStore();
    expect(readonly).not.toBe(s);

    // setter exists but is noop
    (readonly.a as any).set(2);
    expect(readonly.a()).toBe(1);
  });

  it('should support arrays as leaves, array access', () => {
    const src = { a: [1, 2, 3] };
    const s = store(src, { injector });
    expect(s().a).toEqual([1, 2, 3]);
    s.a.set([1, 2, 3, 4]);
    expect(s().a).toEqual([1, 2, 3, 4]);
  });

  it('should support deep array signals', () => {
    const src = { a: [{ id: 1 }, { id: 2 }] };
    const s = store(src, { injector });

    // Access index signal
    const first = s.a[0];
    expect(isSignal(first)).toBe(true);
    expect(first()).toEqual({ id: 1 });

    // Access nested property signal
    expect(s.a[0].id()).toBe(1);

    // Reactivity
    s.a.update((arr) => [...arr, { id: 3 }]);
    expect(s.a[2].id()).toBe(3);
  });

  it('should support array iteration', () => {
    const src = { a: [1, 2, 3] };

    const s = store(src, { injector });

    let i = 0;
    for (const val of s.a) {
      expect(isSignal(val)).toBe(true);
      expect(val()).toBe(src.a[i++]);
    }
  });

  describe('dynamic property creation', () => {
    it('adds a property that did not exist on the object', () => {
      const s = store({} as { a?: number }, { injector });
      expect(isSignal(s.a)).toBe(true);
      expect(s.a()).toBeUndefined();
      s.a.set(5);
      expect(s()).toEqual({ a: 5 });
      expect(s.a()).toBe(5);
    });

    it('the newly created subsignal is reactive', () => {
      const s = store({} as Record<string, number>, { injector });
      s['x'].set(1);
      expect(s['x']()).toBe(1);
      s['x'].set(2);
      expect(s['x']()).toBe(2);
    });

    it('adds a nested property to an existing (empty) object', () => {
      const s = store({ a: {} as Record<string, number> }, { injector });
      s.a['x'].set(5);
      expect(s().a).toEqual({ x: 5 });
      expect(s.a['x']()).toBe(5);
    });

    it('mutableStore adds a new property in place', () => {
      const src = {} as { a?: number };
      const s = mutableStore(src, { injector });
      s.a.set(5);
      expect(s()).toBe(src);
      expect(src).toEqual({ a: 5 });
    });

    it('a newly added key shows up in ownKeys', () => {
      const s = store({} as Record<string, number>, { injector });
      s['a'].set(1);
      expect(Object.keys(s)).toContain('a');
    });
  });

  describe('vivify', () => {
    it('is off by default — a deep write through null is dropped', () => {
      const s = store({ a: null as { b: number } | null }, { injector });
      s.a.b.set(2);
      expect(s().a).toBeNull();
    });

    it('reads through a null path without throwing', () => {
      const s = store({ a: null as { b: number } | null }, { injector });
      expect(s.a.b()).toBeUndefined();
    });

    it("creates a missing object with vivify: 'auto'", () => {
      const s = store(
        { a: null as { b: number } | null },
        { injector, vivify: 'auto' },
      );
      s.a.b.set(2);
      expect(s()).toEqual({ a: { b: 2 } });
    });

    it("creates nested containers through undefined with vivify: 'auto'", () => {
      const s = store({} as { a?: { b?: { c: number } } }, {
        injector,
        vivify: 'auto',
      });
      s.a.b.c.set(3);
      expect(s()).toEqual({ a: { b: { c: 3 } } });
    });

    it("creates an array for a numeric key with vivify: 'auto'", () => {
      const s = store(
        { a: null as number[] | null },
        { injector, vivify: 'auto' },
      );
      s.a[0].set(5);
      expect(Array.isArray(s().a)).toBe(true);
      expect(s().a).toEqual([5]);
    });

    it('vivifies a mutableStore in place (root reference preserved)', () => {
      const src = { a: null as { b: number } | null };
      const s = mutableStore(src, { injector, vivify: 'auto' });
      s.a.b.set(2);
      expect(s()).toBe(src);
      expect(src.a).toEqual({ b: 2 });
    });

    it("uses the option for genuinely-unknown levels (vivify: 'object')", () => {
      const s = store(
        { a: null as Record<string, number> | null },
        { injector, vivify: 'object' },
      );
      s.a['x'].set(5);
      expect(s().a).toEqual({ x: 5 });
    });

    it('re-creates a nulled object node as an object (known shape is cached)', () => {
      const s = store(
        { a: { b: 1 } as { b: number } | null },
        { injector, vivify: 'auto' },
      );
      expect(s.a.b()).toBe(1); // establish the derivation while `a` is an object
      s.a.set(null);
      expect(s().a).toBeNull();
      s.a.b.set(2); // write through the now-null path
      expect(s().a).toEqual({ b: 2 });
    });

    it("honours a known array shape even when the option is 'object'", () => {
      const s = store(
        { a: [1, 2, 3] as number[] | null },
        { injector, vivify: 'object' },
      );
      expect(s.a[0]()).toBe(1); // establish array derivations while `a` is an array
      s.a.set(null);
      s.a[0].set(9);
      expect(Array.isArray(s().a)).toBe(true);
      expect(s().a).toEqual([9]);
    });
  });

  describe('proxy cache / cleanup', () => {
    it('returns a stable proxy for nested paths', () => {
      const s = store({ a: { b: 1 } }, { injector });
      expect(s.a).toBe(s.a);
      expect(s.a.b).toBe(s.a.b);
    });

    it('does not share cached child proxies across independent stores', () => {
      const s1 = store({ a: 1 }, { injector });
      const s2 = store({ a: 1 }, { injector });
      expect(s1.a).not.toBe(s2.a);
    });
  });
});
