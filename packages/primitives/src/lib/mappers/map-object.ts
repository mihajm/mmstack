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

    if (active.size === spare.size && active.isSubsetOf(spare)) return active;

    const temp = active;
    active = spare;
    spare = temp;

    return active;
  });
}

type MappedObject<T extends Record<string, any>, U> = {
  [K in keyof T]: U;
};

export function mapObject<T extends Record<string, any>, U>(
  source: MutableSignal<T>,
  mapFn: <K extends keyof T>(key: K, value: MutableSignal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

export function mapObject<T extends Record<string, any>, U>(
  source: WritableSignal<T>,
  mapFn: <K extends keyof T>(key: K, value: WritableSignal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

export function mapObject<T extends Record<string, any>, U>(
  source: (() => T) | Signal<T>,
  mapFn: <K extends keyof T>(key: K, value: Signal<T[K]>) => U,
  options?: {
    onDestroy?: (value: U) => void;
  },
): Signal<MappedObject<T, U>>;

export function mapObject<T extends Record<string, any>, U>(
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
