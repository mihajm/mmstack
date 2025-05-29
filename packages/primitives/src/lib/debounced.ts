import {
  computed,
  type CreateSignalOptions,
  DestroyRef,
  inject,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { toWritable } from './to-writable';

/**
 * Options for creating a debounced writable signal.
 * Extends Angular's `CreateSignalOptions` with a debounce time setting.
 *
 * @template T The type of value held by the signal.
 */
export type CreateDebouncedOptions<T> = CreateSignalOptions<T> & {
  /**
   * The debounce delay in milliseconds. Specifies how long to wait after the
   * last `set` or `update` call before the debounced signal reflects the new value.
   */
  ms?: number;
  /**
   * Optional `DestroyRef` to clean up the debounce timer when the signal is destroyed.
   * If provided, the timer will be cleared when the signal is destroyed.
   * If the signal is called within a reactive context a DestroyRef is injected automatically.
   * If it is not provided or injected, the timer will not be cleared automatically...which is usually fine :)
   */
  destroyRef?: DestroyRef;
};

/**
 * A specialized `WritableSignal` whose publicly readable value updates are debounced.
 *
 * It provides access to the underlying, non-debounced signal via the `original` property.
 *
 * @template T The type of value held by the signal.
 */
export type DebouncedSignal<T> = WritableSignal<T> & {
  /**
   * A reference to the original, inner `WritableSignal`.
   * This signal's value is updated *immediately* upon calls to `set` or `update`
   * on the parent `DebouncedSignal`. Useful for accessing the latest value
   * without the debounce delay.
   */
  original: Signal<T>;
};

/**
 * A convenience function that creates and debounces a new `WritableSignal` in one step.
 *
 * @see {debounce} for the core implementation details.
 *
 * @template T The type of value the signal holds.
 * @param initial The initial value of the signal.
 * @param opt Options for signal creation, including debounce time `ms`.
 * @returns A `DebouncedSignal<T>` instance.
 *
 * @example
 * // The existing example remains perfect here.
 * const query = debounced('', { ms: 500 });
 * effect(() => console.log('Debounced Query:', query()));
 * query.set('abc');
 * // ...500ms later...
 * // Output: Debounced Query: abc
 */
export function debounced<T>(
  initial: T,
  opt?: CreateDebouncedOptions<T>,
): DebouncedSignal<T> {
  return debounce(signal(initial, opt), opt);
}

/**
 * Wraps an existing `WritableSignal` to create a new one whose readable value is debounced.
 *
 * This implementation avoids using `effect` by pairing a trigger signal with an `untracked`
 * read of the source signal to control when the debounced value is re-evaluated.
 *
 * @template T The type of value the signal holds.
 * @param source The source `WritableSignal` to wrap. Writes are applied to this signal immediately.
 * @param opt Options for debouncing, including debounce time `ms` and an optional `DestroyRef`.
 * @returns A new `DebouncedSignal<T>` whose read value is debounced. The `.original` property
 * of the returned signal is a reference back to the provided `source` signal.
 *
 * @example
 * ```ts
 * import { signal, effect } from '@angular/core';
 *
 * // 1. Create a standard source signal.
 * const sourceQuery = signal('');
 *
 * // 2. Create a debounced version of it.
 * const debouncedQuery = debounce(sourceQuery, { ms: 500 });
 *
 * // This effect tracks the original signal and runs immediately.
 * effect(() => {
 * console.log('Original Query:', debouncedQuery.original());
 * });
 *
 * // This effect tracks the debounced signal and runs after the delay.
 * effect(() => {
 * console.log('Debounced Query:', debouncedQuery());
 * });
 *
 * console.log('Setting query to "a"');
 * debouncedQuery.set('a');
 * // Output: Original Query: a
 *
 * // ...500ms later...
 * // Output: Debounced Query: a
 * ```
 */
export function debounce<T>(
  source: WritableSignal<T>,
  opt?: CreateDebouncedOptions<T>,
): DebouncedSignal<T> {
  const ms = opt?.ms ?? 0;

  const trigger = signal(false);

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const destroyRef =
      opt?.destroyRef ?? inject(DestroyRef, { optional: true });

    destroyRef?.onDestroy(() => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    });
  } catch {
    // not in injection context & no destroyRef provided opting out of cleanup
  }

  const triggerFn = (afterClean: () => void) => {
    if (timeout) clearTimeout(timeout);
    afterClean();
    timeout = setTimeout(() => {
      trigger.update((c) => !c);
    }, ms);
  };

  const set = (value: T) => {
    triggerFn(() => source.set(value));
  };

  const update = (fn: (prev: T) => T) => {
    triggerFn(() => source.update(fn));
  };

  const writable = toWritable(
    computed(() => {
      trigger();
      return untracked(source);
    }, opt),
    set,
    update,
  ) as DebouncedSignal<T>;
  writable.original = source;

  return writable;
}
