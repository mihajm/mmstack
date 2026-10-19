import { type Signal } from '@angular/core';
import { type Handle } from './handles';
import { keyedMapper } from './keyed';
import { type Permutation } from './survivor-permutation';

/** Options of {@link mapArray}. */
export type MapArrayOptions<T, U, K> = {
  /** Invoked with a mapped entry when its item leaves the array. */
  onDestroy?: (value: U) => void;
  /**
   * Matches items by a property (like an ID) instead of by reference, so an entry survives an
   * immutable update of its item. Without it the item itself is the key.
   */
  key?: (item: T) => K;
  /**
   * Called untracked, once per recompute that sees duplicate keys, with those keys (the actual
   * values, never coerced) in first-occurrence order. Must not be relied upon to create reactive
   * dependencies.
   */
  onDuplicates?: (keys: readonly K[]) => void;
};

/** The result of {@link mapArray}: the mapped array plus `reorders`. */
export type MappedArray<U, K> = Signal<U[]> & {
  readonly reorders: Signal<Permutation<Handle<K>> | null>;
};

/**
 * Reactively maps a source array to a new array, keyed by identity: an entry is built once per
 * item and reused while that item stays in the array, wherever it moves (SolidJS's `mapArray`;
 * the per-slot mapper is {@link indexArray}).
 *
 * `mapFn` runs only for new items. It receives:
 * 1. `item`: a read-only signal of the entry's item. It follows the item when a custom `key` keeps
 *    the entry across an immutable update (same id, new object).
 * 2. `index`: a read-only signal of the entry's current position.
 * 3. `key`: the entry's raw key (the item itself without a `key` option).
 * 4. `handle`: the entry's lifetime {@link Handle}: the raw key while that key never had
 *    duplicates, an opaque `KeyHandle` otherwise. `reorders` names entries by it.
 *
 * Freshness: the list writes `item` and `index` when it is read, so a row is as fresh as the
 * list's last read. A row read before the list sees the previous state, never a mix of two: its
 * `item()` and `index()` always belong to one source state.
 *
 * Duplicate keys: every occurrence gets its own entry, and an entry follows the occurrence it was
 * built for, never its position among the duplicates. An item reference that occurs once on each
 * side is that occurrence, so removing one duplicate destroys exactly its entry and re-creates
 * none (`[a1, a2] → [a2]` keeps the entry built from `a2`). The same object repeated only changes
 * its count: entries are created or destroyed for the difference, never swapped. Fresh objects of
 * one key are matched in order when their count is unchanged (the immutable-update case); when
 * the count changes nothing shows which one survived, so those entries are re-created.
 *
 * `reorders` is a read-only signal of the {@link Permutation} among the entries present both at
 * its own last evaluation and now, or `null` when they kept their relative order. Inserts and
 * removals alone are not reorders (a prepend bumps every `index` but yields `null`). Its baseline
 * is its own last evaluation, shared by all its readers: changes it did not see fold into one
 * transition. Its first evaluation is `null`. Unread, nothing is computed for it.
 *
 * @param source A `Signal<T[]>` or a function returning `T[]`.
 * @param mapFn Builds an entry from its item signal, index signal, raw key and handle.
 * @param options `onDestroy`, `key` and `onDuplicates`.
 * @returns A `Signal<U[]>` of the entries, with `reorders`.
 *
 * @example
 * ```ts
 * const users = signal([
 *   { id: 1, name: 'Alice' },
 *   { id: 2, name: 'Bob' },
 * ]);
 *
 * const rows = mapArray(
 *   users,
 *   (user, index) => ({
 *     label: computed(() => `#${index()} ${user().name}`),
 *   }),
 *   { key: (u) => u.id },
 * );
 *
 * // a reorder moves the entries and updates `index`; renaming Bob in a new object keeps his
 * // entry and updates `user()`
 * users.set([{ id: 2, name: 'Robert' }, users()[0]]);
 * ```
 */
export function mapArray<T, U, K = T>(
  source: Signal<T[]> | (() => T[]),
  mapFn: (
    item: Signal<T>,
    index: Signal<number>,
    key: K,
    handle: Handle<K>,
  ) => U,
  options: MapArrayOptions<T, U, K> = {},
): MappedArray<U, K> {
  const { out, reorders } = keyedMapper<T, U, K>(source, {
    getKey: options.key || ((v: T) => v as unknown as K),
    build: (_item, itemSignal, index, key, handle) =>
      mapFn(itemSignal as Signal<T>, index, key, handle),
    onDestroy: options.onDestroy,
    onDuplicates: options.onDuplicates,
    items: true,
  });
  return Object.assign(out, { reorders: reorders() });
}
