import {
  computed,
  type CreateSignalOptions,
  effect,
  type Injector,
  linkedSignal,
  type Signal,
} from '@angular/core';
import { type Operator } from './types';

/**
 * Synchronous projection of a signal value with optional `CreateSignalOptions`
 * (custom `equal`, `debugName`, etc.). Equivalent to `map` plus the ability to
 * pass signal options through to the underlying `computed()`.
 *
 * @example
 * ```ts
 * const user = piped({ id: 1, name: 'Alice' });
 * const name = user.pipe(select((u) => u.name));
 * name(); // 'Alice'
 * ```
 */
export const select =
  <I, O>(
    projector: (v: I) => O,
    opt?: CreateSignalOptions<O>,
  ): Operator<I, O> =>
  (src) =>
    computed(() => projector(src()), opt);

/**
 * Combine the piped signal with another `Signal` using a projector. The result
 * recomputes whenever either source changes.
 *
 * @example
 * ```ts
 * const price = piped(10);
 * const quantity = signal(3);
 * const total = price.pipe(combineWith(quantity, (p, q) => p * q));
 * total(); // 30
 * ```
 */
export const combineWith =
  <A, B, R>(
    other: Signal<B>,
    project: (a: A, b: B) => R,
    opt?: CreateSignalOptions<R>,
  ): Operator<A, R> =>
  (src) =>
    computed(() => project(src(), other()), opt);

/**
 * Suppress emissions while consecutive values are considered equal. The
 * comparator defaults to `Object.is`; pass a custom one for structural or
 * key-based equality (e.g. compare by `id` only).
 *
 * @example
 * ```ts
 * const user = piped({ id: 1, lastSeen: Date.now() });
 * const byId = user.pipe(distinct((a, b) => a.id === b.id));
 * // byId only re-emits when `id` changes, not on every `lastSeen` update
 * ```
 */
export const distinct =
  <T>(equal: (a: T, b: T) => boolean = Object.is): Operator<T, T> =>
  (src) =>
    computed(() => src(), { equal });

/**
 * Pure synchronous transform from input to output. Equivalent to a `computed()`
 * that reads the source and returns `fn(value)`.
 *
 * @example
 * ```ts
 * const count = piped(2);
 * const doubled = count.pipe(map((n) => n * 2));
 * doubled(); // 4
 * ```
 */
export const map =
  <I, O>(fn: (v: I) => O): Operator<I, O> =>
  (src) =>
    computed(() => fn(src()));

/**
 * Keep only values that pass the predicate. The result holds the last passing
 * value across emissions; before any value passes, the result is `undefined` —
 * see {@link filterWith} when you need a non-`undefined` seed.
 *
 * @example
 * ```ts
 * const event = piped<MouseEvent | null>(null);
 * const clicks = event.pipe(filter((e): e is MouseEvent => e?.type === 'click'));
 * clicks(); // undefined until a click happens, then the last MouseEvent
 * ```
 */
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

/**
 * Run a side effect on every emission without altering the signal value. Wraps
 * Angular's `effect()`, so it must run in an injection context or receive an
 * explicit `injector`. Use for logging / analytics — not for setting other
 * signals (that's what regular `effect()` is for).
 *
 * @example
 * ```ts
 * const count = piped(0);
 * count.pipe(tap((n) => console.log('count:', n)));
 * count.set(1); // logs 'count: 1'
 * ```
 */
export const tap =
  <T>(fn: (v: T) => void, injector?: Injector): Operator<T, T> =>
  (src) => {
    effect(() => fn(src()), {
      injector,
    });

    return src;
  };

/**
 * Like {@link filter}, but emits `initial` until a value first passes the
 * predicate. Eliminates the `T | undefined` return type at the cost of an
 * explicit seed value.
 *
 * @example
 * ```ts
 * const event = piped<MouseEvent | null>(null);
 * const lastClick = event.pipe(filterWith((e) => e?.type === 'click', null));
 * lastClick(); // null until the first click, then the most recent click event
 * ```
 */
export const filterWith =
  <T>(predicate: (v: T) => boolean, initial: T): Operator<T, T> =>
  (src) =>
    linkedSignal<T, T>({
      source: src,
      computation: (next, prev) =>
        predicate(next) ? next : (prev?.value ?? initial),
    });

/**
 * Emit `initial` on the first read, then mirror the source on every subsequent
 * read. Useful for giving a pipeline a sensible seed value before the source
 * is ready (e.g. loading state).
 *
 * @example
 * ```ts
 * const data = piped<User | null>(null);
 * const view = data.pipe(startWith<User | null, 'loading'>('loading'));
 * view(); // 'loading' on first read, then User | null afterward
 * ```
 */
export const startWith =
  <T, U>(initial: U): Operator<T, T | U> =>
  (src) =>
    linkedSignal<T, T | U>({
      source: src,
      computation: (next, prev) => (prev === undefined ? initial : next),
    });

/**
 * Emit `[prev, curr]` tuples so consumers can react to transitions instead of
 * raw values. On the first emission `prev` is `undefined`.
 *
 * @example
 * ```ts
 * const count = piped(0);
 * const delta = count.pipe(pairwise(), map(([prev, curr]) => curr - (prev ?? 0)));
 * count.set(5);
 * delta(); // 5
 * ```
 */
export const pairwise =
  <T>(): Operator<T, [T | undefined, T]> =>
  (src) =>
    linkedSignal<T, [T | undefined, T]>({
      source: src,
      computation: (next, prev) => [prev?.source, next],
    });

/**
 * Reduce-like accumulator that folds each emission into a running result.
 * Behaves like `Array.prototype.reduce` but applied over time, with the
 * accumulator persisted across emissions.
 *
 * @example
 * ```ts
 * const delta = piped(0);
 * const total = delta.pipe(scan((acc, n) => acc + n, 0));
 * delta.set(5); // total() === 5
 * delta.set(3); // total() === 8
 * ```
 */
export const scan =
  <T, R>(reducer: (acc: R, curr: T) => R, seed: R): Operator<T, R> =>
  (src) =>
    linkedSignal<T, R>({
      source: src,
      computation: (next, prev) => reducer(prev?.value ?? seed, next),
    });
