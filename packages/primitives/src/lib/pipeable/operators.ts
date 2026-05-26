import {
  computed,
  type CreateSignalOptions,
  effect,
  type Injector,
  linkedSignal,
  type Signal,
} from '@angular/core';
import { type Operator } from './types';

/** Project with optional equality. Pure & sync. */
export const select =
  <I, O>(
    projector: (v: I) => O,
    opt?: CreateSignalOptions<O>,
  ): Operator<I, O> =>
  (src) =>
    computed(() => projector(src()), opt);

/** Combine with another signal using a projector. */
export const combineWith =
  <A, B, R>(
    other: Signal<B>,
    project: (a: A, b: B) => R,
    opt?: CreateSignalOptions<R>,
  ): Operator<A, R> =>
  (src) =>
    computed(() => project(src(), other()), opt);

/** Only re-emit when equal(prev, next) is false. */
export const distinct =
  <T>(equal: (a: T, b: T) => boolean = Object.is): Operator<T, T> =>
  (src) =>
    computed(() => src(), { equal });

/** map to new value */
export const map =
  <I, O>(fn: (v: I) => O): Operator<I, O> =>
  (src) =>
    computed(() => fn(src()));

/** filter values, keeping the last value if it was ever available, if first value is filtered will return undefined */
export const filter =
  <T>(predicate: (v: T) => boolean): Operator<T, T | undefined> =>
  (src) =>
    linkedSignal({
      source: src,
      computation: (next, prev) => {
        if (predicate(next)) return next;
        return prev?.source;
      },
    });

/** tap into the value */
export const tap =
  <T>(fn: (v: T) => void, injector?: Injector): Operator<T, T> =>
  (src) => {
    effect(() => fn(src()), {
      injector,
    });

    return src;
  };

/**
 * Like {@link filter}, but emits `initial` until a value passes the predicate
 * for the first time. Avoids the `T | undefined` return type.
 */
export const filterWith =
  <T>(predicate: (v: T) => boolean, initial: T): Operator<T, T> =>
  (src) =>
    linkedSignal<T, T>({
      source: src,
      computation: (next, prev) =>
        predicate(next) ? next : (prev?.value ?? initial),
    });

/** Emits `initial` first, then mirrors source. */
export const startWith =
  <T, U>(initial: U): Operator<T, T | U> =>
  (src) =>
    linkedSignal<T, T | U>({
      source: src,
      computation: (next, prev) => (prev === undefined ? initial : next),
    });

/** Emits `[prev, curr]` pairs. The first emission has prev = undefined. */
export const pairwise =
  <T>(): Operator<T, [T | undefined, T]> =>
  (src) =>
    linkedSignal<T, [T | undefined, T]>({
      source: src,
      computation: (next, prev) => [prev?.source, next],
    });

/** Reduce-like accumulator across emissions. */
export const scan =
  <T, R>(reducer: (acc: R, curr: T) => R, seed: R): Operator<T, R> =>
  (src) =>
    linkedSignal<T, R>({
      source: src,
      computation: (next, prev) => reducer(prev?.value ?? seed, next),
    });
