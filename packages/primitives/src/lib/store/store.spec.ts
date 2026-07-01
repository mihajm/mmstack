import { computed, effect, Injector, isSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  isStore,
  PROXY_CACHE_TOKEN,
  PROXY_CLEANUP_TOKEN,
  STORE_SHARED_GLOBALS,
  STORE_SHARED_OPTIONS,
} from './internals';
import { isLeaf } from './leaf';
import { isOpaque, OPAQUE, opaque } from './opaque';
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

  describe('array <-> record union flips (route-forward)', () => {
    it('a record node flips to an array and routes as an array afterwards', () => {
      const s = store(
        { v: { x: 1 } as Record<string, number> | number[] },
        { injector },
      );
      expect((s.v as any).x()).toBe(1);

      s.v.set([10, 20]);

      expect(s.v()).toEqual([10, 20]);
      expect((s.v as any).length()).toBe(2);
      expect((s.v as any)[0]()).toBe(10);
      expect((s.v as any)[1]()).toBe(20);

      const collected: number[] = [];
      for (const el of s.v as any) collected.push(el());
      expect(collected).toEqual([10, 20]);

      expect(Object.getPrototypeOf(s.v)).toBe(Array.prototype);
      expect(Object.keys(s.v)).toEqual(['0', '1', 'length']);
    });

    it('an array node flips to a record and routes as a record afterwards', () => {
      const s = store(
        { v: [1, 2] as number[] | Record<string, number> },
        { injector },
      );
      expect((s.v as any).length()).toBe(2);
      expect((s.v as any)[0]()).toBe(1);

      s.v.set({ a: 9 });

      expect(s.v()).toEqual({ a: 9 });
      expect((s.v as any).a()).toBe(9);
      expect(Object.getPrototypeOf(s.v)).toBe(Object.prototype);
      expect(Object.keys(s.v)).toEqual(['a']);
    });

    it('tracks the kind flip reactively inside a computed', () => {
      const s = store(
        { v: { x: 1 } as Record<string, number> | number[] },
        { injector },
      );
      const kind = computed(() => (Array.isArray(s.v()) ? 'array' : 'record'));

      expect(kind()).toBe('record');
      s.v.set([1]);
      expect(kind()).toBe('array');
    });
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

  describe('shared options (STORE_SHARED_OPTIONS) + shared globals', () => {
    it('exposes its resolved options via the symbol, with the injector-scoped cache/registry', () => {
      const s = store(
        { a: 1 },
        { injector, vivify: 'auto', noUnionLeaves: true },
      );
      const opts = (s as any)[STORE_SHARED_OPTIONS];
      expect(opts.injector).toBe(injector);
      expect(opts.vivify).toBe('auto');
      expect(opts.noUnionLeaves).toBe(true);
      // the cache + registry are the injector-scoped singletons (not module globals)
      expect(opts[STORE_SHARED_GLOBALS].cache).toBe(
        injector.get(PROXY_CACHE_TOKEN),
      );
      expect(opts[STORE_SHARED_GLOBALS].registry).toBe(
        injector.get(PROXY_CLEANUP_TOKEN),
      );
    });

    it('defaults vivify/noUnionLeaves to false when unset', () => {
      const opts = (store({ a: 1 }, { injector }) as any)[STORE_SHARED_OPTIONS];
      expect(opts.vivify).toBe(false);
      expect(opts.noUnionLeaves).toBe(false);
    });

    it('child nodes inherit the parent shared globals (one cache/registry for the whole tree)', () => {
      const s = store({ a: { b: 1 } }, { injector });
      const root = (s as any)[STORE_SHARED_OPTIONS][STORE_SHARED_GLOBALS];
      const child = (s.a as any)[STORE_SHARED_OPTIONS][STORE_SHARED_GLOBALS];
      expect(child.cache).toBe(root.cache);
      expect(child.registry).toBe(root.registry);
    });
  });

  describe('opaque', () => {
    it('treats an opaque object as a leaf, not a child store', () => {
      const inner = opaque({ a: 1, b: 2 });
      const s = store({ config: inner }, { injector });

      expect(isSignal(s.config)).toBe(true);
      expect(s.config()).toEqual({ a: 1, b: 2 });
      // returned whole — same identity, never re-proxied/cloned
      expect(s.config()).toBe(inner);
    });

    it('deep-proxies a non-opaque sibling but not the opaque one', () => {
      const s = store(
        { plain: { a: 1 }, blob: opaque({ a: 1 }) },
        { injector },
      );
      // plain object descends to a child store (set on a nested signal)
      s.plain.a.set(9);
      expect(s().plain.a).toBe(9);
      // opaque object has no child-store key reachable for descent
      expect(s.blob()).toEqual({ a: 1 });
    });

    it('replaces the whole value via set', () => {
      const s = store({ config: opaque({ a: 1 }) }, { injector });
      s.config.set(opaque({ a: 9 }));
      expect(s.config()).toEqual({ a: 9 });
      expect(s().config).toEqual({ a: 9 });
    });

    it('keeps the brand non-enumerable', () => {
      const o = opaque({ a: 1, b: 2 });
      expect(Object.keys(o)).toEqual(['a', 'b']);
      expect({ ...o }).toEqual({ a: 1, b: 2 });
      expect(Object.getOwnPropertyDescriptor(o, OPAQUE)?.enumerable).toBe(
        false,
      );
    });

    it('is idempotent', () => {
      const o = { a: 1 };
      const once = opaque(o);
      expect(() => opaque(once)).not.toThrow();
      expect(opaque(once)).toBe(o);
      expect(Object.keys(o)).toEqual(['a']);
    });

    it('isOpaque identifies opaque objects', () => {
      const o = opaque({ a: 1 });
      expect(OPAQUE in o).toBe(true);
      expect(isOpaque(o)).toBe(true);
      expect(isOpaque({})).toBe(false);
    });
  });

  describe('isLeaf', () => {
    it('primitives are leaves; substores are not (but stay stores)', () => {
      const s = store({ name: 'Ada', user: { city: 'London' } }, { injector });
      expect(isLeaf(s.name)).toBe(true);
      expect(isLeaf(s.user)).toBe(false);
      expect(isStore(s.user)).toBe(true);
    });

    it('marks nested leaves', () => {
      const s = store({ user: { name: 'Ada', age: 36 } }, { injector });
      expect(isLeaf(s.user.name)).toBe(true);
      expect(isLeaf(s.user.age)).toBe(true);
    });

    it('arrays are not leaves; primitive elements are, object elements are not', () => {
      const s = store({ nums: [1, 2, 3], objs: [{ id: 1 }] }, { injector });
      expect(isLeaf(s.nums)).toBe(false);
      expect(isLeaf(s.nums[0])).toBe(true);
      expect(isLeaf(s.objs[0])).toBe(false);
    });

    it('treats Date, RegExp and opaque objects as leaves', () => {
      const s = store(
        { d: new Date(), r: /x/, c: opaque({ a: 1 }) },
        { injector },
      );
      expect(isLeaf(s.d)).toBe(true);
      expect(isLeaf(s.r)).toBe(true);
      expect(isLeaf(s.c)).toBe(true);
    });

    it('opaque wins over arrays — an opaque array is a whole leaf, not an array store', () => {
      const arr = opaque([1, 2, 3]);
      const s = store({ tags: arr }, { injector });
      expect(isLeaf(s.tags)).toBe(true);
      expect(s.tags()).toBe(arr); // returned whole
      expect(Object.keys(s.tags)).toEqual([]); // not enumerated as an array store
    });

    it('null/undefined is a leaf only when vivification is off', () => {
      const off = store({ a: null as number | null }, { injector });
      expect(isLeaf(off.a)).toBe(true);

      const on = store(
        { a: null as { b: number } | null },
        { injector, vivify: true },
      );
      expect(isLeaf(on.a)).toBe(false);
    });

    it('tracks leaf-ness reactively as the value shape changes', () => {
      const s = store({ a: 5 as number | { x: number } }, { injector });
      expect(isLeaf(s.a)).toBe(true);
      s.a.set({ x: 1 });
      expect(isLeaf(s.a)).toBe(false);
      s.a.set(7);
      expect(isLeaf(s.a)).toBe(true);
    });

    it('treats bigint as a leaf', () => {
      const s = store({ n: 10n }, { injector });
      expect(isLeaf(s.n)).toBe(true);
    });

    it('noUnionLeaves resolves leaf-ness once (constant, no reactive switching)', () => {
      const s = store(
        { a: 5 as number | { x: number } },
        { injector, noUnionLeaves: true },
      );
      expect(isLeaf(s.a)).toBe(true);
      s.a.set({ x: 1 });
      // resolved once on the first probe and cached — keeps its first answer
      expect(isLeaf(s.a)).toBe(true);
    });

    it('preserves leaf behavior — read, write, stable ref (Option A)', () => {
      const s = store({ name: 'Ada' }, { injector });
      expect(s.name()).toBe('Ada');
      s.name.set('Grace');
      expect(s.name()).toBe('Grace');
      expect(s.name).toBe(s.name);
    });

    it('returns false for non-store values', () => {
      expect(isLeaf(5)).toBe(false);
      expect(isLeaf({})).toBe(false);
      expect(isLeaf(null)).toBe(false);
      expect(isLeaf(undefined)).toBe(false);
    });
  });

  describe('array element writes (copy-on-write)', () => {
    it('element set updates the element signal itself (immutable store)', () => {
      const src = { a: [1, 2, 3] };
      const s = store(src, { injector });
      expect(s.a[0]()).toBe(1);

      s.a[0].set(9);

      expect(s.a[0]()).toBe(9);
      expect(s().a).toEqual([9, 2, 3]);
      // copy-on-write: the caller's original array must not be mutated
      expect(src.a).toEqual([1, 2, 3]);
      expect(s().a).not.toBe(src.a);
    });

    it('element set notifies effects on the array node (immutable store)', () => {
      const s = store({ a: [1, 2, 3] }, { injector });
      let runs = 0;
      effect(
        () => {
          s.a();
          runs++;
        },
        { injector },
      );
      TestBed.tick();
      runs = 0;

      s.a[1].set(20);
      TestBed.tick();
      expect(runs).toBe(1);
      expect(s.a()).toEqual([1, 20, 3]);
    });

    it('nested object-in-array writes propagate both ways (immutable store)', () => {
      const s = store({ a: [{ id: 1 }, { id: 2 }] }, { injector });
      expect(s.a[0].id()).toBe(1);

      s.a[0].id.set(10);

      expect(s.a[0].id()).toBe(10);
      expect(s.a[0]()).toEqual({ id: 10 });
      expect(s().a).toEqual([{ id: 10 }, { id: 2 }]);
    });

    it('element set updates the element signal itself (mutable store)', () => {
      const src = { a: [1, 2, 3] };
      const s = mutableStore(src, { injector });
      expect(s.a[0]()).toBe(1);

      s.a[0].set(9);

      expect(s.a[0]()).toBe(9);
      expect(s().a).toEqual([9, 2, 3]);
      // mutable stores update in place by design
      expect(s().a).toBe(src.a);
    });

    it('element set notifies effects on the array node (mutable store)', () => {
      const s = mutableStore({ a: [1, 2, 3] }, { injector });
      let runs = 0;
      effect(
        () => {
          s.a();
          runs++;
        },
        { injector },
      );
      TestBed.tick();
      runs = 0;

      s.a[1].set(20);
      TestBed.tick();
      expect(runs).toBe(1);
      expect(s.a()).toEqual([1, 20, 3]);
    });
  });
});
