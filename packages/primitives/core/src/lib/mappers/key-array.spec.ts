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

  describe('duplicateKeys: ordinal policy', () => {
    it('passes the effective key to mapFn (ordinal for duplicates, raw key in default mode)', () => {
      TestBed.runInInjectionContext(() => {
        type Item = { id: string };
        const source = signal<Item[]>([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);

        const seen: (string | unknown)[] = [];
        const mapped = keyArray(source, (v, _i, key) => (seen.push(key), v), {
          key: (item) => item.id,
          duplicateKeys: { policy: 'ordinal' },
        });
        mapped();
        expect(seen).toEqual(['a', 'a#1', 'b']);

        source.set([{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'a' }]);
        mapped();
        expect(seen).toEqual(['a', 'a#1', 'b', 'a#2']);

        const plainSeen: unknown[] = [];
        const plainSource = signal<Item[]>([{ id: 'x' }, { id: 'y' }]);
        const plain = keyArray(plainSource, (v, _i, key) => (plainSeen.push(key), v), {
          key: (item) => item.id,
        });
        plain();
        expect(plainSeen).toEqual(['x', 'y']);

        plainSource.set([{ id: 'x' }, { id: 'y' }, { id: 'z' }]);
        plain();
        expect(plainSeen).toEqual(['x', 'y', 'z']);
      });
    });

    it('gives duplicates stable, distinct entries and keeps the first entry across an unrelated update', () => {
      TestBed.runInInjectionContext(() => {
        type Item = { id: string; n: number };
        const source = signal<Item[]>([
          { id: 'a', n: 1 },
          { id: 'a', n: 2 },
        ]);

        const mapFn = vi.fn((v: Item, i) => ({ item: v, index: i }));
        const mapped = keyArray(source, mapFn, {
          key: (item) => item.id,
          duplicateKeys: { policy: 'ordinal' },
        });

        const first = mapped();
        expect(mapFn).toHaveBeenCalledTimes(2);
        expect(first).toHaveLength(2);
        expect(first[0]).not.toBe(first[1]);
        const firstEntry = first[0];
        const secondEntry = first[1];

        // Append an unrelated item; both duplicate entries must be reused.
        source.set([
          { id: 'a', n: 1 },
          { id: 'a', n: 2 },
          { id: 'b', n: 9 },
        ]);
        const second = mapped();

        expect(mapFn).toHaveBeenCalledTimes(3);
        expect(second[0]).toBe(firstEntry);
        expect(second[1]).toBe(secondEntry);
        expect(second[2]).not.toBe(firstEntry);
      });
    });

    it('assigns ordinal effective keys deterministically (a, a, a -> a, a#1, a#2)', () => {
      TestBed.runInInjectionContext(() => {
        let uid = 0;
        const source = signal(['a', 'a', 'a']);
        const mapFn = vi.fn((v: string) => ({ value: v, uid: uid++ }));
        const mapped = keyArray(source, mapFn, {
          duplicateKeys: { policy: 'ordinal' },
        });

        const first = mapped();
        expect(first.map((e) => e.uid)).toEqual([0, 1, 2]);

        // Re-set an equal array: every ordinal key (a, a#1, a#2) is stable,
        // so all three entries are reused, none recreated.
        source.set(['a', 'a', 'a']);
        const second = mapped();
        expect(mapFn).toHaveBeenCalledTimes(3);
        expect(second.map((e) => e.uid)).toEqual([0, 1, 2]);

        // Drop to two a's: keys a and a#1 survive (uid 0, 1); a#2 (uid 2) is gone.
        source.set(['a', 'a']);
        const third = mapped();
        expect(mapFn).toHaveBeenCalledTimes(3);
        expect(third.map((e) => e.uid)).toEqual([0, 1]);
      });
    });

    it('promotes the second duplicate when the first is removed (identity follows position-among-duplicates)', () => {
      TestBed.runInInjectionContext(() => {
        type Item = { id: string; tag: string };
        const x: Item = { id: 'a', tag: 'X' };
        const y: Item = { id: 'a', tag: 'Y' };
        const destroySpy = vi.fn();
        const source = signal<Item[]>([x, y]);

        const mapFn = vi.fn((v: Item) => ({ tag: v.tag }));
        const mapped = keyArray(source, mapFn, {
          key: (item) => item.id,
          duplicateKeys: { policy: 'ordinal' },
          onDestroy: destroySpy,
        });

        const first = mapped();
        expect(mapFn).toHaveBeenCalledTimes(2);
        const entryX = first[0]; // effective key 'a'
        const entryY = first[1]; // effective key 'a#1'

        // Remove the first duplicate. Y is promoted to the base key 'a', which
        // changes its identity: its original 'a#1' entry is destroyed and the
        // surviving base-'a' entry is the one originally created for X.
        source.set([y]);
        const second = mapped();

        expect(second).toHaveLength(1);
        expect(second[0]).toBe(entryX);
        expect(second[0]).not.toBe(entryY);
        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(destroySpy).toHaveBeenCalledWith(entryY);
      });
    });

    it('destroys the correct entry when a middle duplicate is removed', () => {
      TestBed.runInInjectionContext(() => {
        let uid = 0;
        const destroySpy = vi.fn();
        const source = signal(['a', 'a', 'b']);
        const mapFn = vi.fn((v: string) => ({ value: v, uid: uid++ }));
        const mapped = keyArray(source, mapFn, {
          duplicateKeys: { policy: 'ordinal' },
          onDestroy: destroySpy,
        });

        const first = mapped();
        const middle = first[1]; // effective key 'a#1'
        expect(first.map((e) => e.uid)).toEqual([0, 1, 2]);

        source.set(['a', 'b']);
        const second = mapped();

        expect(second.map((e) => e.uid)).toEqual([0, 2]);
        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(destroySpy).toHaveBeenCalledWith(middle);
      });
    });

    it('reports duplicate base keys once per recompute, in first-occurrence order, and not when there are none', () => {
      TestBed.runInInjectionContext(() => {
        const report = vi.fn();
        const source = signal(['a', 'a', 'b', 'b', 'c']);
        const mapped = keyArray(source, (v) => v, {
          duplicateKeys: { policy: 'ordinal', report },
        });

        mapped();
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenLastCalledWith(['a', 'b']);

        // No duplicates: report must not fire.
        source.set(['a', 'b', 'c']);
        mapped();
        expect(report).toHaveBeenCalledTimes(1);

        // New duplicates: report fires again, once, with the new base.
        source.set(['x', 'x']);
        mapped();
        expect(report).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenLastCalledWith(['x']);
      });
    });

    it('regression guard: with the option absent, reorder-reuse behavior is unchanged', () => {
      TestBed.runInInjectionContext(() => {
        const source = signal(['a', 'b', 'c']);
        const mapFn = vi.fn((v: string, i) => ({ value: v, index: i }));
        const mapped = keyArray(source, mapFn);

        const first = mapped();
        const originalA = first[0];
        const originalC = first[2];

        source.set(['c', 'b', 'a']);
        const second = mapped();

        expect(mapFn).toHaveBeenCalledTimes(3);
        expect(second[0]).toBe(originalC);
        expect(second[2]).toBe(originalA);
        expect(second[0].index()).toBe(0);
        expect(second[2].index()).toBe(2);
      });
    });
  });
});
