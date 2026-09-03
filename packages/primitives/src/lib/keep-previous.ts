import {
  isWritableSignal,
  linkedSignal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { isDerivation, type DerivedSignal } from './derived';
import { isMutable, type MutableSignal } from './mutable';

/**
 * Options for {@link keepPrevious}: the signal options of the held value, plus
 * `fallback` — what to yield while there is nothing to hold yet (the source has
 * never been defined). Once a defined value has been seen the fallback is never
 * yielded again; the previous value is.
 */
export type KeepPreviousOptions<T> = CreateSignalOptions<T> & {
  readonly fallback?: T;
};

/**
 * Wraps a signal so it HOLDS its last defined value whenever the source becomes
 * `undefined`, yielding that value instead of the gap. This is the foundation of
 * stale-while-revalidate: a source that drops to `undefined` mid-reload keeps
 * surfacing its previous result rather than flashing empty.
 *
 * Built on `linkedSignal` — the only primitive that hands a computation its own
 * previous output, which is exactly what "hold the previous value" needs.
 *
 * If the source is writable, the wrapper forwards `set`/`update`/`asReadonly` to it,
 * so it stays a drop-in replacement. (Angular's `resource` is itself linkedSignal-backed
 * and exposes a writable `value` for optimistic updates; this preserves that.)
 */
export function keepPrevious<T>(
  value: MutableSignal<T>,
  opt?: KeepPreviousOptions<T>,
): MutableSignal<T>;
export function keepPrevious<T, U>(
  value: DerivedSignal<T, U>,
  opt?: KeepPreviousOptions<U>,
): DerivedSignal<T, U>;
export function keepPrevious<T>(
  value: WritableSignal<T>,
  opt?: KeepPreviousOptions<T>,
): WritableSignal<T>;
export function keepPrevious<T>(
  value: Signal<T>,
  opt?: KeepPreviousOptions<T>,
): Signal<T>;
export function keepPrevious<T, P>(
  src: WritableSignal<T> | Signal<T> | MutableSignal<T> | DerivedSignal<P, T>,
  opt?: KeepPreviousOptions<T>,
): WritableSignal<T> | Signal<T> {
  const mutableSrc = isWritableSignal(src) && isMutable(src);
  const { fallback, ...signalOpt } = opt ?? {};

  let cnt = 0;
  const baseEqual = opt?.equal;
  const equal = mutableSrc
    ? (a: T, b: T) =>
        cnt > 0 ? false : baseEqual ? baseEqual(a, b) : Object.is(a, b)
    : baseEqual;

  const persisted = linkedSignal<T, T>({
    ...signalOpt,
    source: () => src(),
    computation: (next, prev) => {
      if (next !== undefined) return next;
      return prev !== undefined ? prev.value : (fallback as T);
    },
    equal,
  });

  if (isWritableSignal(src)) {
    persisted.set = src.set;
    persisted.update = src.update;

    if (mutableSrc) {
      (persisted as MutableSignal<T>).mutate = (updater) => {
        cnt++;
        try {
          src.mutate(updater);
          untracked(persisted);
        } finally {
          cnt--;
        }
      };
      (persisted as MutableSignal<T>).inline = (updater) => {
        (persisted as MutableSignal<T>).mutate((prev) => {
          updater(prev);
          return prev;
        });
      };
    }

    if (isDerivation(src)) {
      (persisted as DerivedSignal<any, T>).from = src.from;
    }
  }

  return persisted;
}
