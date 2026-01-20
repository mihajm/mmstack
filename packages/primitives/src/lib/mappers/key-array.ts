import {
  computed,
  isSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/**
 * Reactively maps items from a source array to a new array by value (identity).
 *
 * similar to `Array.prototype.map`, but:
 * 1. The `mapFn` receives the `index` as a Signal.
 * 2. If an item in the `source` array moves to a new position, the *result* of the map function is reused and moved.
 *    The `index` signal is updated to the new index.
 * 3. The `mapFn` is only run for *new* items.
 *
 * This is useful for building efficient lists where DOM nodes or heavy instances should be reused
 * when the list is reordered.
 *
 * @param source A `Signal<T[]>` or a function returning `T[]`.
 * @param mapFn The mapping function. Receives the item and its index as a Signal.
 * @param options Optional configuration:
 *  - `onDestroy`: A callback invoked when a mapped item is removed from the array.
 * @returns A `Signal<U[]>` containing the mapped array.
 */
export function keyArray<T, U, K>(
  source: Signal<T[]> | (() => T[]),
  mapFn: (v: T, i: Signal<number>) => U,
  options: {
    onDestroy?: (value: U) => void;
    /**
     * Optional function to use a custom key for item comparison.
     * Use this if you want to reuse mapped items based on a property (like an ID)
     * even if the item reference changes.
     */
    key?: (item: T) => K;
  } = {},
): Signal<U[]> {
  const sourceSignal = isSignal(source) ? source : computed(source);

  const items: T[] = [];
  let mapped: U[] = [];
  const indexes: WritableSignal<number>[] = [];
  const getKey = options.key || ((v) => v as unknown as K);

  const newIndices = new Map<K, number>();
  const temp: U[] = [];
  const tempIndexes: WritableSignal<number>[] = [];
  const newIndicesNext: number[] = [];

  const newIndexesCache = new Array<WritableSignal<number>>();

  return computed(() => {
    const newItems = sourceSignal() || [];

    return untracked(() => {
      let i: number;
      let j: number;
      const newLen = newItems.length;
      let len = items.length;
      const newMapped = new Array<U>(newLen);
      const newIndexes = newIndexesCache;
      newIndexes.length = 0;
      newIndexes.length = newLen;

      let start: number;
      let end: number;
      let newEnd: number;
      let item: T;
      let key: any;

      if (newLen === 0) {
        if (len !== 0) {
          if (options.onDestroy) {
            for (let k = 0; k < len; k++) options.onDestroy(mapped[k]);
          }
          items.length = 0;
          mapped = [];
          indexes.length = 0;
        }
        return mapped;
      }

      // Fast path for new create (init)
      if (len === 0) {
        for (j = 0; j < newLen; j++) {
          item = newItems[j];
          items[j] = item;
          const indexSignal = signal(j);
          newIndexes[j] = indexSignal;
          newMapped[j] = mapFn(item, indexSignal);
        }
      } else {
        newIndices.clear();
        temp.length = 0;
        tempIndexes.length = 0;
        newIndicesNext.length = 0;

        // Skip common prefix
        for (
          start = 0, end = Math.min(len, newLen);
          start < end && getKey(items[start]) === getKey(newItems[start]);
          start++
        ) {
          newMapped[start] = mapped[start];
          newIndexes[start] = indexes[start];
        }

        // Common suffix
        for (
          end = len - 1, newEnd = newLen - 1;
          end >= start &&
          newEnd >= start &&
          getKey(items[end]) === getKey(newItems[newEnd]);
          end--, newEnd--
        ) {
          temp[newEnd] = mapped[end];
          tempIndexes[newEnd] = indexes[end];
        }

        // 0) Prepare a map of all indices in newItems, scanning backwards
        for (j = newEnd; j >= start; j--) {
          item = newItems[j];
          key = getKey(item);
          i = newIndices.get(key)!;
          newIndicesNext[j] = i === undefined ? -1 : i;
          newIndices.set(key, j);
        }

        // 1) Step through old items: check if they are in new set
        for (i = start; i <= end; i++) {
          item = items[i];
          key = getKey(item);
          j = newIndices.get(key)!;
          if (j !== undefined && j !== -1) {
            temp[j] = mapped[i];
            tempIndexes[j] = indexes[i];
            j = newIndicesNext[j];
            newIndices.set(key, j);
          } else {
            if (options.onDestroy) options.onDestroy(mapped[i]);
          }
        }

        // 2) Set all new values
        for (j = start; j < newLen; j++) {
          if (j in temp) {
            newMapped[j] = temp[j];
            newIndexes[j] = tempIndexes[j];
            untracked(() => newIndexes[j].set(j)); // Update index signal
          } else {
            const indexSignal = signal(j);
            newIndexes[j] = indexSignal;
            newMapped[j] = mapFn(newItems[j], indexSignal);
          }
        }

        // 4) Save items for next update
        items.length = newLen;
        for (let k = 0; k < newLen; k++) items[k] = newItems[k];
      }

      mapped = newMapped;

      indexes.length = newLen;
      for (let k = 0; k < newLen; k++) indexes[k] = newIndexes[k];

      return mapped;
    });
  });
}
