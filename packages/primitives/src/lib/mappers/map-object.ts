import {
  computed,
  isSignal,
  linkedSignal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from '../derived';
import { type MutableSignal } from '../mutable';
import { toWritable } from '../to-writable';
import { isWritableSignal } from './util';

function pooledKeys<T extends Record<string, any>>(
  src: Signal<T>,
): Signal<Set<keyof T>> {
  const aBuf = new Set<keyof T>();
  const bBuf = new Set<keyof T>();

  let active = aBuf;
  let spare = bBuf;

  return computed(() => {
    const val = src();

    spare.clear();

    for (const k in val)
      if (Object.prototype.hasOwnProperty.call(val, k)) spare.add(k);

    if (active.size === spare.size) {
      let subset = true;
      for (const k of active) {
        if (!spare.has(k)) {
          subset = false;
          break;
        }
      }
      if (subset) return active;
    }

    const temp = active;
    active = spare;
    spare = temp;

    return active;
  });
}

type MappedObject<T extends object, U> = {
  [K in keyof T]: U;
};

/**
 * Reactively maps each property of an object signal into a new object,
 * preserving the same set of keys. For each key, `mapFn` receives a stable
 * per-key signal — outputs for keys that haven't been added or removed are
 * reused on subsequent reads. Sibling to {@link indexArray} / {@link keyArray}
 * but for object records.
 *
 * The type of per-key signal passed into `mapFn` depends on the source:
 * - `MutableSignal<T>` source → `MutableSignal<T[K]>` (in-place mutation)
 * - `WritableSignal<T>` source → `WritableSignal<T[K]>` (two-way binding)
 * - read-only `Signal<T>` or `() => T` source → read-only `Signal<T[K]>`
 *
 * @typeParam T The object type held by the source signal.
 * @typeParam U The type produced for each key by `mapFn`.
 *
 * @param source A `MutableSignal<T>` whose properties are mapped with full
 *   in-place mutation capability via the per-key `MutableSignal`.
 * @param mapFn Receives each key and its per-key `MutableSignal<T[K]>`.
 * @param options Optional `onDestroy(value)` callback fired when a key is
 *   removed from the source.
 * @returns A read-only signal of the mapped object.
 *
 * @example
 * ```ts
 * const state = mutable({ name: 'Alice', age: 30 });
 * const view = mapObject(state, (key, prop) => ({
 *   label: key,
 *   current: computed(() => prop()),
 *   onInput: (next: any) => prop.set(next),
 * }));
 * view().age.onInput(31);
 * state(); // { name: 'Alice', age: 31 }
 * ```
 */
export function mapObject<T extends object, U>(
  source: MutableSignal<T>,
  mapFn: <K extends keyof T>(key: K, value: MutableSignal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

/**
 * Reactively maps each property of a `WritableSignal<T>` into a new object.
 * Each key's per-property signal supports `.set` / `.update` for two-way
 * binding back into the parent object.
 *
 * @example
 * ```ts
 * const user = signal({ name: 'Alice', age: 30 });
 * const inputs = mapObject(user, (key, prop) => ({
 *   value: prop,
 *   setValue: (v: any) => prop.set(v),
 * }));
 * ```
 */
export function mapObject<T extends object, U>(
  source: WritableSignal<T>,
  mapFn: <K extends keyof T>(key: K, value: WritableSignal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

/**
 * Reactively maps each property of a read-only `Signal<T>` (or plain `() => T`
 * accessor) into a new object. Per-key signals are read-only.
 *
 * @example
 * ```ts
 * const config = computed(() => ({ theme: 'dark', density: 'compact' }));
 * const view = mapObject(config, (key, prop) => `${key}: ${prop()}`);
 * view(); // { theme: 'theme: dark', density: 'density: compact' }
 * ```
 */
export function mapObject<T extends object, U>(
  source: (() => T) | Signal<T>,
  mapFn: <K extends keyof T>(key: K, value: Signal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

export function mapObject<T extends object, U>(
  source: (() => T) | Signal<T> | WritableSignal<T> | MutableSignal<T>,
  mapFn: <K extends keyof T>(key: K, value: any) => U,
  options: {
    onDestroy?: (value: U) => void;
  } = {},
): Signal<MappedObject<T, U>> {
  const src = isSignal(source) ? source : computed(source);
  const writable = (
    isWritableSignal(src)
      ? src
      : toWritable(src, () => {
          // noop
        })
  ) as MutableSignal<T>; // maximal overload internally

  return linkedSignal<Set<keyof T>, MappedObject<T, U>>({
    source: pooledKeys(src),
    computation: (next, prev) => {
      const nextObj = {} as MappedObject<T, U>;

      for (const k of next)
        nextObj[k] =
          prev && prev.source.has(k)
            ? prev.value[k]
            : mapFn(k, derived(writable, k));

      if (options.onDestroy && prev && prev.source.size)
        for (const k of prev.source)
          if (!next.has(k)) options.onDestroy(prev.value[k]);

      return nextObj;
    },
  }).asReadonly();
}
