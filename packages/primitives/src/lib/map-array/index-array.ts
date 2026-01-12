import {
  computed,
  type CreateSignalOptions,
  isSignal,
  linkedSignal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from '../derived';
import { isMutable, type MutableSignal } from '../mutable';
import { toWritable } from '../to-writable';
import { createSetter } from './create-setter';
import { isWritableSignal } from './is-writable';

/**
 * Helper to create the derived signal for a specific index.
 * Extracts the cast logic to keep the main loop clean.
 */
function createItemSignal<T>(
  source: WritableSignal<T[]>,
  index: number,
  setter: (v: T, i: number) => void,
  opt: CreateSignalOptions<T>,
) {
  return derived(
    // We cast to any/Mutable to satisfy the overload signature,
    // but 'derived' internally checks isMutable() for safety.
    source as MutableSignal<T[]>,
    {
      from: (src) => src[index],
      onChange: (value) => setter(value, index),
    },
    opt,
  );
}

/**
 * Reactively maps items from a source array to a new array, creating stable signals for each item.
 *
 * This function is highly optimized for performance, similar to SolidJS's `mapArray`.
 * For each item in the source array, it creates a stable signal that is passed to the mapping function.
 * This ensures that downstream consumers only re-evaluate for items that have actually changed,
 * or when items are added or removed from the list.
 *
 * The type of signal passed to the `map` function depends on the source:
 * - **Readonly `Signal`**: `map` receives a readonly `Signal<T>`.
 * - **`WritableSignal`**: `map` receives a `WritableSignal<T>`, allowing two-way binding.
 * - **`MutableSignal`**: `map` receives a `MutableSignal<T>`, allowing in-place mutation for performance.
 *
 * @template T The type of items in the source array.
 * @template U The type of items in the resulting mapped array.
 *
 * @param source A `Signal<T[]>` or a function returning `T[]`.
 * @param map The mapping function. It receives a stable signal for the item and its index.
 * @param options Optional configuration, including `CreateSignalOptions` for the item signals
 * (e.g., a custom `equal` function) and an `onDestroy` callback for cleanup.
 * @returns A `Signal<U[]>` containing the mapped array.
 *
 * @example
 * // Writable example
 * const sourceItems = signal([
 * { id: 1, name: 'Apple' },
 * { id: 2, name: 'Banana' }
 * ]);
 *
 * // The `itemSignal` is writable because `sourceItems` is a WritableSignal.
 * const mappedItems = indexArray(sourceItems, (itemSignal, index) => ({
 * label: computed(() => `${index}: ${itemSignal().name.toUpperCase()}`),
 * setName: (newName: string) => itemSignal.update(item => ({ ...item, name: newName }))
 * }));
 *
 * // This will update the original source signal.
 * mappedItems()[0].setName('Avocado');
 * // sourceItems() is now: [{ id: 1, name: 'Avocado' }, { id: 2, name: 'Banana' }]
 */
export function indexArray<T, U>(
  source: MutableSignal<T[]>,
  map: (value: MutableSignal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function indexArray<T, U>(
  source: WritableSignal<T[]>,
  map: (value: WritableSignal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function indexArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  map: (value: Signal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function indexArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  map:
    | ((value: Signal<T>, index: number) => U)
    | ((value: WritableSignal<T>, index: number) => U)
    | ((value: MutableSignal<T>, index: number) => U),
  opt: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  } = {},
): Signal<U[]> {
  const data = isSignal(source) ? source : computed(source);
  const len = computed(() => data().length);

  const setter = createSetter(data);

  const writableData = isWritableSignal(data)
    ? data
    : toWritable(data, () => {
        // noop
      });

  if (isWritableSignal(data) && isMutable(data) && !opt.equal) {
    opt.equal = (a: T, b: T) => {
      if (a !== b) return false; // actually check primitives and references
      return false; // opt out for same refs
    };
  }

  return linkedSignal<number, U[]>({
    source: () => len(),
    computation: (len, prev) => {
      if (!prev)
        return Array.from({ length: len }, (_, i) =>
          map(createItemSignal(writableData, i, setter, opt), i),
        );

      if (len === prev.value.length) return prev.value;

      if (len < prev.value.length) {
        if (opt.onDestroy) prev.value.forEach((v) => opt.onDestroy?.(v));

        return prev.value.slice(0, len);
      }

      const next = prev.value.slice();

      for (let i = prev.value.length; i < len; i++)
        next[i] = map(createItemSignal(writableData, i, setter, opt), i);

      return next;
    },
    equal: (a, b) => a.length === b.length,
  });
}

/**
 * @deprecated use indexArray instead
 */
export const mapArray = indexArray;
