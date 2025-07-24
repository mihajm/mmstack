import {
  computed,
  CreateSignalOptions,
  signal,
  untracked,
  ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';
import { isMutable, MutableSignal } from './mutable';
import { toWritable } from './to-writable';

type UnknownObject = Record<PropertyKey, unknown>;

/**
 * Options for creating a derived signal using the full `derived` function signature.
 * @typeParam T - The type of the source signal's value (parent).
 * @typeParam U - The type of the derived signal's value (child).
 */
type CreateDerivedOptions<T, U> = CreateSignalOptions<U> & {
  /**
   * A function that extracts the derived value (`U`) from the source signal's value (`T`).
   */
  from: (v: T) => U;
  /**
   * A function that updates the source signal's value (`T`) when the derived signal's value (`U`) changes.
   * This establishes the two-way binding.
   */
  onChange: (newValue: U) => void;
};

/**
 * A `WritableSignal` that derives its value from another `WritableSignal` (the "source" signal).
 * It provides two-way binding: changes to the source signal update the derived signal, and
 * changes to the derived signal update the source signal.
 *
 * @typeParam T - The type of the source signal's value (parent).
 * @typeParam U - The type of the derived signal's value (child).
 */
export type DerivedSignal<T, U> = WritableSignal<U> & {
  /**
   * The function used to derive the derived signal's value from the source signal's value.
   * This is primarily for internal use and introspection.
   */
  from: (v: T) => U;
};

/**
 * Creates a `DerivedSignal` that derives its value from another `WritableSignal`.
 * This overload provides the most flexibility, allowing you to specify custom `from` and `onChange` functions.
 *
 * @typeParam T The type of the source signal's value.
 * @typeParam U The type of the derived signal's value.
 * @param source The source `WritableSignal`.
 * @param options An object containing the `from` and `onChange` functions, and optional signal options.
 * @returns A `DerivedSignal` instance.
 *
 * @example
 * ```ts
 * const user = signal({ name: 'John', age: 30 });
 * const name = derived(user, {
 * from: (u) => u.name,
 * onChange: (newName) => user.update((u) => ({ ...u, name: newName })),
 * });
 *
 * name.set('Jane'); // Updates the original signal
 * console.log(user().name); // Outputs: Jane
 * ```
 */
export function derived<T, U>(
  source: WritableSignal<T>,
  opt: CreateDerivedOptions<T, U>,
): DerivedSignal<T, U>;

/**
 * Creates a `DerivedSignal` that derives a property from an object held by the source signal.
 * This overload is a convenient shorthand for accessing object properties.
 *
 * @typeParam T The type of the source signal's value (must be an object).
 * @typeParam TKey The key of the property to derive.
 * @param source The source `WritableSignal` (holding an object).
 * @param key The key of the property to derive.
 * @param options Optional signal options for the derived signal.
 * @returns A `DerivedSignal` instance.
 *
 * @example
 * ```ts
 * const user = signal({ name: 'John', age: 30 });
 * const name = derived(user, 'name');
 *
 * console.log(name()); // Outputs: John
 *
 * // Update the derived signal, which also updates the source
 * name.set('Jane');
 *
 * console.log(user().name); // Outputs: Jane
 * ```
 */
export function derived<T extends UnknownObject, TKey extends keyof T>(
  source: WritableSignal<T>,
  key: TKey,
  opt?: CreateSignalOptions<T[TKey]>,
): DerivedSignal<T, T[TKey]>;

/**
 * Creates a `DerivedSignal` from an array, deriving an element by its index.
 * This overload is a convenient shorthand for accessing array elements.
 *
 * @typeParam T The type of the source signal's value (must be an array).
 * @param source The source `WritableSignal` (holding an array).
 * @param index The index of the element to derive.
 * @param options Optional signal options for the derived signal.
 * @returns A `DerivedSignal` instance.
 *
 * @example
 * ```ts
 * const numbers = signal([1, 2, 3]);
 * const secondNumber = derived(numbers, 1);
 *
 * console.log(secondNumber()); // Outputs: 2
 *
 * // Update the derived signal, which also updates the source
 * secondNumber.set(5);
 *
 * console.log(numbers()); // Outputs: [1, 5, 3]
 * ```
 */
export function derived<T extends any[]>(
  source: WritableSignal<T>,
  index: number,
  opt?: CreateSignalOptions<T[number]>,
): DerivedSignal<T, T[number]>;

/**
 * Creates a `DerivedSignal` that derives its value from another `MutableSignal`.
 * Use mutuable signals with caution, but very useful for deeply nested structures.
 *
 * @typeParam T The type of the source signal's value.
 * @typeParam U The type of the derived signal's value.
 * @param source The source `WritableSignal`.
 * @param options An object containing the `from` and `onChange` functions, and optional signal options.
 * @returns A `DerivedSignal & MutableSignal` instance.
 *
 * @example
 * ```ts
 * const user = signal({ name: 'John', age: 30 });
 * const name = derived(user, {
 * from: (u) => u.name,
 * onChange: (newName) => user.update((u) => ({ ...u, name: newName })),
 * });
 *
 * name.set('Jane'); // Updates the original signal
 * console.log(user().name); // Outputs: Jane
 * ```
 */
export function derived<T, U>(
  source: MutableSignal<T>,
  optOrKey: CreateDerivedOptions<T, U> | keyof T,
  opt?: CreateSignalOptions<U>,
): DerivedSignal<T, U> & MutableSignal<U>;

export function derived<T, U>(
  source: WritableSignal<T> | MutableSignal<T>,
  optOrKey: CreateDerivedOptions<T, U> | keyof T,
  opt?: CreateSignalOptions<U>,
): DerivedSignal<T, U> | (DerivedSignal<T, U> & MutableSignal<U>) {
  const isArray =
    Array.isArray(untracked(source)) && typeof optOrKey === 'number';

  const from =
    typeof optOrKey === 'object' ? optOrKey.from : (v: T) => v[optOrKey] as U;

  const onChange =
    typeof optOrKey === 'object'
      ? optOrKey.onChange
      : isArray
        ? isMutable(source)
          ? (next: U) => {
              source.mutate((cur) => {
                (cur as any[])[optOrKey] = next;
                return cur as T;
              });
            }
          : (next: U) => {
              source.update((cur) => {
                const newArray = [...(cur as unknown as any[])];
                newArray[optOrKey] = next;
                return newArray as T;
              });
            }
        : isMutable(source)
          ? (next: U) => {
              source.mutate((cur) => {
                (cur as UnknownObject)[optOrKey] = next as T[keyof T];
                return cur;
              });
            }
          : (next: U) => {
              source.update((cur) => ({ ...cur, [optOrKey]: next }));
            };

  const rest = typeof optOrKey === 'object' ? optOrKey : opt;

  let baseEqual = rest?.equal ?? Object.is;
  let trigger = false;

  const equal: ValueEqualityFn<U> = isMutable(source)
    ? (a: U, b: U) => {
        if (trigger) return false;
        return baseEqual(a, b);
      }
    : baseEqual;

  const sig = toWritable<U>(
    computed(() => from(source()), { ...rest, equal }),
    (newVal) => onChange(newVal),
  ) as DerivedSignal<T, U> & MutableSignal<U>;

  sig.from = from;

  if (isMutable(source)) {
    sig.mutate = (updater) => {
      trigger = true;
      sig.update(updater);
      trigger = false;
    };

    sig.inline = (updater) => {
      sig.mutate((prev) => {
        updater(prev);
        return prev;
      });
    };
  }

  return sig;
}

/**
 * Creates a "fake" `DerivedSignal` from a simple value. This is useful for creating
 * `FormControlSignal` instances that are not directly derived from another signal.
 * The returned signal's `from` function will always return the initial value.
 *
 * @typeParam T -  This type parameter is not used in the implementation but is kept for type compatibility with `DerivedSignal`.
 * @typeParam U - The type of the signal's value.
 * @param initial - The initial value of the signal.
 * @returns A `DerivedSignal` instance.
 * @internal
 */
export function toFakeDerivation<T, U>(initial: U): DerivedSignal<T, U> {
  const sig = signal(initial) as DerivedSignal<T, U>;
  sig.from = () => initial;

  return sig;
}

/**
 * Creates a "fake" `DerivedSignal` from an existing `WritableSignal`. This is useful
 * for treating a regular `WritableSignal` as a `DerivedSignal` without changing its behavior.
 *  The returned signal's `from` function returns the current value of signal, using `untracked`.
 *
 * @typeParam T - This type parameter is not used in the implementation but is kept for type compatibility with `DerivedSignal`.
 * @typeParam U - The type of the signal's value.
 * @param initial - The existing `WritableSignal`.
 * @returns A `DerivedSignal` instance.
 * @internal
 */
export function toFakeSignalDerivation<T, U>(
  initial: WritableSignal<U>,
): DerivedSignal<T, U> {
  const sig = initial as DerivedSignal<T, U>;
  sig.from = () => untracked(initial);
  return sig;
}

/**
 * Type guard function to check if a given `WritableSignal` is a `DerivedSignal`.
 *
 * @typeParam T - The type of the source signal's value (optional, defaults to `any`).
 * @typeParam U - The type of the derived signal's value (optional, defaults to `any`).
 * @param sig - The `WritableSignal` to check.
 * @returns `true` if the signal is a `DerivedSignal`, `false` otherwise.
 */
export function isDerivation<T, U>(
  sig: WritableSignal<U>,
): sig is DerivedSignal<T, U> {
  return 'from' in sig;
}
