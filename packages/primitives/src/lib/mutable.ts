import {
  signal,
  type CreateSignalOptions,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';

const { is } = Object;

/**
 * A `MutableSignal` is a special type of `WritableSignal` that allows for in-place mutation of its value.
 * In addition to the standard `set` and `update` methods, it provides a `mutate` method.  This is useful
 * for performance optimization when dealing with complex objects or arrays, as it avoids unnecessary
 * object copying.
 *
 * @typeParam T - The type of value held by the signal.
 */
export type MutableSignal<T> = WritableSignal<T> & {
  /**
   * Mutates the signal's value in-place.  This is similar to `update`, but it's optimized for
   * scenarios where you want to modify the existing object directly rather than creating a new one.
   *
   * @param updater - A function that takes the current value as input and modifies it directly.
   *
   * @example
   * const myArray = mutable([1, 2, 3]);
   * myArray.mutate((arr) => {
   *  arr.push(4);
   *  return arr;
   * }); // myArray() now returns [1, 2, 3, 4]
   */
  mutate: WritableSignal<T>['update'];

  /**
   * Mutates the signal's value in-place, similar to `mutate`, but with a void-returning value in updater
   * function. This further emphasizes that the mutation is happening inline, improving readability
   * in some cases.
   * @param updater - Function to change to the current value
   * @example
   * const myObject = mutable({ a: 1, b: 2 });
   * myObject.inline((obj) => (obj.a = 3)); // myObject() now returns { a: 3, b: 2 }
   */
  inline: (updater: (value: T) => void) => void;
};

/**
 * Creates a `MutableSignal`. This function overloads the standard `signal` function to provide
 * the additional `mutate` and `inline` methods.
 *
 * @typeParam T The type of value held by the signal.
 * @param initial The initial value of the signal.
 * @param options Optional signal options, including a custom `equal` function.
 * @returns A `MutableSignal` instance.
 *
 * ### Important Note on `computed` Signals
 *
 * When creating a `computed` signal that derives a non-primitive value (e.g., an object or array)
 * from a `mutable` signal, you **must** provide the `{ equal: false }` option to the `computed`
 * function.
 *
 * This is because a `.mutate()` call notifies its dependents that it has changed, but if the
 * reference to a derived object hasn't changed, the `computed` signal will not trigger its
 * own dependents by default.
 *
 * @example
 * ```ts
 * const state = mutable({ user: { name: 'John' }, lastUpdated: new Date() });
 *
 * // ✅ CORRECT: Deriving a primitive value works as expected.
 * const name = computed(() => state().user.name);
 *
 * // ❌ INCORRECT: This will not update reliably after the first change.
 * const userObject = computed(() => state().user);
 *
 * // ✅ CORRECT: For object derivations, `equal: false` is required.
 * const userObjectFixed = computed(() => state().user, { equal: false });
 *
 * // This mutation will now correctly trigger effects depending on `userObjectFixed`.
 * state.mutate(s => s.lastUpdated = new Date());
 * ```
 */
export function mutable<T>(): MutableSignal<T | undefined>;
export function mutable<T>(initial: T): MutableSignal<T>;
export function mutable<T>(
  initial: T,
  opt?: CreateSignalOptions<T>,
): MutableSignal<T>;

export function mutable<T>(
  initial?: T,
  opt?: CreateSignalOptions<T>,
): MutableSignal<T> {
  const baseEqual = opt?.equal ?? is;
  let trigger = false;

  const equal: ValueEqualityFn<T | undefined> = (a, b) => {
    if (trigger) return false;
    return baseEqual(a, b);
  };

  const sig = signal<T | undefined>(initial, {
    ...opt,
    equal,
  }) as MutableSignal<T>;

  const internalUpdate = sig.update;

  sig.mutate = (updater) => {
    trigger = true;
    internalUpdate(updater);
    trigger = false;
  };

  sig.inline = (updater) => {
    sig.mutate((prev) => {
      updater(prev);
      return prev;
    });
  };

  return sig;
}

/**
 * Type guard function to check if a given `WritableSignal` is a `MutableSignal`.  This is useful
 * for situations where you need to conditionally use the `mutate` or `inline` methods.
 *
 * @typeParam T - The type of the signal's value (optional, defaults to `any`).
 * @param value - The `WritableSignal` to check.
 * @returns `true` if the signal is a `MutableSignal`, `false` otherwise.
 *
 * @example
 * const mySignal = signal(0);
 * const myMutableSignal = mutable(0);
 *
 * if (isMutable(mySignal)) {
 *   mySignal.mutate(x => x + 1); // This would cause a type error, as mySignal is not a MutableSignal.
 * }
 *
 * if (isMutable(myMutableSignal)) {
 *   myMutableSignal.mutate(x => x + 1); // This is safe.
 * }
 */
export function isMutable<T = any>(
  value: WritableSignal<T>,
): value is MutableSignal<T> {
  return 'mutate' in value && typeof value.mutate === 'function';
}
