import {
  computed,
  type CreateSignalOptions,
  isSignal,
  linkedSignal,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { derived } from '../derived';
import { isMutable, type MutableSignal } from '../mutable';
import { toWritable } from '../to-writable';
import { createSetter } from './create-setter';
import { isWritableSignal } from './is-writable';

/**
 * Reactively maps items from a source array to a new array using a key function to maintain stability.
 *
 * This function preserves the `mapped` signals for items even if they move within the array,
 * as long as their key remains the same. This is equivalent to SolidJS's `mapArray` or Angular's `@for (item of items; track item.id)`.
 *
 * @template T The type of items in the source array.
 * @template U The type of items in the resulting mapped array.
 * @template K The type of the key.
 *
 * @param source A `Signal<T[]>` or a function returning `T[]`.
 * @param keyFn A function to extract a unique key for each item.
 * @param map The mapping function. It receives a stable signal for the item and a signal for its index.
 * @param options Optional configuration, including `CreateSignalOptions` and an `onDestroy` callback.
 * @returns A `Signal<U[]>` containing the mapped array.
 */
export function keyArray<T, U>(
  source: MutableSignal<T[]>,
  keyFn: (item: T) => string | number,
  map: (value: MutableSignal<T>, index: Signal<number>) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function keyArray<T, U>(
  source: WritableSignal<T[]>,
  keyFn: (item: T) => string | number,
  map: (value: WritableSignal<T>, index: Signal<number>) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function keyArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  keyFn: (item: T) => string | number,
  map: (value: Signal<T>, index: Signal<number>) => U,
  options?: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  },
): Signal<U[]>;

export function keyArray<T, U>(
  source: Signal<T[]> | (() => T[]),
  keyFn: (item: T) => string | number,
  map:
    | ((value: Signal<T>, index: Signal<number>) => U)
    | ((value: WritableSignal<T>, index: Signal<number>) => U)
    | ((value: MutableSignal<T>, index: Signal<number>) => U),
  opt: CreateSignalOptions<T> & {
    onDestroy?: (value: U) => void;
  } = {},
): Signal<U[]> {
  const data = isSignal(source) ? source : computed(source);
  const setter = createSetter(data);

  const writableData = isWritableSignal(data)
    ? data
    : toWritable(data, () => {
        // noop
      });

  if (isWritableSignal(data) && isMutable(data) && !opt.equal) {
    opt.equal = (a: T, b: T) => {
      if (a !== b) return false;
      return false; // opt out for same refs
    };
  }

  type $Record = {
    source: {
      value: Signal<T> | WritableSignal<T> | MutableSignal<T>;
      idx: WritableSignal<number>;
    };
    computation: U;
  };

  type $Internal = {
    values: U[];
    cache: Map<string | number, $Record>;
  };

  let freeMap = new Map<string | number, $Record>();

  const createRecord = (i: number): $Record => {
    const idx = signal(i);
    const value = derived(
      writableData as MutableSignal<T[]>,
      {
        from: (v) => v[idx()],
        onChange: (next) => setter(next, untracked(idx)),
      },
      opt,
    );

    return {
      source: {
        idx,
        value,
      },
      computation: map(value, idx),
    };
  };

  const internal = linkedSignal<T[], $Internal>({
    source: () => writableData(),
    computation: (src, prev) => {
      const prevCache =
        prev?.value.cache ?? new Map<string | number, $Record>();
      const nextCache = freeMap;

      const nextValues: U[] = [];

      let changed = false;

      for (let i = 0; i < src.length; i++) {
        const k = untracked(() => keyFn(src[i]));
        let record = prevCache.get(k);

        if (!record) {
          changed = true;
          record = createRecord(i);
        }

        prevCache.delete(k);
        nextCache.set(k, record);
        nextValues.push(record.computation);

        if (untracked(record.source.idx) !== i) {
          untracked(() => record.source.idx.set(i));
          changed = true;
        }
      }

      if (prevCache.size > 0) changed = true;

      if (opt.onDestroy)
        prevCache.values().forEach((v) => opt.onDestroy?.(v.computation));

      // clear for next run
      prevCache.clear();
      freeMap = prevCache;

      return {
        cache: nextCache,
        values: changed ? nextValues : (prev?.value.values ?? []),
      };
    },
  });

  return computed(() => internal().values);
}
