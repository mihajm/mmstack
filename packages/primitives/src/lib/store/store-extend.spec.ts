import { effect, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutable } from '../mutable';
import { extendStore, mutableStore, store } from './store';

describe('extendStore (scoped overlay)', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  describe('inherited keys', () => {
    it('delegates to the parent with shared identity and two-way reactivity', () => {
      const parent = store({ user: { name: 'Alice' }, count: 0 }, { injector });
      const scope = extendStore(parent, { local: true });

      // same sub-store instance → true sharing
      expect(scope.user).toBe(parent.user);
      expect(scope.count()).toBe(0);

      // writing an inherited key writes through to the parent
      scope.count.set(5);
      expect(parent().count).toBe(5);
      expect(scope.count()).toBe(5);

      // parent changes flow down into the scope
      parent.user.name.set('Bob');
      expect(scope.user.name()).toBe('Bob');
    });
  });

  describe('local keys', () => {
    it('holds new (seed) keys locally and never propagates them upward', () => {
      const parent = store({ count: 0 }, { injector });
      const scope = extendStore(parent, { flag: false });

      scope.flag.set(true);
      expect(scope.flag()).toBe(true);
      expect(parent()).toEqual({ count: 0 }); // parent never gains `flag`
      expect('flag' in parent()).toBe(false);
    });

    it('a key set at runtime that exists in neither layer lands locally', () => {
      const parent = store({ a: 1 } as Record<string, number>, { injector });
      const scope = extendStore(parent, {} as Record<string, number>);

      scope['b'].set(2);
      expect(scope['b']()).toBe(2);
      expect('b' in parent()).toBe(false);
    });
  });

  describe('shadowing', () => {
    it('a seed key shadows the parent and writes stay local', () => {
      const parent = store({ theme: 'dark' }, { injector });
      const scope = extendStore(parent, { theme: 'light' });

      expect(scope.theme()).toBe('light'); // local shadow
      expect(parent().theme).toBe('dark'); // parent untouched

      scope.theme.set('blue');
      expect(scope.theme()).toBe('blue');
      expect(parent().theme).toBe('dark'); // still local
    });

    it('the local shadow keeps winning even if the parent grows the key later', () => {
      const parent = store({} as Record<string, number>, { injector });
      const scope = extendStore(parent, { x: 1 } as Record<string, number>);

      parent['x'].set(99);
      expect(parent()['x']).toBe(99);
      expect(scope['x']()).toBe(1); // local-first
    });
  });

  describe('whole-object view', () => {
    it('scope() is the merged view (local shadows) and keys are the union', () => {
      const parent = store({ a: 1, b: 2 }, { injector });
      const scope = extendStore(parent, { b: 20, c: 3 });

      expect(scope()).toEqual({ a: 1, b: 20, c: 3 });
      expect(new Set(Object.keys(scope))).toEqual(new Set(['a', 'b', 'c']));
      expect('a' in scope).toBe(true);
      expect('c' in scope).toBe(true);
      expect('missing' in scope).toBe(false);
    });

    it('scope() reactively reflects both parent and local changes', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });

      expect(scope()).toEqual({ a: 1, b: 2 });
      parent.a.set(10);
      expect(scope()).toEqual({ a: 10, b: 2 });
      scope.b.set(20);
      expect(scope()).toEqual({ a: 10, b: 20 });
    });

    it('root set splits keys: inherited → parent, local → local', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });

      scope.set({ a: 10, b: 20 });
      expect(parent().a).toBe(10);
      expect(scope.b()).toBe(20);
      expect('b' in parent()).toBe(false);
      expect(scope()).toEqual({ a: 10, b: 20 });
    });
  });

  describe('composition', () => {
    it('chains through nested extends', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(extendStore(parent, { b: 2 }), { c: 3 });

      expect(scope()).toEqual({ a: 1, b: 2, c: 3 });

      scope.c.set(30); // local to the outer scope
      expect(scope.c()).toBe(30);

      scope.a.set(10); // writes through to the root parent
      expect(parent().a).toBe(10);
    });
  });

  describe('mutable parent', () => {
    it('keeps the mutable kind: local keys support mutate in place', () => {
      const parent = mutableStore({ shared: { n: 1 } }, { injector });
      const scope = extendStore(parent, { localObj: { m: 0 } });

      const ref = scope.localObj();
      scope.localObj.mutate((o) => {
        o.m = 5;
        return o;
      });
      expect(scope.localObj()).toBe(ref); // mutated in place
      expect(scope.localObj().m).toBe(5);
    });

    it('an inherited key still mutates through to the parent source', () => {
      const src = { shared: { n: 1 } };
      const parent = mutableStore(src, { injector });
      const scope = extendStore(parent, { localObj: { m: 0 } });

      scope.shared.mutate((s) => {
        s.n = 9;
        return s;
      });
      expect(src.shared.n).toBe(9);
    });
  });

  describe('readonly parent', () => {
    it('yields a readonly overlay (writes are no-ops)', () => {
      const parent = store({ a: 1 }, { injector }).asReadonlyStore();
      const scope = extendStore(parent, { b: 2 });

      expect(scope()).toEqual({ a: 1, b: 2 });
      expect(scope.a()).toBe(1);
      expect(scope.b()).toBe(2);

      (scope.b as unknown as { set: (v: number) => void }).set(99);
      expect(scope.b()).toBe(2); // unchanged
    });
  });

  describe('signal-backed local layer', () => {
    it('uses an external writable signal as the local layer (two-way)', () => {
      const parent = store({ a: 1 }, { injector });
      const localSig = signal({ b: 2 });
      const scope = extendStore(parent, localSig);

      expect(scope.b()).toBe(2);

      scope.b.set(20); // write flows out to the external signal
      expect(localSig().b).toBe(20);

      localSig.set({ b: 99 }); // external change flows into the scope
      expect(scope.b()).toBe(99);

      scope.a.set(10); // inherited still writes through to the parent
      expect(parent().a).toBe(10);
    });

    it('accepts a mutable signal for a mutable parent', () => {
      const parent = mutableStore({ a: 1 }, { injector });
      const localSig = mutable({ obj: { n: 0 } });
      const scope = extendStore(parent, localSig);

      scope.obj.mutate((o) => {
        o.n = 5;
        return o;
      });
      expect(localSig().obj.n).toBe(5);
    });

    it('composes by extending with another store', () => {
      const parent = store({ a: 1 }, { injector });
      const other = store({ b: 2 }, { injector });
      const scope = extendStore(parent, other);

      expect(scope()).toEqual({ a: 1, b: 2 });

      scope.b.set(20); // writes the other store
      expect(other().b).toBe(20);
    });
  });

  describe('reactive notifications', () => {
    it('per-key effects are isolated across layers (no over-notification)', () => {
      const parent = store({ a: 1, b: 2 }, { injector });
      const scope = extendStore(parent, { c: 3 });
      let aRuns = 0;
      let cRuns = 0;
      effect(
        () => {
          scope.a();
          aRuns++;
        },
        { injector },
      );
      effect(
        () => {
          scope.c();
          cRuns++;
        },
        { injector },
      );
      TestBed.tick();
      aRuns = 0;
      cRuns = 0;

      scope.b.set(20); // unrelated inherited key
      TestBed.tick();
      expect(aRuns).toBe(0);
      expect(cRuns).toBe(0);

      scope.a.set(10); // the inherited key the effect reads
      TestBed.tick();
      expect(aRuns).toBe(1);
      expect(cRuns).toBe(0); // local effect unaffected by an inherited write

      scope.c.set(30); // local key
      TestBed.tick();
      expect(aRuns).toBe(1); // inherited effect unaffected by a local write
      expect(cRuns).toBe(1);
    });

    it('an inherited-key effect re-runs when the parent is written directly', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });
      let runs = 0;
      effect(
        () => {
          scope.a();
          runs++;
        },
        { injector },
      );
      TestBed.tick();
      runs = 0;

      parent.a.set(9);
      TestBed.tick();
      expect(runs).toBe(1);
      expect(scope.a()).toBe(9);
    });
  });

  describe('root writers', () => {
    it('scope.update splits inherited vs local', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });
      scope.update((cur) => ({ ...cur, a: cur.a + 10, b: cur.b + 20 }));
      expect(parent().a).toBe(11);
      expect(scope.b()).toBe(22);
      expect('b' in parent()).toBe(false);
    });

    it('root mutate on a mutable scope splits per key', () => {
      const parent = mutableStore({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });
      scope.mutate((cur) => {
        cur.a = 10;
        cur.b = 20;
        return cur;
      });
      expect(parent().a).toBe(10);
      expect(scope.b()).toBe(20);
    });

    it('a readonly scope ignores a root set', () => {
      const parent = store({ a: 1 }, { injector }).asReadonlyStore();
      const scope = extendStore(parent, { b: 2 });
      (scope as unknown as { set: (v: object) => void }).set({ a: 9, b: 9 });
      expect(scope()).toEqual({ a: 1, b: 2 });
    });
  });

  describe('asReadonlyStore', () => {
    it('is a read-only, reactive snapshot of the merge', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { b: 2 });
      const ro = scope.asReadonlyStore();

      expect(ro()).toEqual({ a: 1, b: 2 });

      parent.a.set(9);
      expect(ro().a).toBe(9); // reflects the parent reactively

      (ro.a as unknown as { set: (v: number) => void }).set(100);
      expect(parent().a).toBe(9); // writes are no-ops — a read-only snapshot
    });
  });

  describe('arrays in the overlay', () => {
    it('a local array seed exposes index signals + length', () => {
      const parent = store({ a: 1 }, { injector });
      const scope = extendStore(parent, { tags: ['x', 'y'] });
      expect(scope.tags[0]()).toBe('x');
      expect(scope.tags.length()).toBe(2);
      scope.tags[0].set('z');
      expect(scope.tags()).toEqual(['z', 'y']);
    });

    it('an inherited array delegates to the parent', () => {
      const parent = store({ items: [{ id: 1 }] }, { injector });
      const scope = extendStore(parent, { flag: true });
      expect(scope.items).toBe(parent.items);
      scope.items[0].id.set(9);
      expect(parent().items[0].id).toBe(9);
    });
  });

  describe('edge cases', () => {
    it('an empty seed is a pure pass-through that can still grow local keys', () => {
      const parent = store({ a: 1 } as Record<string, number>, { injector });
      const scope = extendStore(parent, {} as Record<string, number>);
      expect(scope()).toEqual({ a: 1 });
      expect(scope['a']()).toBe(1);
      scope['b'].set(2);
      expect(scope()).toEqual({ a: 1, b: 2 });
      expect('b' in parent()).toBe(false);
    });

    it('writes through two levels of chaining to the root parent (shared identity)', () => {
      const root = store({ a: { n: 1 } }, { injector });
      const scope = extendStore(extendStore(root, { b: 2 }), { c: 3 });
      expect(scope.a).toBe(root.a);
      scope.a.n.set(9);
      expect(root().a.n).toBe(9);
    });

    it('a seed object shadows an inherited object (local identity, parent untouched)', () => {
      const parent = store({ cfg: { x: 1 } }, { injector });
      const scope = extendStore(parent, { cfg: { x: 99 } });
      expect(scope.cfg).not.toBe(parent.cfg);
      expect(scope.cfg.x()).toBe(99);
      scope.cfg.x.set(5);
      expect(scope.cfg.x()).toBe(5);
      expect(parent().cfg.x).toBe(1);
    });

    it('keeps property access + extend when the source type is any (T = any)', () => {
      // Regression: T = any used to collapse the store type to Signal<any>, erasing
      // both property access and `extend`. The lines below must type-check.
      const s = store({ a: 1 } as any, { injector });
      s['a'].set(5);
      expect(s['a']()).toBe(5);

      const child = extendStore(s, { b: 2 });
      expect(child.b()).toBe(2); // explicitly-typed local key
      expect(child['a']()).toBe(5); // inherited via the `any` index signature
    });
  });

  describe('vivify interaction', () => {
    it('inherited paths vivify via the parent; the plain local layer does not', () => {
      const parent = store(
        { a: null as { b: number } | null },
        { injector, vivify: 'auto' },
      );
      const scope = extendStore(parent, { local: null as { x: number } | null });

      scope.a.b.set(2); // inherited → vivifies via the parent
      expect(parent().a).toEqual({ b: 2 });

      scope.local.x.set(5); // local plain store → dropped (no vivify)
      expect(scope.local()).toBeNull();
    });

    it('a vivify-enabled store can back the local layer', () => {
      const parent = store({ a: 1 }, { injector });
      const localStore = store(
        { b: null as { c: number } | null },
        { injector, vivify: 'auto' },
      );
      const scope = extendStore(parent, localStore);

      scope.b.c.set(2);
      expect(localStore().b).toEqual({ c: 2 });
    });
  });

  describe('writability inheritance & chaining', () => {
    it('inherited keys two-way, local keys stay local', () => {
      const parent = store({ count: 0 }, { injector });
      const scope = extendStore(parent, { flag: false });

      scope.count.set(5);
      expect(parent().count).toBe(5);

      scope.flag.set(true);
      expect(scope.flag()).toBe(true);
      expect('flag' in parent()).toBe(false);
    });

    it('inherits mutable writability from the parent store', () => {
      const parent = mutableStore({ list: [1, 2] }, { injector });
      const scope = extendStore(parent, { label: 'x' });

      scope.list.mutate((l) => {
        l.push(3);
        return l;
      });
      expect(parent().list).toEqual([1, 2, 3]);
    });

    it('inherits readonly writability (STORE_KIND beats set-detection)', () => {
      const ro = store({ count: 1 }, { injector }).asReadonlyStore();
      const scope = extendStore(ro, { label: 'x' });

      // a readonly scope must not write through; set is a no-op
      (scope as any).count.set(99);
      expect(scope.count()).toBe(1);
    });

    it('accepts a signal seed and supports chaining', () => {
      const parent = store({ a: 1 }, { injector });
      const seed = signal({ b: 2 });
      const scope = extendStore(parent, seed);
      const nested = extendStore(scope, { c: 3 });

      expect(nested.a()).toBe(1);
      expect(nested.b()).toBe(2);
      expect(nested.c()).toBe(3);
    });
  });
});
