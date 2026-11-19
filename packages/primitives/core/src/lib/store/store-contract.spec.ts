import { computed, effect, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { derived } from '../derived';
import { isMutable } from '../mutable';
import { createTransaction } from '../concurrent/transaction';
import { forkStore } from './fork-store';
import { isStore, isStoreReservedKey } from './internals';
import { isLeaf } from './leaf';
import { optimisticStore } from './optimistic-store';
import { extendStore, mutableStore, store, toStore } from './store';

describe('store contract', () => {
  let injector: Injector;

  beforeEach(() => {
    injector = TestBed.inject(Injector);
  });

  describe('isMutable over store nodes', () => {
    it('is true for a mutable store root and its child nodes', () => {
      const m = mutableStore({ user: { name: 'a' }, n: 1 }, { injector });
      expect(isMutable(m)).toBe(true);
      expect(isMutable(m.user)).toBe(true);
      expect(isMutable(m.n)).toBe(true);
    });

    it('is false for writable and readonly store nodes, even with a `mutate` data key', () => {
      const s = store({ mutate: 1, user: { name: 'a' } }, { injector });
      expect(isMutable(s)).toBe(false);
      expect(isMutable(s.user)).toBe(false);
      expect(isMutable(s.asReadonlyStore() as any)).toBe(false);
    });

    it('`in` reports the signal methods a node answers', () => {
      const m = mutableStore({ user: { name: 'a' } }, { injector });
      const s = store({ user: { name: 'a' } }, { injector });
      expect('mutate' in m.user).toBe(true);
      expect('inline' in m.user).toBe(true);
      expect('set' in s.user).toBe(true);
      expect('mutate' in s.user).toBe(false);
      expect('asReadonlyStore' in s.user).toBe(true);
    });

    it('derived over a mutable store node is mutable and edits in place', () => {
      const m = mutableStore(
        { user: { address: { city: 'A' } } },
        { injector },
      );
      const addr = derived(m.user, 'address');
      const city = computed(() => m.user.address.city());
      expect(city()).toBe('A');
      expect(isMutable(addr)).toBe(true);
      addr.inline((a) => {
        a.city = 'B';
      });
      expect(city()).toBe('B');
      expect(m().user.address.city).toBe('B');
    });
  });

  describe('`then` is a data key', () => {
    it('a `then` field reads, writes, keeps identity and answers `in`', () => {
      const s = store({ then: 1, nested: { then: 'a' } }, { injector });
      expect(isStoreReservedKey('then')).toBe(false);
      expect(isStore(s.then)).toBe(true);
      expect(s.then).toBe(s.then);
      expect(s.then()).toBe(1);
      expect('then' in s).toBe(true);
      s.then.set(2);
      s.then.update((n) => n + 1);
      s.nested.then.set('b');
      expect(s()).toEqual({ then: 3, nested: { then: 'b' } });
    });

    it('a store passed through a promise boxed comes back intact', async () => {
      const s = store({ user: null as { a: number } | null }, { injector });
      const boxed = await Promise.resolve({ store: s });
      expect(boxed.store).toBe(s);
    });

    it('in dev mode an awaited store rejects and says to box it', async () => {
      const s = store({ user: null as { a: number } | null }, { injector });
      const scope = extendStore(s, { x: 1 });
      const awaited = async () => await (s as any);
      await expect(awaited()).rejects.toThrow(/awaited.*\{ store \}/s);
      await expect(Promise.resolve(s.user as any)).rejects.toThrow(/box it/);
      await expect(Promise.resolve(scope as any)).rejects.toThrow(/box it/);
    });

    it('in production the old path stays: no throw, the promise stays pending', async () => {
      const g = globalThis as { ngDevMode?: unknown };
      const had = Object.hasOwn(g, 'ngDevMode');
      const prev = g.ngDevMode;
      g.ngDevMode = false;
      try {
        const s = store({ then: 1 }, { injector });
        expect(() =>
          (s.then as any)(
            () => 0,
            () => 0,
          ),
        ).not.toThrow();
        let settled = false;
        void Promise.resolve(s as any).then(
          () => (settled = true),
          () => (settled = true),
        );
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        if (had) g.ngDevMode = prev;
        else delete g.ngDevMode;
      }
    });
  });

  describe('array node reflection', () => {
    it('Object.keys, spread and for...in list indices only', () => {
      const s = store({ tags: ['a', 'b'] }, { injector });
      expect(Object.keys(s.tags)).toEqual(['0', '1']);
      const forIn: string[] = [];
      for (const k in s.tags) forIn.push(k);
      expect(forIn).toEqual(['0', '1']);
      expect(Object.keys({ ...s.tags })).toEqual(['0', '1']);
      expect(s.tags.length()).toBe(2);
    });

    it('Object.keys of an empty array node is empty', () => {
      const s = store({ l: [] as number[] }, { injector });
      expect(Object.keys(s.l)).toEqual([]);
    });

    it('`in` follows the live bounds', () => {
      const s = store({ l: [1, 2, 3] }, { injector });
      expect('0' in s.l).toBe(true);
      expect('2' in s.l).toBe(true);
      expect('3' in s.l).toBe(false);
      expect('-1' in s.l).toBe(false);
      expect('99' in s.l).toBe(false);
      expect('length' in s.l).toBe(true);
    });
  });

  describe('union nodes flipped to null or to an empty array', () => {
    it('`in`, Object.keys and getPrototypeOf do not throw', () => {
      const s = store(
        { u: { a: 1 } as { a: number } | number[] | null },
        { injector },
      );
      const node = s.u as any;
      expect('a' in node).toBe(true);
      expect('length' in node).toBe(false);
      s.u.set(null);
      expect('0' in node).toBe(false);
      expect('a' in node).toBe(false);
      expect(Object.keys(node)).toEqual([]);
      expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
      expect(node instanceof Array).toBe(false);
      s.u.set([]);
      expect(Object.keys(node)).toEqual([]);
      expect(Object.getPrototypeOf(node)).toBe(Array.prototype);
    });
  });

  describe('removed `extend` method', () => {
    it('`extend` is a plain data key that routes to a child', () => {
      const s = store({ extend: { n: 1 } }, { injector });
      expect(isStoreReservedKey('extend')).toBe(false);
      expect(isStore(s.extend)).toBe(true);
      s.extend.n.set(2);
      expect(s().extend).toEqual({ n: 2 });
      const scope = extendStore(s, { x: 1 });
      expect(isStore((scope as any).extend)).toBe(true);
    });
  });

  describe('reserved signal methods behave', () => {
    it('asReadonly returns a readonly signal of the node value', () => {
      const s = store({ a: { b: 1 } }, { injector });
      const ro = s.asReadonly();
      expect(ro()).toEqual(s());
      expect((ro as any).set).toBeUndefined();
      const child = s.a.asReadonly();
      expect(child()).toEqual({ b: 1 });
      s.a.b.set(2);
      expect(child()).toEqual({ b: 2 });
    });

    it('inline on a mutable child node edits in place', () => {
      const m = mutableStore({ a: { b: 1 } }, { injector });
      m.a.inline((v) => {
        v.b = 2;
      });
      expect(m.a.b()).toBe(2);
    });

    it('names that exist on functions route to children on the root and below', () => {
      const keys = ['call', 'apply', 'bind', 'toString', 'constructor', 'name'];
      const seed = Object.fromEntries(keys.map((k, i) => [k, i]));
      const s = store({ ...seed, nested: { ...seed } }, { injector });
      for (const k of keys) {
        expect(isStore((s as any)[k]), k).toBe(true);
        expect((s as any)[k](), k).toBe(seed[k]);
        expect((s.nested as any)[k](), k).toBe(seed[k]);
      }
    });

    it('a record key named length routes to its child', () => {
      const s = store({ length: 5, inner: { length: 3 } }, { injector });
      expect(s.length()).toBe(5);
      expect(s.inner.length()).toBe(3);
    });
  });

  describe('documented defaults on toStore and mutableStore', () => {
    it('vivify is off: a deep write through null is dropped', () => {
      const t = toStore(signal({ a: null as { b: number } | null }), {
        injector,
      });
      t.a.b.set(1);
      expect(t().a).toBeNull();
      const m = mutableStore({ a: null as { b: number } | null }, { injector });
      m.a.b.set(1);
      expect(m().a).toBeNull();
    });

    it('noUnionLeaves is off: leaf-ness follows the live value', () => {
      for (const s of [
        toStore(signal({ a: 1 as number | { b: number } }), { injector }),
        mutableStore({ a: 1 as number | { b: number } }, { injector }),
      ]) {
        expect(isLeaf(s.a)).toBe(true);
        s.a.set({ b: 1 });
        expect(isLeaf(s.a)).toBe(false);
      }
    });

    it('noUnionLeaves on keeps a container node a non-leaf after a write', () => {
      const s = store({ a: { b: 1 } }, { injector, noUnionLeaves: true });
      expect(isLeaf(s.a)).toBe(false);
      s.a.set({ b: 2 });
      expect(isLeaf(s.a)).toBe(false);
    });
  });

  describe('isLeaf over every store kind', () => {
    it('answers a boolean for roots, children, readonly and scoped stores', () => {
      const s = store({ a: { b: 1 } }, { injector });
      const scope = extendStore(s, { x: 1 });
      for (const node of [s, s.a, s.asReadonlyStore(), scope, scope.x])
        expect(typeof isLeaf(node)).toBe('boolean');
      expect(isLeaf(s)).toBe(false);
      expect(isLeaf(scope)).toBe(false);
      expect(isLeaf(scope.x)).toBe(true);
    });
  });

  describe('asReadonlyStore', () => {
    it('works on a store that is already readonly', () => {
      const src = signal({ a: 1 });
      const ro = toStore(
        computed(() => src()),
        { injector },
      );
      const again = (ro as any).asReadonlyStore();
      expect(again()).toEqual({ a: 1 });
      src.set({ a: 2 });
      expect(again.a()).toBe(2);
    });
  });

  describe('mutable store notifications', () => {
    it('an in-place edit of one branch does not re-run an effect on an unrelated primitive', () => {
      const m = mutableStore(
        { theme: 'light', notifications: [] as string[] },
        { injector },
      );
      let runs = 0;
      const ref = effect(
        () => {
          m.theme();
          runs++;
        },
        { injector },
      );
      TestBed.tick();
      expect(runs).toBe(1);
      m.notifications.mutate((l) => (l.push('x'), l));
      TestBed.tick();
      expect(runs).toBe(1);
      m.theme.set('dark');
      TestBed.tick();
      expect(runs).toBe(2);
      ref.destroy();
    });
  });

  describe('transactions over a mutable root', () => {
    it('restore undoes root mutate and inline', () => {
      const m = mutableStore({ list: [1, 2], n: 0 }, { injector });
      const t = createTransaction();
      t.enter(() => {
        m.mutate((v) => {
          v.list.push(3);
          return v;
        });
        m.inline((v) => {
          v.n = 5;
        });
      });
      expect(m()).toEqual({ list: [1, 2, 3], n: 5 });
      t.restore();
      expect(m()).toEqual({ list: [1, 2], n: 0 });
    });

    it('restoring an earlier transaction keeps a later writer', () => {
      const m = mutableStore({ a: 0, b: 0 }, { injector });
      const first = createTransaction();
      first.enter(() => m.a.set(1));
      const later = createTransaction();
      later.enter(() => m.b.set(2));
      first.restore();
      expect(m().b).toBe(2);
    });
  });

  describe('extendStore scopes', () => {
    it('is a store and a writable scope has no mutate', () => {
      const scope = extendStore(store({ a: 1 }, { injector }), { b: 2 });
      expect(isStore(scope)).toBe(true);
      expect((scope as any).mutate).toBeUndefined();
      expect(isMutable(scope as any)).toBe(false);
      expect(() => optimisticStore(scope as any)).not.toThrow();
    });

    it('a mutable scope edits in place through inline', () => {
      const scope = extendStore(mutableStore({ a: 1 }, { injector }), {
        x: { n: 1 },
      });
      expect(isMutable(scope)).toBe(true);
      scope.inline((v) => {
        v.x.n = 2;
      });
      expect(scope.x.n()).toBe(2);
    });

    it('a nested scope of a readonly store stays readonly', () => {
      const ro = store({ a: 1 }, { injector }).asReadonlyStore();
      const nested = extendStore(extendStore(ro, { b: 2 }), { c: 3 }) as any;
      nested.set({ a: 9, b: 9, c: 9 });
      nested.c.set?.(9);
      expect(nested()).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('a whole-object set writes inherited keys through to the parent', () => {
      const base = store({ count: 0 }, { injector });
      const scope = extendStore(base, { label: 'x' });
      scope.set({ ...scope(), count: 5 });
      expect(base.count()).toBe(5);
      expect(base()).toEqual({ count: 5 });
    });
  });

  describe('recovery under a throwing intermediate', () => {
    it('an index read through a node whose value throws first reads the right slot later', () => {
      const first = new Error('first');
      const current = signal<{ readonly list: readonly number[] }>({
        get list(): readonly number[] {
          throw first;
        },
      });
      const scoped = extendStore(store({}, { injector }), current);
      const observed = computed(() => (scoped as any).list[1]());
      expect(() => observed()).toThrow(first);
      current.set({ list: [10, 20, 30] });
      expect(observed()).toBe(20);
    });
  });

  describe('guards', () => {
    it('optimisticStore rejects a mutable base', () => {
      expect(() =>
        optimisticStore(mutableStore({ a: 1 }, { injector }) as any),
      ).toThrow(TypeError);
    });

    it('a custom fork strategy runs on a mutable base', () => {
      const base = mutableStore({ a: 1, b: 1 }, { injector });
      const strategy = vi.fn((_anc: any, mine: any, theirs: any) => ({
        ...theirs,
        a: mine['a'],
      }));
      const fork = TestBed.runInInjectionContext(() =>
        forkStore(base as any, { strategy }),
      );
      fork.store['a'].set(7);
      base.b.set(2);
      expect(fork.store()).toEqual({ a: 7, b: 2 });
      expect(strategy).toHaveBeenCalled();
    });
  });
});
