import { type Signal } from '@angular/core';
import { type Handle } from './handles';
import { keyedMapper, type Source } from './keyed';
import { type Permutation } from './survivor-permutation';

/**
 * Options of {@link keyArray}.
 * @deprecated use {@link mapArray} and its {@link MapArrayOptions}
 */
export type KeyArrayOptions<T, U, K> = {
  /** Invoked with a mapped entry when its item leaves the array. */
  onDestroy?: (value: U) => void;
  /**
   * Optional function to use a custom key for item comparison.
   * Use this if you want to reuse mapped items based on a property (like an ID)
   * even if the item reference changes.
   */
  key?: (item: T) => K;
  /**
   * Hand `mapFn` the entry's lifetime {@link Handle} as its key instead of the raw key: the raw
   * key while that key never had duplicates, an opaque `KeyHandle` otherwise. A `KeyHandle` is
   * identified by reference: one that crosses a structured-clone boundary (a worker,
   * `postMessage`, JSON) comes back as a plain object that `isKeyHandle` rejects.
   */
  handles?: boolean;
  /**
   * Called untracked, once per recompute that sees duplicate keys, with those keys (the actual
   * values, never coerced) in first-occurrence order. Must not be relied upon to create reactive
   * dependencies.
   */
  onDuplicates?: (keys: readonly K[]) => void;
  /** Expose `reorders` on the result. See {@link keyArray}. */
  order?: boolean;
};

/**
 * The result of {@link keyArray} with `order: true`: the mapped array plus `reorders`.
 * @deprecated use {@link mapArray}, whose {@link MappedArray} always has `reorders`
 */
export type OrderedKeyArray<U, K> = Signal<U[]> & {
  readonly reorders: Signal<Permutation<Handle<K>> | null>;
};

/**
 * The result of {@link keyArray} for options not known statically: `reorders` iff `order` was set.
 * @deprecated use {@link mapArray}, whose {@link MappedArray} always has `reorders`
 */
export type MaybeOrderedKeyArray<U, K> = Signal<U[]> & {
  readonly reorders?: Signal<Permutation<Handle<K>> | null>;
};

type MapFn<T, U, Key> = (v: T, i: Signal<number>, key: Key) => U;

/**
 * Reactively maps items from a source array to a new array by value (identity).
 *
 * similar to `Array.prototype.map`, but:
 * 1. The `mapFn` receives the `index` as a Signal.
 * 2. If an item in the `source` array moves to a new position, the *result* of the map function is reused and moved.
 *    The `index` signal is updated to the new index.
 * 3. The `mapFn` is only run for *new* items.
 *
 * This is useful for building efficient lists where DOM nodes or heavy instances should be reused
 * when the list is reordered.
 *
 * Duplicate keys: every occurrence gets its own entry, and an entry follows the occurrence it was
 * built for, never its position among the duplicates. An item reference that occurs once on each
 * side is that occurrence, so removing one duplicate destroys exactly its entry and re-creates
 * none (`[a1, a2] → [a2]` keeps the entry built from `a2`). The same object repeated only changes
 * its count: entries are created or destroyed for the difference, never swapped. Fresh objects of
 * one key are matched in order when their count is unchanged (the immutable-update case); when
 * the count changes nothing shows which one survived, so those entries are re-created.
 *
 * @param source A `Signal<T[]>` or a function returning `T[]`.
 * @param mapFn The mapping function. Receives the item, its index as a Signal, and the entry's
 *   key: the raw key, or with `handles: true` the entry's lifetime {@link Handle} — stable for the
 *   lifetime of the mapped entry.
 * @param options Optional configuration:
 *  - `onDestroy`: A callback invoked when a mapped item is removed from the array.
 *  - `key`: A custom key extractor for identity matching (e.g. `(item) => item.id`)
 *    when item references change but conceptual identity is preserved.
 *  - `handles`: Hand `mapFn` the entry's lifetime handle instead of the raw key.
 *  - `onDuplicates`: Told which keys repeat, once per recompute that sees any.
 *  - `order`: Adds `reorders`, a read-only signal of the {@link Permutation} among the entries
 *    present both at its own last evaluation and now, or `null` when they kept their relative
 *    order. Inserts and removals alone are not reorders (a prepend bumps every `index` but yields
 *    `null`). The baseline is the signal's own last evaluation, shared by all its readers: changes
 *    it did not see fold into one transition, and none is lost because someone else read the
 *    mapped array in between. Its first evaluation is `null`. Without the option nothing is
 *    created or computed for it.
 * @returns A `Signal<U[]>` containing the mapped array.
 * @deprecated use {@link mapArray}: the same keyed reuse, with the item handed over as a signal
 *   that follows immutable updates under a custom `key`.
 *
 * @example
 * ```ts
 * const users = signal([
 *   { id: 1, name: 'Alice' },
 *   { id: 2, name: 'Bob' },
 * ]);
 *
 * const rows = keyArray(
 *   users,
 *   (user, index) => ({
 *     label: computed(() => `#${index()} ${user.name}`),
 *     id: user.id,
 *   }),
 *   { key: (u) => u.id },
 * );
 *
 * // Reordering users() rebuilds index signals only — `rows` entries
 * // are matched by id and reused, not re-created.
 * users.set([users()[1], users()[0]]);
 * ```
 */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> & { handles: true; order: true },
): OrderedKeyArray<U, K>;
/** @deprecated use {@link mapArray} */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, K>,
  options: KeyArrayOptions<T, U, K> & { handles?: false; order: true },
): OrderedKeyArray<U, K>;
/** @deprecated use {@link mapArray} */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> & { order: true },
): OrderedKeyArray<U, K>;
/** @deprecated use {@link mapArray} */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> & { handles: true; order?: false },
): Signal<U[]>;
/** @deprecated use {@link mapArray} */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, K>,
  options?: KeyArrayOptions<T, U, K> & { handles?: false; order?: false },
): Signal<U[]>;
/** @deprecated use {@link mapArray} */
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options?: KeyArrayOptions<T, U, K>,
): MaybeOrderedKeyArray<U, K>;
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> = {},
): MaybeOrderedKeyArray<U, K> {
  const handlesAsKey = !!options.handles;
  const { out, reorders } = keyedMapper<T, U, K>(source, {
    getKey: options.key || ((v: T) => v as unknown as K),
    build: handlesAsKey
      ? (item, _s, index, _key, handle) => mapFn(item, index, handle)
      : (item, _s, index, key) => mapFn(item, index, key as Handle<K>),
    onDestroy: options.onDestroy,
    onDuplicates: options.onDuplicates,
    items: false,
  });

  if (!options.order) return out;
  return Object.assign(out, { reorders: reorders() });
}
