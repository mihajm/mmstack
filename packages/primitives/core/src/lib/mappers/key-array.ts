import {
  computed,
  isSignal,
  linkedSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  handles as assignHandles,
  type Handle,
  type HandleTable,
} from './handles';
import {
  createSurvivorPermutation,
  type Permutation,
} from './survivor-permutation';

export type { Permutation } from './survivor-permutation';

/** Options of {@link keyArray}. */
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

/** The result of {@link keyArray} with `order: true`: the mapped array plus `reorders`. */
export type OrderedKeyArray<U, K> = Signal<U[]> & {
  readonly reorders: Signal<Permutation<Handle<K>> | null>;
};

/** The result of {@link keyArray} for options not known statically: `reorders` iff `order` was set. */
export type MaybeOrderedKeyArray<U, K> = Signal<U[]> & {
  readonly reorders?: Signal<Permutation<Handle<K>> | null>;
};

type Source<T> = Signal<T[]> | (() => T[]);
type MapFn<T, U, Key> = (v: T, i: Signal<number>, key: Key) => U;

const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (a !== a && b !== b);
const EMPTY: readonly never[] = [];

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
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, K>,
  options: KeyArrayOptions<T, U, K> & { handles?: false; order: true },
): OrderedKeyArray<U, K>;
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> & { order: true },
): OrderedKeyArray<U, K>;
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, Handle<K>>,
  options: KeyArrayOptions<T, U, K> & { handles: true; order?: false },
): Signal<U[]>;
export function keyArray<T, U, K>(
  source: Source<T>,
  mapFn: MapFn<T, U, K>,
  options?: KeyArrayOptions<T, U, K> & { handles?: false; order?: false },
): Signal<U[]>;
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
  const sourceSignal = isSignal(source) ? source : computed(source);
  const getKey = options.key || ((v: T) => v as unknown as K);
  const withHandles = !!options.handles;
  const onDestroy = options.onDestroy;
  const onDuplicates = options.onDuplicates;

  let table: HandleTable<T, K> | undefined;
  let mapped: U[] = [];
  // double-buffered index signals and reused scratch; the returned array is the one allocation
  let indexes: WritableSignal<number>[] = [];
  let spareIndexes: WritableSignal<number>[] = [];
  const oldAt = new Map<Handle<K>, number>();
  const reused: boolean[] = [];
  const fresh: number[] = [];
  const counts = onDuplicates ? new Map<K, number>() : null;

  const reportDuplicates = (keys: readonly K[]) => {
    if (!counts || !onDuplicates) return;
    counts.clear();
    let any = false;
    for (let i = 0; i < keys.length; i++) {
      const c = (counts.get(keys[i]) ?? 0) + 1;
      counts.set(keys[i], c);
      if (c > 1) any = true;
    }
    if (!any) return;
    const dup: K[] = [];
    for (let i = 0; i < keys.length; i++) {
      if ((counts.get(keys[i]) ?? 0) < 2) continue;
      dup.push(keys[i]);
      counts.set(keys[i], 0);
    }
    counts.clear();
    untracked(() => onDuplicates(dup));
  };

  const out = computed(() => {
    const newItems = sourceSignal() || [];

    return untracked(() => {
      // the previous table's arrays stay intact for this one call (HandleTable retention)
      const prevHandles = table ? table.handles : EMPTY;
      const next = assignHandles(table, newItems, getKey).table;
      table = next;
      reportDuplicates(next.keys);

      const hs = next.handles;
      const keys = next.keys;
      const newLen = hs.length;
      const len = prevHandles.length;

      if (newLen === 0) {
        if (len !== 0) {
          if (onDestroy) for (let k = 0; k < len; k++) onDestroy(mapped[k]);
          mapped = [];
          indexes.length = 0;
          spareIndexes.length = 0;
        }
        return mapped;
      }

      const newMapped = new Array<U>(newLen);
      const newIndexes = spareIndexes;
      newIndexes.length = newLen;
      const create = (j: number) => {
        const indexSignal = signal(j);
        newIndexes[j] = indexSignal;
        newMapped[j] = mapFn(
          newItems[j],
          indexSignal,
          withHandles ? hs[j] : (keys[j] as Handle<K>),
        );
      };

      if (len === 0) {
        for (let j = 0; j < newLen; j++) create(j);
      } else {
        // common prefix and suffix by handle, then a handle map in the middle
        let start = 0;
        const shorter = Math.min(len, newLen);
        for (
          ;
          start < shorter && sameValueZero(prevHandles[start], hs[start]);
          start++
        ) {
          newMapped[start] = mapped[start];
          newIndexes[start] = indexes[start];
        }
        let end = len - 1;
        let newEnd = newLen - 1;
        for (
          ;
          end >= start &&
          newEnd >= start &&
          sameValueZero(prevHandles[end], hs[newEnd]);
          end--, newEnd--
        ) {
          newMapped[newEnd] = mapped[end];
          newIndexes[newEnd] = indexes[end];
        }

        oldAt.clear();
        for (let i = start; i <= end; i++) oldAt.set(prevHandles[i], i);
        reused.length = len;
        reused.fill(false, start, end + 1);
        fresh.length = 0;
        for (let j = start; j <= newEnd; j++) {
          const i = oldAt.get(hs[j]);
          if (i === undefined) {
            fresh.push(j);
            continue;
          }
          reused[i] = true;
          newMapped[j] = mapped[i];
          newIndexes[j] = indexes[i];
        }
        oldAt.clear();
        if (onDestroy)
          for (let i = start; i <= end; i++)
            if (!reused[i]) onDestroy(mapped[i]);

        let f = 0;
        for (let j = start; j < newLen; j++) {
          if (f < fresh.length && fresh[f] === j) {
            create(j);
            f++;
          } else newIndexes[j].set(j);
        }
      }

      mapped = newMapped;
      spareIndexes = indexes;
      indexes = newIndexes;
      return mapped;
    });
  });

  if (!options.order) return out;

  // `reorders` keeps its own baseline: a copy of the handles at its last evaluation, in one of two
  // buffers (the table's own arrays are reused by later recomputes of the mapped signal)
  const perm = createSurvivorPermutation<Handle<K>>();
  let fill: Handle<K>[] = [];
  let held: Handle<K>[] = [];
  const reorders = linkedSignal<
    readonly Handle<K>[],
    Permutation<Handle<K>> | null
  >({
    source: () => {
      out();
      const hs = untracked(() => (table ? table.handles : EMPTY));
      const snap = fill;
      snap.length = hs.length;
      for (let i = 0; i < hs.length; i++) snap[i] = hs[i];
      fill = held;
      held = snap;
      return snap;
    },
    computation: (hs, previous) =>
      previous ? perm(previous.source, hs) : null,
  });
  return Object.assign(out, { reorders: reorders.asReadonly() });
}
