import {
  computed,
  type CreateSignalOptions,
  isSignal,
  linkedSignal,
  type Signal,
} from '@angular/core';

/**
 * Reactively maps items from a source array (or signal of an array) using a provided mapping function.
 *
 * This function serves a similar purpose to SolidJS's `mapArray` by providing stability
 * for mapped items. It receives a source function returning an array (or a Signal<T[]>)
 * and a mapping function.
 *
 * For each item in the source array, it creates a stable `computed` signal representing
 * that item's value at its current index. This stable signal (`Signal<T>`) is passed
 * to the mapping function. This ensures that downstream computations or components
 * depending on the mapped result only re-render or re-calculate for the specific items
 * that have changed, or when items are added/removed, rather than re-evaluating everything
 * when the source array reference changes but items remain the same.
 *
 * It efficiently handles changes in the source array's length by reusing existing mapped
 * results when possible, slicing when the array shrinks, and appending new mapped items
 * when it grows.
 *
 * @template T The type of items in the source array.
 * @template U The type of items in the resulting mapped array.
 *
 * @param source A function returning the source array `T[]`, or a `Signal<T[]>` itself.
 * The `mapArray` function will reactively update based on changes to this source.
 * @param map The mapping function. It is called for each item in the source array.
 * It receives:
 * - `value`: A stable `Signal<T>` representing the item at the current index.
 * Use this signal within your mapping logic if you need reactivity
 * tied to the specific item's value changes.
 * - `index`: The number index of the item in the array.
 * It should return the mapped value `U`.
 * @param [opt] Optional `CreateSignalOptions<T>`. These options are passed directly
 * to the `computed` signal created for each individual item (`Signal<T>`).
 * This allows specifying options like a custom `equal` function for item comparison.
 *
 * @returns A `Signal<U[]>` containing the mapped array. This signal updates whenever
 * the source array changes (either length or the values of its items).
 *
 * @example
 * ```ts
 * const sourceItems = signal([
 * { id: 1, name: 'Apple' },
 * { id: 2, name: 'Banana' }
 * ]);
 *
 * const mappedItems = mapArray(
 * sourceItems,
 * (itemSignal, index) => {
 * // itemSignal is stable for a given item based on its index.
 * // We create a computed here to react to changes in the item's name.
 *  return computed(() => `${index}: ${itemSignal().name.toUpperCase()}`);
 * },
 * // Example optional options (e.g., custom equality for item signals)
 * { equal: (a, b) => a.id === b.id && a.name === b.name }
 * );
 * ```
 * @remarks
 * This function achieves its high performance by leveraging the new `linkedSignal`
 * API from Angular, which allows for efficient memoization and reuse of array items.
 */
export function mapArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  map: (value: Signal<T>, index: number) => U,
  opt?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]> {
  const data = isSignal(source) ? source : computed(source);
  const len = computed(() => data().length);

  return linkedSignal<number, U[]>({
    source: () => len(),
    computation: (len, prev) => {
      if (!prev)
        return Array.from({ length: len }, (_, i) =>
          map(
            computed(() => data()[i], opt),
            i,
          ),
        );

      if (len === prev.value.length) return prev.value;

      if (len < prev.value.length) {
        const slice = prev.value.slice(0, len);

        if (opt?.onDestroy) {
          for (let i = len; i < prev.value.length; i++) {
            opt.onDestroy?.(prev.value[i]);
          }
        }

        return slice;
      } else {
        const next = [...prev.value];
        for (let i = prev.value.length; i < len; i++) {
          next[i] = map(
            computed(() => source()[i], opt),
            i,
          );
        }
        return next;
      }
    },
    equal: (a, b) => a.length === b.length,
  });
}
