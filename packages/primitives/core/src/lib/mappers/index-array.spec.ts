import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutable } from '../mutable';
import { indexArray } from './index-array';

describe('indexArray', () => {
  it('should map items with stable signals for each index', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(['a', 'b', 'c']);
      const mapped = indexArray(source, (itemSig, index) => ({
        value: itemSig,
        index,
      }));

      const result = mapped();
      expect(result.length).toBe(3);
      expect(result[0].value()).toBe('a');
      expect(result[0].index).toBe(0);
      expect(result[1].value()).toBe('b');
      expect(result[2].value()).toBe('c');
    });
  });

  it('should allow writing back through writable source', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(['x', 'y', 'z']);
      const mapped = indexArray(source, (itemSig) => itemSig);

      const result = mapped();
      result[1].set('changed');

      expect(source()).toEqual(['x', 'changed', 'z']);
    });
  });

  it('should allow mutating back through mutable source', () => {
    TestBed.runInInjectionContext(() => {
      const source = mutable([{ name: 'Alice' }, { name: 'Bob' }]);
      const mapped = indexArray(source, (itemSig) => itemSig);

      const result = mapped();
      result[0].mutate((v) => ({ ...v, name: 'Updated' }));

      expect(source()[0].name).toBe('Updated');
    });
  });

  it('should reuse mapped results when length stays the same', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2, 3]);
      const mapFn = vi.fn((itemSig, index: number) => ({
        sig: itemSig,
        index,
      }));
      const mapped = indexArray(source, mapFn);

      const first = mapped();
      expect(mapFn).toHaveBeenCalledTimes(3);

      source.set([10, 20, 30]); // Same length
      const second = mapped();

      // Same length = reuse existing mapped results
      expect(mapFn).toHaveBeenCalledTimes(3);
      expect(second[0]).toBe(first[0]);
    });
  });

  it('should grow the mapped array when items are added', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2]);
      const mapFn = vi.fn((itemSig, index: number) => ({
        sig: itemSig,
        index,
      }));
      const mapped = indexArray(source, mapFn);

      mapped();
      expect(mapFn).toHaveBeenCalledTimes(2);

      source.set([1, 2, 3, 4]);
      const result = mapped();

      expect(mapFn).toHaveBeenCalledTimes(4); // 2 new calls
      expect(result.length).toBe(4);
    });
  });

  it('should shrink and call onDestroy when items are removed', () => {
    TestBed.runInInjectionContext(() => {
      const destroySpy = vi.fn();
      const source = signal([1, 2, 3]);
      const mapped = indexArray(source, (itemSig) => itemSig, {
        onDestroy: destroySpy,
      });

      mapped();
      source.set([1]);
      const result = mapped();

      expect(result.length).toBe(1);
      expect(destroySpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should work with a readonly signal source', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal([10, 20]);
      const readOnly = computed(() => base());
      const mapped = indexArray(readOnly, (itemSig) => ({
        doubled: computed(() => itemSig() * 2),
      }));

      const result = mapped();
      expect(result[0].doubled()).toBe(20);
      expect(result[1].doubled()).toBe(40);
    });
  });

  function counted<T, V>(read: () => T, project: (v: T) => V) {
    let runs = 0;
    const c = computed(() => {
      runs++;
      return project(read());
    });
    return { c, runs: () => runs };
  }

  it("honors the caller's equal for item signals of a plain source", () => {
    const source = signal([{ id: 1, v: 'a' }]);
    const mapped = indexArray(source, (item) => counted(item, (x) => x.v), {
      equal: (a, b) => a.id === b.id,
    });
    const row = mapped()[0];
    expect(row.c()).toBe('a');
    source.set([{ id: 1, v: 'b' }]);
    expect(row.c()).toBe('a');
    expect(row.runs()).toBe(1);
  });

  it('a plain source: replacing one item re-runs only that item', () => {
    const a = { v: 'a' };
    const source = signal([a, { v: 'b' }]);
    const mapped = indexArray(source, (item) => counted(item, (x) => x.v));
    const [r0, r1] = mapped();
    r0.c();
    r1.c();
    source.set([a, { v: 'B' }]);
    expect(r0.c()).toBe('a');
    expect(r1.c()).toBe('B');
    expect(r0.runs()).toBe(1);
    expect(r1.runs()).toBe(2);
  });

  it('a mutable source: an in-place object edit reaches the item consumer', () => {
    const items = mutable([{ name: 'A' }, { name: 'B' }]);
    const mapped = indexArray(items, (item, i) =>
      computed(() => `${i}: ${item().name}`),
    );
    expect(mapped()[0]()).toBe('0: A');
    items.mutate((arr) => {
      arr[0].name = 'Z';
      return arr;
    });
    expect(mapped()[0]()).toBe('0: Z');
    items.mutate((arr) => {
      arr[0] = { name: 'new' };
      return arr;
    });
    expect(mapped()[0]()).toBe('0: new');
  });

  it('a mutable source of primitives: only changed slots re-run', () => {
    const items = mutable<(number | string)[]>([1, 2]);
    const mapped = indexArray(items, (item) => counted(item, (x) => x));
    const [r0, r1] = mapped();
    r0.c();
    r1.c();
    items.mutate((arr) => {
      arr[1] = 9;
      return arr;
    });
    expect(r0.c()).toBe(1);
    expect(r1.c()).toBe(9);
    expect(r0.runs()).toBe(1);
    items.mutate((arr) => {
      arr[0] = 5;
      return arr;
    });
    expect(r0.c()).toBe(5);
    items.mutate((arr) => {
      arr[0] = 'x';
      return arr;
    });
    expect(r0.c()).toBe('x');
  });

  it('growth and shrink without options: a computed over the length follows', () => {
    const source = signal([1, 2]);
    const mapped = indexArray(source, (item) => item);
    const length = computed(() => mapped().length);
    expect(length()).toBe(2);
    source.set([1, 2, 3]);
    expect(length()).toBe(3);
    source.set([1]);
    expect(length()).toBe(1);
    expect(mapped()[0]()).toBe(1);
  });
});
