import {
  linkedSignal,
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
  const persisted = linkedSignal<T, T>({
    ...opt,
    source: () => src(),
    computation: (next, prev) =>
      next === undefined && prev !== undefined ? prev.value : next,
  });

  if (isWritableSignal(src)) {
    persisted.set = src.set;
    persisted.update = src.update;
    persisted.asReadonly = src.asReadonly;

    if (isMutable(src)) {
      (persisted as MutableSignal<T>).mutate = src.mutate;
      (persisted as MutableSignal<T>).inline = src.inline;
    }

    if (isDerivation(src)) {
      (persisted as DerivedSignal<any, T>).from = src.from;
    }
  }

  return persisted;
}
