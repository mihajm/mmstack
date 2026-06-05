import type { CreateSignalOptions, Signal } from '@angular/core';
import { pooled, type Computation, type CreatePooledOptions } from '.';

/**
 * Options for the preset pool helpers. Same shape as
 * {@link CreatePooledOptions}, with `create` and `reset` made optional — each
 * helper supplies its own defaults.
 */
export type CreateProvidedPooledOptions<T, U = T> = Omit<
  CreatePooledOptions<T, U>,
  'create' | 'reset'
> &
  Partial<Pick<CreatePooledOptions<T, U>, 'create' | 'reset'>>;

function toPooledOptions<T, U = T>(
  optOrComputation: CreateProvidedPooledOptions<T, U> | Computation<T, U>,
  create: () => T,
  reset: (dirty: T) => void,
  signalOpt?: CreateSignalOptions<U>,
): CreatePooledOptions<T, U> {
  const opt =
    typeof optOrComputation === 'object' ? optOrComputation : signalOpt;

  const computation =
    typeof optOrComputation === 'function'
      ? optOrComputation
      : optOrComputation.computation;

  return {
    create,
    reset,
    computation,
    ...opt,
  };
}

function createEmptyArray<T extends unknown[]>() {
  return [] as unknown as T;
}

function resetArray<T extends unknown[]>(arr: T): void {
  arr.length = 0;
}

/**
 * Array-buffer preset for {@link pooled}. Recycles a single array per slot;
 * cleared via `arr.length = 0` between reads.
 *
 * Two overloads: a {@link Computation} shorthand (most common) or the full
 * options object when you need `eager` or custom `create`/`reset`.
 *
 * Generic inference defaults `T` to `unknown[]` — annotate the callback or
 * pass the type argument for tighter element types.
 *
 * @see {@link pooled} for the retention contract.
 *
 * @example
 * ```ts
 * const activeIds = pooledArray<number[]>((buf) => {
 *   for (const item of items()) if (item.active) buf.push(item.id);
 *   return buf;
 * });
 * ```
 */
export function pooledArray<T extends unknown[], U = T>(
  computation: Computation<T, U>,
  opt?: CreateSignalOptions<U>,
): Signal<U>;

export function pooledArray<T extends unknown[], U = T>(
  opt: CreateProvidedPooledOptions<T, U>,
): Signal<U>;

export function pooledArray<T extends unknown[], U = T>(
  optOrComputation: CreateProvidedPooledOptions<T, U> | Computation<T, U>,
  signalOpt?: CreateSignalOptions<U>,
): Signal<U> {
  return pooled(
    toPooledOptions(optOrComputation, createEmptyArray, resetArray, signalOpt),
  );
}

function createEmptySet<T extends Set<unknown>>(): T {
  return new Set() as T;
}

function resetClearable<T extends { clear(): void }>(clearable: T): void {
  clearable.clear();
}

/**
 * Set-buffer preset for {@link pooled}. Recycles a single `Set` per slot;
 * cleared via `.clear()` between reads. Overload shape mirrors
 * {@link pooledArray}.
 *
 * @see {@link pooled} for the retention contract.
 *
 * @example
 * ```ts
 * const distinctRoles = pooledSet<Set<string>>((buf) => {
 *   for (const u of users()) buf.add(u.role);
 *   return buf;
 * });
 * ```
 */
export function pooledSet<T extends Set<unknown>, U = T>(
  computation: Computation<T, U>,
  opt?: CreateSignalOptions<U>,
): Signal<U>;

export function pooledSet<T extends Set<unknown>, U = T>(
  opt: CreateProvidedPooledOptions<T, U>,
): Signal<U>;

export function pooledSet<T extends Set<unknown>, U = T>(
  optOrComputation: CreateProvidedPooledOptions<T, U> | Computation<T, U>,
  signalOpt?: CreateSignalOptions<U>,
): Signal<U> {
  return pooled(
    toPooledOptions(
      optOrComputation,
      createEmptySet,
      resetClearable,
      signalOpt,
    ),
  );
}

function createEmptyMap<T extends Map<unknown, unknown>>(): T {
  return new Map() as T;
}

/**
 * Map-buffer preset for {@link pooled}. Recycles a single `Map` per slot;
 * cleared via `.clear()` between reads. Overload shape mirrors
 * {@link pooledArray}.
 *
 * @see {@link pooled} for the retention contract.
 *
 * @example
 * ```ts
 * const byId = pooledMap<Map<number, User>>((buf) => {
 *   for (const u of users()) buf.set(u.id, u);
 *   return buf;
 * });
 * ```
 */
export function pooledMap<T extends Map<unknown, unknown>, U = T>(
  computation: Computation<T, U>,
  opt?: CreateSignalOptions<U>,
): Signal<U>;

export function pooledMap<T extends Map<unknown, unknown>, U = T>(
  opt: CreateProvidedPooledOptions<T, U>,
): Signal<U>;

export function pooledMap<T extends Map<unknown, unknown>, U = T>(
  optOrComputation: CreateProvidedPooledOptions<T, U> | Computation<T, U>,
  signalOpt?: CreateSignalOptions<U>,
): Signal<U> {
  return pooled(
    toPooledOptions(
      optOrComputation,
      createEmptyMap,
      resetClearable,
      signalOpt,
    ),
  );
}
