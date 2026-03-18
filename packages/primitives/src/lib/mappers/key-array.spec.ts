import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { keyArray } from './key-array';

describe('keyArray', () => {
  it('should map initial items with index signals', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(['a', 'b', 'c']);
      const mapped = keyArray(source, (v, i) => ({ value: v, index: i }));

      const result = mapped();
      expect(result.length).toBe(3);
      expect(result[0].value).toBe('a');
      expect(result[0].index()).toBe(0);
      expect(result[1].value).toBe('b');
      expect(result[1].index()).toBe(1);
      expect(result[2].value).toBe('c');
      expect(result[2].index()).toBe(2);
    });
  });

  it('should reuse mapped results when items are reordered', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal(['a', 'b', 'c']);
      const mapFn = vi.fn((v: string, i) => ({ value: v, index: i }));
      const mapped = keyArray(source, mapFn);

      const first = mapped();
      expect(mapFn).toHaveBeenCalledTimes(3);

      const originalA = first[0];
      const originalC = first[2];

      source.set(['c', 'b', 'a']);
      const second = mapped();

      // mapFn should NOT have been called again for existing items
      expect(mapFn).toHaveBeenCalledTimes(3);

      // Items should be reused (same object references), just reordered
      expect(second[0]).toBe(originalC);
      expect(second[2]).toBe(originalA);

      // Index signals should update
      expect(second[0].index()).toBe(0);
      expect(second[2].index()).toBe(2);
    });
  });

  it('should call mapFn only for new items when items are added', () => {
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2]);
      const mapFn = vi.fn((v: number, i) => ({ value: v, index: i }));
      const mapped = keyArray(source, mapFn);

      mapped();
      expect(mapFn).toHaveBeenCalledTimes(2);

      source.set([1, 2, 3]);
      const result = mapped();

      expect(mapFn).toHaveBeenCalledTimes(3); // Only 1 new call for item '3'
      expect(result.length).toBe(3);
      expect(result[2].value).toBe(3);
    });
  });

  it('should call onDestroy when items are removed', () => {
    TestBed.runInInjectionContext(() => {
      const destroySpy = vi.fn();
      const source = signal(['a', 'b', 'c']);
      const mapped = keyArray(
        source,
        (v, i) => ({ value: v, index: i }),
        { onDestroy: destroySpy },
      );

      mapped();
      expect(destroySpy).not.toHaveBeenCalled();

      source.set(['a']);
      mapped();

      expect(destroySpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should handle clearing the array', () => {
    TestBed.runInInjectionContext(() => {
      const destroySpy = vi.fn();
      const source = signal([1, 2, 3]);
      const mapped = keyArray(
        source,
        (v) => v * 10,
        { onDestroy: destroySpy },
      );

      mapped();
      source.set([]);
      const result = mapped();

      expect(result).toEqual([]);
      expect(destroySpy).toHaveBeenCalledTimes(3);
    });
  });

  it('should support custom key function', () => {
    TestBed.runInInjectionContext(() => {
      type Item = { id: number; name: string };
      const source = signal<Item[]>([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);

      const mapFn = vi.fn((v: Item, i) => ({ item: v, index: i }));
      const mapped = keyArray(source, mapFn, { key: (item) => item.id });

      const first = mapped();
      expect(mapFn).toHaveBeenCalledTimes(2);
      const aliceRef = first[0];

      // Update name but keep same id — should reuse mapped result
      source.set([
        { id: 1, name: 'Alice Updated' },
        { id: 2, name: 'Bob Updated' },
      ]);
      const second = mapped();

      expect(mapFn).toHaveBeenCalledTimes(2); // No new calls
      expect(second[0]).toBe(aliceRef); // Same reference reused
    });
  });

  it('should work with a computed source', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal([10, 20, 30]);
      const source = computed(() => base().filter((v) => v > 10));
      const mapped = keyArray(source, (v) => v * 2);

      expect(mapped()).toEqual([40, 60]);

      base.set([10, 20, 30, 40]);
      expect(mapped()).toEqual([40, 60, 80]);
    });
  });
});
