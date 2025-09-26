import type { CreateSignalOptions, Signal } from '@angular/core';

/**
 * A pure, synchronous transform from I -> O.
 * Prefer transforms without side effects to keep derivations predictable.
 */
export type UnaryFunction<I, O> = (a: I) => O;

/** An Operator transforms a source Signal<I> into a derived Signal<O>. */
export type Operator<I, O> = (src: Signal<I>) => Signal<O>;

type SignalMap<In> = {
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

/** `.pipe(...)` — compose operators (Signal -> Signal). */
type SignalPipe<In> = {
  (): PipeableSignal<In>;
  <A>(op1: Operator<In, A>): PipeableSignal<A>;
  <A, B>(op1: Operator<In, A>, op2: Operator<A, B>): PipeableSignal<B>;
  <A, B, C>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
  ): PipeableSignal<C>;
  <A, B, C, D>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
  ): PipeableSignal<D>;
  <A, B, C, D, E>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
    op5: Operator<D, E>,
  ): PipeableSignal<E>;
  <A, B, C, D, E, F>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
    op5: Operator<D, E>,
    op6: Operator<E, F>,
  ): PipeableSignal<F>;
  <A, B, C, D, E, F, G>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
    op5: Operator<D, E>,
    op6: Operator<E, F>,
    op7: Operator<F, G>,
  ): PipeableSignal<G>;
  <A, B, C, D, E, F, G, H>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
    op5: Operator<D, E>,
    op6: Operator<E, F>,
    op7: Operator<F, G>,
    op8: Operator<G, H>,
  ): PipeableSignal<H>;
  <A, B, C, D, E, F, G, H, I>(
    op1: Operator<In, A>,
    op2: Operator<A, B>,
    op3: Operator<B, C>,
    op4: Operator<C, D>,
    op5: Operator<D, E>,
    op6: Operator<E, F>,
    op7: Operator<F, G>,
    op8: Operator<G, H>,
    op9: Operator<H, I>,
    ...rest: Operator<any, any>[]
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
  pipe: SignalPipe<T>;
  /** Chain pure transforms to derive new signals. See {@link SignalMap}. */
  map: SignalMap<T>;
};

/**
 * Helper type to infer the value type of a signal.
 * @internal
 */
export type SignalValue<TSig extends Signal<any>> =
  TSig extends Signal<infer V> ? V : never;
