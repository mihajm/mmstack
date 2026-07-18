import {
  computed,
  isSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/**
 * Opt-in policy describing how `keyArray` should treat duplicate keys.
 *
 * With the `'ordinal'` policy, keys are coerced to strings and disambiguated by
 * their occurrence order: the first item with a given base key keeps `base`, the
 * second becomes `base#1`, the third `base#2`, and so on. Each duplicate therefore
 * gets a stable, distinct entry instead of collapsing.
 *
 * Identity follows position-among-duplicates: removing an earlier occurrence
 * promotes the next one to the base key, which changes its effective key and thus
 * re-creates its mapped entry.
 */
export type DuplicateKeyPolicy = {
  /** Disambiguation strategy. Currently only ordinal (`base`, `base#1`, `base#2`, ...). */
  policy: 'ordinal';
  /**
   * Optional diagnostics side-channel. When a recompute observes duplicate keys,
   * this is invoked once with the duplicate base keys in first-occurrence order.
   * It is called untracked and must not be relied upon to create reactive dependencies.
   */
  report?: (bases: readonly string[]) => void;
};

function effectiveKeys<T, K>(
  arr: readonly T[],
  getKey: (item: T) => K,
  report?: (bases: readonly string[]) => void,
): string[] {
  const out = new Array<string>(arr.length);
  const counts = new Map<string, number>();
  const firstOrder: string[] = [];
  let duped: Set<string> | null = null;

  for (let i = 0; i < arr.length; i++) {
    const base = String(getKey(arr[i]));
    const seen = counts.get(base) ?? 0;
    if (seen === 0) {
      firstOrder.push(base);
    } else {
      (duped ??= new Set<string>()).add(base);
    }
    out[i] = seen === 0 ? base : base + '#' + seen;
    counts.set(base, seen + 1);
  }

  if (report && duped) {
    const bases = firstOrder.filter((b) => duped.has(b));
    untracked(() => report(bases));
  }

  return out;
}

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
 *  - `key`: A custom key extractor for identity matching (e.g. `(item) => item.id`)
 *    when item references change but conceptual identity is preserved.
 *  - `duplicateKeys`: Opt-in policy for handling duplicate keys. When omitted,
 *    behavior is unchanged (duplicates collapse). See {@link DuplicateKeyPolicy}.
 * @returns A `Signal<U[]>` containing the mapped array.
 *
 * @example
 * ```ts
 * const users = signal([
 *   { id: 1, name: 'Alice' },
 *   { id: 2, name: 'Bob' },
 * ]);
 *
 * const rows = keyArray(
 *   users,
 *   (user, index) => ({
 *     label: computed(() => `#${index()} ${user.name}`),
 *     id: user.id,
 *   }),
 *   { key: (u) => u.id },
 * );
 *
 * // Reordering users() rebuilds index signals only — `rows` entries
 * // are matched by id and reused, not re-created.
 * users.set([users()[1], users()[0]]);
 * ```
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
    /**
     * Opt-in policy for disambiguating duplicate keys. When present, keys are
     * coerced to strings and duplicates get distinct ordinal effective keys
     * (`base`, `base#1`, `base#2`, ...). When absent, behavior is unchanged.
     */
    duplicateKeys?: DuplicateKeyPolicy;
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

  const dup = options.duplicateKeys;

  return computed(() => {
    const newItems = sourceSignal() || [];

    return untracked(() => {
      const newKeys = dup ? effectiveKeys(newItems, getKey, dup.report) : null;
      let i: number;
      let j: number;
      const newLen = newItems.length;
      const len = items.length;
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

        const oldKeys = dup ? effectiveKeys(items, getKey) : null;
        const kNew = newKeys
          ? (idx: number) => newKeys[idx]
          : (idx: number) => getKey(newItems[idx]);
        const kOld = oldKeys
          ? (idx: number) => oldKeys[idx]
          : (idx: number) => getKey(items[idx]);

        for (
          start = 0, end = Math.min(len, newLen);
          start < end && kOld(start) === kNew(start);
          start++
        ) {
          newMapped[start] = mapped[start];
          newIndexes[start] = indexes[start];
        }

        for (
          end = len - 1, newEnd = newLen - 1;
          end >= start && newEnd >= start && kOld(end) === kNew(newEnd);
          end--, newEnd--
        ) {
          temp[newEnd] = mapped[end];
          tempIndexes[newEnd] = indexes[end];
        }

        for (j = newEnd; j >= start; j--) {
          key = kNew(j);
          i = newIndices.get(key) ?? -1;
          newIndicesNext[j] = i === undefined ? -1 : i;
          newIndices.set(key, j);
        }

        for (i = start; i <= end; i++) {
          key = kOld(i);
          j = newIndices.get(key) ?? -1;
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
          if (temp[j] !== undefined) {
            newMapped[j] = temp[j];
            newIndexes[j] = tempIndexes[j];
            newIndexes[j].set(j);
          } else {
            const indexSignal = signal(j);
            newIndexes[j] = indexSignal;
            newMapped[j] = mapFn(newItems[j], indexSignal);
          }
        }

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
