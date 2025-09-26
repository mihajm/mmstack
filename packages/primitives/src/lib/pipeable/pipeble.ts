import {
  computed,
  signal,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import type {
  Operator,
  PipeableSignal,
  SignalValue,
  UnaryFunction,
} from './types';

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

  const mapImpl = (...fns: UnaryFunction<any, any>[]) => {
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

  const pipeImpl = (...ops: Operator<any, any>[]) => {
    if (ops.length === 0) return internal;
    return ops.reduce<PipeableSignal<any>>(
      (src, op) => pipeable(op(src)),
      internal as PipeableSignal<any>,
    );
  };

  Object.defineProperties(internal, {
    map: {
      value: mapImpl,
      configurable: true,
      enumerable: false,
      writable: false,
    },

    pipe: {
      value: pipeImpl,
      configurable: true,
      enumerable: false,
      writable: false,
    },
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
