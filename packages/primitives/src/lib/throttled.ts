import {
  computed,
  type CreateSignalOptions,
  DestroyRef,
  inject,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { DebouncedSignal } from './debounced';
import { toWritable } from './to-writable';

/**
 * Options for creating a throttled writable signal.
 * Extends Angular's `CreateSignalOptions` with a throttle time setting.
 *
 * @template T The type of value held by the signal.
 */
export type CreateThrottledOptions<T> = CreateSignalOptions<T> & {
  /**
   * The throttle delay in milliseconds. The minimum time
   * in milliseconds that must pass between updates to the throttled signal's value.
   */
  ms?: number;
  /**
   * Optional `DestroyRef` to clean up the throttle timer when the signal is destroyed.
   * If provided, the timer will be cleared when the signal is destroyed.
   * If the signal is called within a reactive context a DestroyRef is injected automatically.
   * If it is not provided or injected, the timer will not be cleared automatically...which is usually fine :)
   */
  destroyRef?: DestroyRef;
};

/**
 * A specialized `WritableSignal` whose publicly readable value updates are throttled.
 *
 * It provides access to the underlying, non-throttled signal via the `original` property.
 *
 * @template T The type of value held by the signal.
 * @see {DebouncedSignal} as the output type has the same structure.
 */
export type ThrottledSignal<T> = DebouncedSignal<T>;

/**
 * A convenience function that creates and throttles a new `WritableSignal` in one step.
 *
 * @see {throttle} for the core implementation details.
 *
 * @template T The type of value the signal holds.
 * @param initial The initial value of the signal.
 * @param opt Options for signal creation, including throttle time `ms`.
 * @returns A `ThrottledSignal<T>` instance.
 *
 * @example
 * const query = throttled('', { ms: 500 });
 * effect(() => console.log('Throttled Query:', query()));
 *
 * query.set('a');
 * query.set('b');
 * query.set('c');
 * // With a trailing-edge throttle, the final value 'c' would be set
 * // after the 500ms cooldown.
 */
export function throttled<T>(
  initial: T,
  opt?: CreateThrottledOptions<T>,
): DebouncedSignal<T> {
  return throttle(signal(initial, opt), opt);
}

/**
 * Wraps an existing `WritableSignal` to create a new one whose readable value is throttled.
 *
 * This implementation avoids using `effect` by pairing a trigger signal with an `untracked`
 * read of the source signal to control when the throttled value is re-evaluated.
 *
 * @template T The type of value the signal holds.
 * @param source The source `WritableSignal` to wrap. Writes are applied to this signal immediately.
 * @param opt Options for throttling, including throttle time `ms` and an optional `DestroyRef`.
 * @returns A new `ThrottledSignal<T>` whose read value is throttled. The `.original` property
 * of the returned signal is a reference back to the provided `source` signal.
 *
 * @example
 * const query = throttled('', { ms: 500 });
 * effect(() => console.log('Throttled Query:', query()));
 *
 * query.set('a');
 * query.set('b');
 * query.set('c');
 * // With a trailing-edge throttle, the final value 'c' would be set
 * // after the 500ms cooldown.
 */
export function throttle<T>(
  source: WritableSignal<T>,
  opt?: CreateThrottledOptions<T>,
): ThrottledSignal<T> {
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

  const triggerFn = (updateSourceAction: () => void) => {
    updateSourceAction();
    if (timeout) return;

    timeout = setTimeout(() => {
      trigger.update((c) => !c);
      timeout = undefined;
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
  ) as ThrottledSignal<T>;
  writable.original = source;

  return writable;
}
