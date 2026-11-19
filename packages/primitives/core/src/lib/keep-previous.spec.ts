import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createTransaction } from './concurrent/transaction';
import { derived } from './derived';
import { keepPrevious } from './keep-previous';
import { isMutable, mutable } from './mutable';
import { toStore } from './store/store';

describe('keepPrevious', () => {
  it('holds the last defined value when the source drops to undefined', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(1);
      const held = keepPrevious(src);

      expect(held()).toBe(1);

      src.set(undefined); // mid-reload gap → hold previous, do not flash empty
      expect(held()).toBe(1);

      src.set(2); // new defined value flows through
      expect(held()).toBe(2);

      src.set(undefined);
      expect(held()).toBe(2);
    });
  });

  it('passes the initial value through even if undefined (no previous to hold yet)', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(undefined);
      const held = keepPrevious(src);
      expect(held()).toBeUndefined();

      src.set(5);
      expect(held()).toBe(5);
    });
  });

  it('yields the fallback only while nothing has ever been defined, then holds the previous value', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number[] | undefined>(undefined);
      const held = keepPrevious(src, { fallback: [] });
      expect(held()).toEqual([]);

      src.set([1]);
      expect(held()).toEqual([1]);

      src.set(undefined); // the gap after a defined value → previous, never the fallback again
      expect(held()).toEqual([1]);
    });
  });

  it('forwards set/update to a writable source (stays a drop-in replacement)', () => {
    TestBed.runInInjectionContext(() => {
      const src = signal<number | undefined>(1);
      const held = keepPrevious(src);

      held.set(9); // write goes through to the source
      expect(src()).toBe(9);
      expect(held()).toBe(9);

      held.update((v) => (v ?? 0) + 1);
      expect(src()).toBe(10);
    });
  });

  it('asReadonly is a view of the held value, not of the source', () => {
    const src = signal<number | undefined>(1);
    const ro = keepPrevious(src).asReadonly();
    expect(ro()).toBe(1);
    src.set(undefined);
    expect(ro()).toBe(1);
  });

  it('forwards from() for a derived source', () => {
    const src = signal({ v: 1 });
    const kept = keepPrevious(derived(src, 'v'));
    expect(kept.from({ v: 3 })).toBe(3);
  });

  it('over a plain writable source the result is not mutable, and a store over it writes through', () => {
    const src = signal({ a: 1 });
    const kept = keepPrevious(src);
    expect(isMutable(kept)).toBe(false);
    const s = TestBed.runInInjectionContext(() => toStore(kept));
    s.a.set(2);
    expect(src()).toEqual({ a: 2 });
  });

  it('a transaction with only update() restores the source', () => {
    const src = signal<number | undefined>(1);
    const kept = keepPrevious(src);
    const t = createTransaction();
    t.enter(() => kept.update((v) => (v ?? 0) + 1));
    expect(src()).toBe(2);
    t.restore();
    expect(kept()).toBe(1);
  });
});

describe('keepPrevious over a mutable source', () => {
  type Item = { id: number; label: string };
  const setup = (equal?: (a: Item[], b: Item[]) => boolean) => {
    const src = mutable<Item[]>([{ id: 1, label: 'a' }], { equal });
    const held = keepPrevious(src, equal ? { equal } : undefined);
    let runs = 0;
    const reader = computed(() => {
      runs++;
      return held()
        .map((i) => i.label)
        .join(',');
    });
    return { src, held, reader, runs: () => runs };
  };

  it('forwards mutate to the source and notifies readers of a same-reference change', () => {
    const { src, held, reader } = setup();
    expect(isMutable(held)).toBe(true);
    expect(reader()).toBe('a');
    held.mutate((a) => (a.push({ id: 2, label: 'b' }), a));
    expect(src().length).toBe(2);
    expect(reader()).toBe('a,b');
    held.mutate((a) => (a.push({ id: 3, label: 'c' }), a));
    expect(reader()).toBe('a,b,c');
  });

  it('forwards inline to the source and notifies readers', () => {
    const { src, held, reader } = setup();
    expect(reader()).toBe('a');
    held.inline((a) => {
      a.push({ id: 2, label: 'b' });
    });
    expect(src().map((i) => i.id)).toEqual([1, 2]);
    expect(reader()).toBe('a,b');
  });

  it("honors the caller's equal before and after a mutate", () => {
    const sameIds = (a: Item[], b: Item[]) =>
      a.length === b.length && a.every((x, i) => x.id === b[i].id);
    const { src, held, reader, runs } = setup(sameIds);
    expect(reader()).toBe('a');
    src.set([{ id: 1, label: 'renamed' }]);
    expect(reader()).toBe('a');
    expect(runs()).toBe(1);
    held.mutate((a) => (a.push({ id: 2, label: 'b' }), a));
    expect(reader()).toBe('a,b');
    const after = runs();
    src.set([
      { id: 1, label: 'x' },
      { id: 2, label: 'y' },
    ]);
    expect(reader()).toBe('a,b');
    expect(runs()).toBe(after);
  });

  it('a mutate inside a transaction is undone by restore', () => {
    const src = mutable([1]);
    const held = keepPrevious(src);
    const t = createTransaction();
    t.enter(() => held.mutate((a) => (a.push(2), a)));
    expect(src()).toEqual([1, 2]);
    t.restore();
    expect(held()).toEqual([1]);
  });
});
