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
      const source = mutable([
        { name: 'Alice' },
        { name: 'Bob' },
      ]);
      const mapped = indexArray(source, (itemSig) => itemSig);

      const result = mapped();
      result[0].mutate((v) => ({ ...v, name: 'Updated' }));

      expect(source()[0].name).toBe('Updated');
    });
  });

  it('should reuse mapped results when length stays the same', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2, 3]);
      const mapFn = vi.fn((itemSig, index: number) => ({ sig: itemSig, index }));
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
      const mapFn = vi.fn((itemSig, index: number) => ({ sig: itemSig, index }));
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
});
