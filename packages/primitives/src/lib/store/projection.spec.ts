import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { projection, reconcile } from './projection';
import { createStoreContext } from './store';

type User = { id: number; name: string; active: boolean };

describe('reconcile', () => {
  it('keeps the reference of an unchanged object subtree', () => {
    const prev = { a: { x: 1 }, b: { y: 2 } };
    const next = { a: { x: 1 }, b: { y: 3 } }; // only b changed
    const out = reconcile(prev, next);
    expect(out.a).toBe(prev.a); // a preserved by reference
    expect(out.b).not.toBe(prev.b);
    expect(out.b).toEqual({ y: 3 });
  });

  it('returns the previous reference when nothing changed', () => {
    const prev = { a: { x: 1 } };
    const next = { a: { x: 1 } };
    expect(reconcile(prev, next)).toBe(prev);
  });

  it('matches array items by key across a reorder, keeping identity', () => {
    const a = { id: 1, name: 'a', active: true };
    const b = { id: 2, name: 'b', active: true };
    const prev = [a, b];
    const next = [{ id: 2, name: 'b', active: true }, { id: 1, name: 'a', active: true }];
    const out = reconcile(prev, next, 'id');
    expect(out[0]).toBe(b); // id 2 kept its reference
    expect(out[1]).toBe(a); // id 1 kept its reference
  });

  it('creates only added items and drops removed ones', () => {
    const a = { id: 1, name: 'a', active: true };
    const prev = [a];
    const next = [{ id: 1, name: 'a', active: true }, { id: 2, name: 'b', active: true }];
    const out = reconcile(prev, next, 'id');
    expect(out[0]).toBe(a); // survivor kept
    expect(out[1]).toEqual({ id: 2, name: 'b', active: true }); // new item
  });
});

describe('projection', () => {
  it('derives a store and recomputes on dependency change', () => {
    TestBed.runInInjectionContext(() => {
      const users = signal<User[]>([
        { id: 1, name: 'ada', active: true },
        { id: 2, name: 'bob', active: false },
      ]);
      const active = projection<User[]>(() => users().filter((u) => u.active), []);

      TestBed.tick();
      expect(active().length).toBe(1);
      expect(active().at(0)?.name).toBe('ada');

      users.set([
        { id: 1, name: 'ada', active: true },
        { id: 2, name: 'bob', active: true },
      ]);
      TestBed.tick();
      expect(active().length).toBe(2);
    });
  });

  it('supports the mutate-in-place form', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal({ n: 2 });
      const derived = projection<{ doubled: number }>(
        (draft) => {
          draft.doubled = src().n * 2;
        },
        { doubled: 0 },
      );
      TestBed.tick();
      expect(derived().doubled).toBe(4);
      src.set({ n: 5 });
      TestBed.tick();
      expect(derived().doubled).toBe(10);
    });
  });

  it('reads coherently right after a write, no effect flush needed (pull-based)', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal({ n: 1 });
      const p = projection<{ n: number }>(() => src(), { n: 0 });

      expect(p().n).toBe(1); // first read computes, no tick

      src.set({ n: 7 });
      expect(p().n).toBe(7); // synchronously fresh, not stale-until-flush
    });
  });

  it('is lazy: fn does not run while nobody reads', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal({ n: 1 });
      let runs = 0;
      const p = projection<{ n: number }>(() => {
        runs++;
        return src();
      }, { n: 0 });

      expect(runs).toBe(0); // creation does not compute
      src.set({ n: 2 });
      src.set({ n: 3 });
      expect(runs).toBe(0); // still nothing — no reader
      expect(p().n).toBe(3);
      expect(runs).toBe(1); // one compute for the read, intermediate values skipped
    });
  });

  it('runs injector-free with an explicit store context (worker-safe)', () => {
    // NO TestBed / injection context anywhere in this test
    const src = signal<User[]>([{ id: 1, name: 'ada', active: true }]);
    const p = projection<User[]>(() => src().filter((u) => u.active), [], {
      ...createStoreContext(),
      key: 'id',
    });

    expect(p().length).toBe(1);
    expect(p[0].name()).toBe('ada');

    src.set([
      { id: 1, name: 'ada', active: true },
      { id: 2, name: 'bob', active: true },
    ]);
    expect(p().length).toBe(2);
  });

  it('keeps per-field tracking: a computed over one field does not recompute for another', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal({ a: 1, b: 1 });
      const proj = projection<{ a: number; b: number }>(() => src(), { a: 0, b: 0 });
      TestBed.tick();

      let recomputes = 0;
      const viewA = computed(() => {
        recomputes++;
        return proj.a();
      });
      expect(viewA()).toBe(1); // recomputes = 1

      src.set({ a: 1, b: 99 }); // only b changed
      TestBed.tick();
      viewA(); // a unchanged → reconcile kept a's slot → no recompute
      expect(recomputes).toBe(1);

      src.set({ a: 2, b: 99 }); // a changed
      TestBed.tick();
      expect(viewA()).toBe(2);
      expect(recomputes).toBe(2);
    });
  });
});
