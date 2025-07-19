import {
  computed,
  type CreateSignalOptions,
  isSignal,
  linkedSignal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from './derived';
import { isMutable, MutableSignal } from './mutable';
import { toWritable } from './to-writable';

/**
 * @internal
 * Checks if a signal is a WritableSignal.
 * @param sig The signal to check.
 */
function isWritable<T>(sig: Signal<T>): sig is WritableSignal<T> {
  // We just need to check for the presence of a 'set' method.
  return 'set' in sig;
}

/**
 * @internal
 * Creates a setter function for a source signal of type `Signal<T[]>` or a function returning `T[]`.
 * @param source The source signal of type `Signal<T[]>` or a function returning `T[]`.
 * @returns
 */
function createSetter<T>(
  source: Signal<T[]>,
): (value: T, index: number) => void {
  if (!isWritable(source))
    return () => {
      // noop;
    };

  if (isMutable(source))
    return (value, index) => {
      source.inline((arr) => {
        arr[index] = value;
      });
    };

  return (value, index) => {
    source.update((arr) => arr.map((v, i) => (i === index ? value : v)));
  };
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
 * const mappedItems = mapArray(sourceItems, (itemSignal, index) => ({
 * label: computed(() => `${index}: ${itemSignal().name.toUpperCase()}`),
 * setName: (newName: string) => itemSignal.update(item => ({ ...item, name: newName }))
 * }));
 *
 * // This will update the original source signal.
 * mappedItems()[0].setName('Avocado');
 * // sourceItems() is now: [{ id: 1, name: 'Avocado' }, { id: 2, name: 'Banana' }]
 */
export function mapArray<T, U>(
  source: MutableSignal<T[]>,
  map: (value: MutableSignal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function mapArray<T, U>(
  source: WritableSignal<T[]>,
  map: (value: WritableSignal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function mapArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  map: (value: Signal<T>, index: number) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function mapArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  map:
    | ((value: Signal<T>, index: number) => U)
    | ((value: WritableSignal<T>, index: number) => U)
    | ((value: MutableSignal<T>, index: number) => U),
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]> {
  const data = isSignal(source) ? source : computed(source);
  const len = computed(() => data().length);

  const setter = createSetter(data);

  const opt = { ...options };

  const writableData = isWritable(data)
    ? data
    : toWritable(data, () => {
        // noop
      });

  if (isWritable(data) && isMutable(data) && !opt.equal) {
    opt.equal = (a: T, b: T) => {
      if (a !== b) return false; // actually check primitives and references
      return false; // opt out for same refs
    };
  }

  return linkedSignal<number, U[]>({
    source: () => len(),
    computation: (len, prev) => {
      if (!prev)
        return Array.from({ length: len }, (_, i) => {
          const derivation = derived(
            writableData as MutableSignal<T[]>, // typcase to largest type
            {
              from: (src) => src[i],
              onChange: (value) => setter(value, i),
            },
            opt,
          );

          return map(derivation, i);
        });

      if (len === prev.value.length) return prev.value;

      if (len < prev.value.length) {
        const slice = prev.value.slice(0, len);

        if (opt.onDestroy) {
          for (let i = len; i < prev.value.length; i++) {
            opt.onDestroy?.(prev.value[i]);
          }
        }

        return slice;
      } else {
        const next = [...prev.value];
        for (let i = prev.value.length; i < len; i++) {
          const derivation = derived(
            writableData as MutableSignal<T[]>, // typcase to largest type
            {
              from: (src) => src[i],
              onChange: (value) => setter(value, i),
            },
            opt,
          );
          next[i] = map(derivation, i);
        }
        return next;
      }
    },
    equal: (a, b) => a.length === b.length,
  });
}
