import {
  linkedSignal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { isDerivation, type DerivedSignal } from './derived';
import { isWritableSignal } from './mappers/util';
import { isMutable, type MutableSignal } from './mutable';

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
  opt?: CreateSignalOptions<T>,
): MutableSignal<T>;
export function keepPrevious<T, U>(
  value: DerivedSignal<T, U>,
  opt?: CreateSignalOptions<U>,
): DerivedSignal<T, U>;
export function keepPrevious<T>(
  value: WritableSignal<T>,
  opt?: CreateSignalOptions<T>,
): WritableSignal<T>;
export function keepPrevious<T>(
  value: Signal<T>,
  opt?: CreateSignalOptions<T>,
): Signal<T>;
export function keepPrevious<T, P>(
  src: WritableSignal<T> | Signal<T> | MutableSignal<T> | DerivedSignal<P, T>,
  opt?: CreateSignalOptions<T>,
): WritableSignal<T> | Signal<T> {
  const mutableSrc = isWritableSignal(src) && isMutable(src);

  // For a mutable source the linkedSignal's equality must be suppressible: a forwarded
  // `mutate` keeps the same reference, which default equality would otherwise swallow.
  let cnt = 0;
  const baseEqual = opt?.equal;
  const equal = mutableSrc
    ? (a: T, b: T) =>
        cnt > 0 ? false : baseEqual ? baseEqual(a, b) : Object.is(a, b)
    : baseEqual;

  const persisted = linkedSignal<T, T>({
    ...opt,
    source: () => src(),
    computation: (next, prev) =>
      next === undefined && prev !== undefined ? prev.value : next,
    equal,
  });

  if (isWritableSignal(src)) {
    persisted.set = src.set;
    persisted.update = src.update;
    // NOTE: `asReadonly` deliberately stays the linkedSignal's own — returning the
    // source's readonly view would reintroduce the `undefined` flashes this wrapper exists
    // to prevent.

    if (mutableSrc) {
      (persisted as MutableSignal<T>).mutate = (updater) => {
        cnt++;
        try {
          src.mutate(updater);
          // force the recompute while equality is suppressed, so the reference-stable
          // mutation bumps the wrapper's version (see derived.ts for the same pattern)
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
