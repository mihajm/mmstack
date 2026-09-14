import {
  computed,
  type CreateSignalOptions,
  DestroyRef,
  inject,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { type DebouncedSignal } from './debounced';
import { getSignalEquality } from './get-signal-equality';
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
  /**
   * If `true`, the throttled signal emits the first value immediately when a
   * burst starts, then enforces the cooldown window before the next emission.
   * @default false
   */
  leading?: boolean;
  /**
   * If `true`, the throttled signal emits the latest pending value at the end
   * of each cooldown window (only when at least one write occurred during it).
   * Note: with both `leading` and `trailing` set to `false` the throttled view
   * never updates (writes still reach `.original`).
   * @default true
   */
  trailing?: boolean;
};

/**
 * A specialized `WritableSignal` whose publicly readable value updates are throttled.
 *
 * Provides access to the underlying, non-throttled signal via `original`, and a
 * `flush()` that emits the current value immediately (clearing any open window) —
 * useful for terminal transitions that shouldn't wait for the trailing edge.
 *
 * @template T The type of value held by the signal.
 */
export type ThrottledSignal<T> = DebouncedSignal<T> & {
  /** Emit the latest value now, bypassing the remaining throttle window. */
  flush: () => void;
};

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
): ThrottledSignal<T> {
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
  const eq = opt?.equal ?? getSignalEquality(source);
  const ms = opt?.ms ?? 0;
  const leading = opt?.leading ?? false;
  const trailing = opt?.trailing ?? true;

  const trigger = signal(false);
  const fire = () => trigger.update((c) => !c);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pendingTrailing = false;

  try {
    const destroyRef =
      opt?.destroyRef ?? inject(DestroyRef, { optional: true });

    destroyRef?.onDestroy(() => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      pendingTrailing = false;
    });
  } catch {
    // not in injection context & no destroyRef provided opting out of cleanup
  }

  const tick = () => {
    if (!timeout) {
      if (leading) fire();
      else pendingTrailing = trailing;

      const onWindowEnd = () => {
        timeout = undefined;
        if (trailing && pendingTrailing) {
          pendingTrailing = false;
          fire();
          timeout = setTimeout(onWindowEnd, ms);
        }
      };

      timeout = setTimeout(onWindowEnd, ms);
      return;
    }

    if (trailing) pendingTrailing = true;
  };

  const set = (next: T) => {
    if (eq(untracked(source), next)) return;
    source.set(next);
    tick();
  };

  const update = (fn: (prev: T) => T) => set(fn(untracked(source)));

  const flush = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    pendingTrailing = false;
    fire();
  };

  const writable = toWritable(
    computed(() => {
      trigger();
      return untracked(source);
    }, opt),
    set,
    update,
  ) as ThrottledSignal<T>;
  writable.original = source.asReadonly();
  writable.flush = flush;

  return writable;
}
