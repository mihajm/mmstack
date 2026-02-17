import {
  computed,
  type CreateSignalOptions,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';

/**
 * Converts a read-only `Signal` into a `WritableSignal` by providing custom `set` and, optionally, `update` functions.
 * This can be useful for creating controlled write access to a signal that is otherwise read-only.
 *
 * @typeParam T - The type of value held by the signal.
 *
 * @param signal - The read-only `Signal` to be made writable.
 * @param set - A function that will be used to set the signal's value.  This function *must* handle
 *              the actual update mechanism (e.g., updating a backing store, emitting an event, etc.).
 * @param update - (Optional) A function that will be used to update the signal's value based on its
 *                 previous value.  If not provided, a default `update` implementation is used that
 *                 calls the provided `set` function with the result of the updater function. The
 *                 default implementation uses `untracked` to avoid creating unnecessary dependencies
 *                 within the updater function.
 *
 * @returns A `WritableSignal` that uses the provided `set` and `update` functions.  The `asReadonly`
 *          method of the returned signal will still return the original read-only signal.
 *
 * @example
 * // Basic usage: Making a read-only signal writable with a custom set function.
 * const originalValue = signal({a: 0});
 * const readOnlySignal = computed(() => originalValue().a);
 * const writableSignal = toWritable(readOnlySignal, (newValue) => {
 *  originalValue.update((prev) => { ...prev, a: newValue });
 * });
 *
 * writableSignal.set(5); // sets value of originalValue.a to 5 & triggers all signals
 */
export function toWritable<T>(
  source: Signal<T>,
  set: (value: T) => void,
  update?: (updater: (value: T) => T) => void,
  opt?: CreateSignalOptions<T> & {
    /**
     * If `true` (the default), the returned signal will be a computed signal that depends on the source signal.
     * If `false`, the returned signal will be a direct wrapper around the source signal without creating a new computed signal.
     * @default true
     */
    pure?: boolean;
  },
): WritableSignal<T> {
  const internal = (
    opt?.pure !== false ? computed(source) : source
  ) as WritableSignal<T>;
  internal.asReadonly = () => source;
  internal.set = set;
  internal.update = update ?? ((updater) => set(updater(untracked(internal))));

  return internal;
}
