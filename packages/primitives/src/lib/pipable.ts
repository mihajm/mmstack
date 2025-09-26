import {
  computed,
  signal,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/**
 * A pure, synchronous transform from I -> O.
 * Prefer transforms without side effects to keep derivations predictable.
 */

type UnaryFunction<I, O> = (a: I) => O;

/**
 * A strongly-typed `.pipe(...)` method specialized to an input type `In`.
 *
 * Each overload composes the provided transforms left-to-right and returns a
 * **computed** signal that is itself "pipable", so you can continue chaining.
 *
 * Notes:
 * - No-arg form returns the same pipable signal (no extra computed layer).
 * - Transforms must be synchronous (Promises are not awaited inside `computed`).
 * - Keep transforms pure—no side effects inside derivations.
 */
type SignalPipe<In> = {
  (): PipeableSignal<In>;
  <A>(
    fn1: UnaryFunction<In, A>,
    opt?: CreateSignalOptions<A>,
  ): PipeableSignal<A>;
  <A, B>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    opt?: CreateSignalOptions<B>,
  ): PipeableSignal<B>;
  <A, B, C>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    opt?: CreateSignalOptions<C>,
  ): PipeableSignal<C>;
  <A, B, C, D>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    opt?: CreateSignalOptions<D>,
  ): PipeableSignal<D>;
  <A, B, C, D, E>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    fn5: UnaryFunction<D, E>,
    opt?: CreateSignalOptions<E>,
  ): PipeableSignal<E>;
  <A, B, C, D, E, F>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    fn5: UnaryFunction<D, E>,
    fn6: UnaryFunction<E, F>,
    opt?: CreateSignalOptions<F>,
  ): PipeableSignal<F>;
  <A, B, C, D, E, F, G>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    fn5: UnaryFunction<D, E>,
    fn6: UnaryFunction<E, F>,
    fn7: UnaryFunction<F, G>,
    opt?: CreateSignalOptions<G>,
  ): PipeableSignal<G>;
  <A, B, C, D, E, F, G, H>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    fn5: UnaryFunction<D, E>,
    fn6: UnaryFunction<E, F>,
    fn7: UnaryFunction<F, G>,
    fn8: UnaryFunction<G, H>,
    opt?: CreateSignalOptions<H>,
  ): PipeableSignal<H>;
  <A, B, C, D, E, F, G, H, I>(
    fn1: UnaryFunction<In, A>,
    fn2: UnaryFunction<A, B>,
    fn3: UnaryFunction<B, C>,
    fn4: UnaryFunction<C, D>,
    fn5: UnaryFunction<D, E>,
    fn6: UnaryFunction<E, F>,
    fn7: UnaryFunction<F, G>,
    fn8: UnaryFunction<G, H>,
    fn9: UnaryFunction<H, I>,
    ...rest: UnaryFunction<any, any>[]
  ): PipeableSignal<unknown>;
};

/**
 * A `Signal<T>` augmented with a chainable `.pipe(...)` method.
 *
 * The `.pipe(...)` returns **computed** signals wrapped with the same method,
 * allowing fluent, strongly-typed pipelines.
 * @see {@link SignalPipe}
 * @example
 * ```ts
 * import { piped } from '@ngrx/signals';
 *
 * const count = piped(1);
 *
 * const doubled = count.pipe(x => x * 2); // PipeableSignal<number>
 * // doubled() === 2
 * const toString = doubled.pipe(String); // PipeableSignal<string>
 * // toString() === '2'
 * ```
 */
export type PipeableSignal<T, TSig extends Signal<T> = Signal<T>> = TSig & {
  /** Chain pure transforms to derive new signals. See {@link SignalPipe}. */
  pipe: SignalPipe<T>;
};

/**
 * Helper type to infer the value type of a signal.
 * @internal
 */
type SignalValue<TSig extends Signal<any>> =
  TSig extends Signal<infer V> ? V : never;

/**
 * Decorate any `Signal<T>` with a chainable `.pipe(...)` method.
 *
 * @example
 * const s = pipeable(signal(1)); // WritableSignal<number> (+ pipe)
 * const label = s.pipe(n => n * 2, n => `#${n}`); // Signal<string> (+ pipe)
 * label(); // "#2"
 */
export function pipeable<TSig extends Signal<any>>(
  signal: TSig,
): PipeableSignal<SignalValue<TSig>, TSig> {
  const internal = signal as PipeableSignal<SignalValue<TSig>, TSig>;

  const pipeImpl = (...fns: UnaryFunction<any, any>[]) => {
    const last = fns.at(-1);
    let opt: CreateSignalOptions<any> | undefined;
    if (last && typeof last !== 'function') {
      fns = fns.slice(0, -1);
      opt = last;
    }

    if (fns.length === 0) return internal;

    if (fns.length === 1) {
      const fn = fns[0];
      return pipeable(computed(() => fn(internal()), opt));
    }

    const transformer = (input: any) => fns.reduce((acc, fn) => fn(acc), input);

    return pipeable(computed(() => transformer(internal()), opt));
  };

  Object.defineProperty(internal, 'pipe', {
    value: pipeImpl,
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return internal;
}

/**
 * Create a new **writable** signal and return it as a `PipableSignal`.
 *
 * The returned value is a `WritableSignal<T>` with `.set`, `.update`, `.asReadonly`
 * still available (via intersection type), plus a chainable `.pipe(...)`.
 *
 * @example
 * const count = piped(1); // WritableSignal<number> (+ pipe)
 * const even = count.pipe(n => n % 2 === 0); // Signal<boolean> (+ pipe)
 * count.update(n => n + 1);
 */
export function piped<T>(
  initial: T,
  opt?: CreateSignalOptions<T>,
): PipeableSignal<T, WritableSignal<T>> {
  return pipeable(signal(initial, opt));
}
