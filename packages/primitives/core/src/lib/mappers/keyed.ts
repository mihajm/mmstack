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

/** A source array: a signal or a function read inside a `computed`. @internal */
export type Source<T> = Signal<T[]> | (() => T[]);

/**
 * Builds one entry: the item, its item signal (`null` unless the mapper keeps item signals), its
 * index signal, its raw key and its lifetime handle. @internal
 */
export type Build<T, U, K> = (
  item: T,
  itemSignal: WritableSignal<T> | null,
  index: WritableSignal<number>,
  key: K,
  handle: Handle<K>,
) => U;

/** The keyed reconciler's options. @internal */
export type KeyedOptions<T, U, K> = {
  getKey: (item: T) => K;
  build: Build<T, U, K>;
  onDestroy?: (value: U) => void;
  onDuplicates?: (keys: readonly K[]) => void;
  /** Keep one item signal per entry, written when a reused entry's item reference changes. */
  items: boolean;
};

const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (a !== a && b !== b);
const EMPTY: readonly never[] = [];

/**
 * The keyed reconciler behind `mapArray` and `keyArray`: entries matched by handle, the mapped
 * array as a lazy `computed`, and a factory for `reorders` (created only when asked for). @internal
 */
export function keyedMapper<T, U, K>(
  source: Source<T>,
  options: KeyedOptions<T, U, K>,
): {
  readonly out: Signal<U[]>;
  readonly reorders: () => Signal<Permutation<Handle<K>> | null>;
} {
  const sourceSignal = isSignal(source) ? source : computed(source);
  const { getKey, build, onDestroy, onDuplicates } = options;
  const withItems = options.items;

  let table: HandleTable<T, K> | undefined;
  let mapped: U[] = [];
  // double-buffered index (and item) signals and reused scratch; the returned array is the one
  // allocation per recompute
  let indexes: WritableSignal<number>[] = [];
  let spareIndexes: WritableSignal<number>[] = [];
  let items: WritableSignal<T>[] = [];
  let spareItems: WritableSignal<T>[] = [];
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
      // the previous table's arrays stay intact for this one call (HandleTable retention); the
      // `items` getter follows the table, so both snapshots are taken before the call
      const prevHandles = table ? table.handles : EMPTY;
      const prevItems = table ? table.items : EMPTY;
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
          items.length = 0;
          spareItems.length = 0;
        }
        return mapped;
      }

      const newMapped = new Array<U>(newLen);
      const newIndexes = spareIndexes;
      newIndexes.length = newLen;
      const newItemSignals = spareItems;
      if (withItems) newItemSignals.length = newLen;
      const create = (j: number) => {
        const indexSignal = signal(j);
        newIndexes[j] = indexSignal;
        let itemSignal: WritableSignal<T> | null = null;
        if (withItems) newItemSignals[j] = itemSignal = signal(newItems[j]);
        newMapped[j] = build(
          newItems[j],
          itemSignal,
          indexSignal,
          keys[j],
          hs[j],
        );
      };
      // a reused entry's item is written only when its reference changed
      const carry = (j: number, i: number) => {
        newMapped[j] = mapped[i];
        newIndexes[j] = indexes[i];
        if (!withItems) return;
        const s = items[i];
        newItemSignals[j] = s;
        if (!Object.is(prevItems[i], newItems[j])) s.set(newItems[j]);
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
        )
          carry(start, start);
        let end = len - 1;
        let newEnd = newLen - 1;
        for (
          ;
          end >= start &&
          newEnd >= start &&
          sameValueZero(prevHandles[end], hs[newEnd]);
          end--, newEnd--
        )
          carry(newEnd, end);

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
          carry(j, i);
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
      if (withItems) {
        spareItems = items;
        items = newItemSignals;
      }
      return mapped;
    });
  });

  // `reorders` keeps its own baseline: a copy of the handles at its last evaluation, in one of two
  // buffers (the table's own arrays are reused by later recomputes of the mapped signal)
  const reorders = () => {
    const perm = createSurvivorPermutation<Handle<K>>();
    let fill: Handle<K>[] = [];
    let held: Handle<K>[] = [];
    return linkedSignal<readonly Handle<K>[], Permutation<Handle<K>> | null>({
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
    }).asReadonly();
  };

  return { out, reorders };
}
