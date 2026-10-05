import { computed, type Signal, type ValueEqualityFn } from '@angular/core';
import { joinAbsorbers } from '../semantics/algebra';
import {
  type Done,
  isAbsorbing,
  isDone,
  isLoading,
} from '../semantics/sentinel';
import { type Precedence } from './census';
import { demandOf } from './demand';
import { type UseSource } from './latest';
import { createEdgeMemo, type Outcome, outcomeErrorCause } from './outcome';

/**
 * An outcome read as one tagged value: `pending` is its own tag (with the `loading` sentinel's
 * `source`), `error` carries the failure, `value` everything settled.
 */
export type Result<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'pending'; readonly source: unknown }
  | { readonly kind: 'error'; readonly error: unknown };

export type JoinedOptions<R> = {
  /** Which absorber wins when several sources have none to give. Default `'pending-first'`. */
  readonly precedence?: Precedence;
  /** Equality for the `value` tag only. Default: `Object.is`, element-wise for the tuple form. */
  readonly equal?: ValueEqualityFn<R>;
};

const settled = new WeakMap<object, Result<never>>();

/**
 * Reads one outcome as a {@link Result}: a value (or `undefined`, or `DONE`, which settles with no
 * payload) is `value`; `loading` is `pending` with its `source`; an error sentinel is `error` with
 * the failure it stands for when known (an `outcome()` edge, a `latest` throw), else the sentinel.
 * The same sentinel always gives the same result object.
 */
export function settle<T>(outcome: Outcome<T> | Done): Result<T | undefined> {
  if (isDone(outcome)) return { kind: 'value', value: undefined };
  if (!isAbsorbing(outcome)) return { kind: 'value', value: outcome };
  let result = settled.get(outcome);
  if (!result) {
    result = isLoading(outcome)
      ? { kind: 'pending', source: outcome.source }
      : {
          kind: 'error',
          error: (outcomeErrorCause(outcome) ?? { cause: outcome }).cause,
        };
    settled.set(outcome, result);
  }
  return result;
}

type Values<S extends readonly UseSource<unknown>[]> = {
  -readonly [K in keyof S]: S[K] extends UseSource<infer T> ? T : never;
};

const isSource = (arg: unknown): arg is UseSource<unknown> =>
  (typeof arg === 'object' || typeof arg === 'function') &&
  arg !== null &&
  typeof (arg as { status?: unknown }).status === 'function';

const sameElements = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Independent reads of several sources as one tagged {@link Result}: each source's demand outcome
 * (as `use()` reads it, so an idle source with nothing to show is pending), absorbers joined under
 * `precedence`, `value` only when every source has one. A plain `computed`: no collector frame, and
 * nothing throws out of it; a throw inside `fn` becomes an `error` result.
 *
 * ```ts
 * const card = joined(user, org, (u, o) => `${u.name} @ ${o.name}`);
 * card(); // { kind: 'value', value: '…' } | { kind: 'pending', source } | { kind: 'error', error }
 * ```
 *
 * Waterfalls (a read that depends on another's value) stay `latest` + `use`.
 */
export function joined<A, R>(
  a: UseSource<A>,
  fn: (a: A) => R,
  options?: JoinedOptions<NoInfer<R>>,
): Signal<Result<R>>;
export function joined<A, B, R>(
  a: UseSource<A>,
  b: UseSource<B>,
  fn: (a: A, b: B) => R,
  options?: JoinedOptions<NoInfer<R>>,
): Signal<Result<R>>;
export function joined<A, B, C, R>(
  a: UseSource<A>,
  b: UseSource<B>,
  c: UseSource<C>,
  fn: (a: A, b: B, c: C) => R,
  options?: JoinedOptions<NoInfer<R>>,
): Signal<Result<R>>;
export function joined<A, B, C, D, R>(
  a: UseSource<A>,
  b: UseSource<B>,
  c: UseSource<C>,
  d: UseSource<D>,
  fn: (a: A, b: B, c: C, d: D) => R,
  options?: JoinedOptions<NoInfer<R>>,
): Signal<Result<R>>;
export function joined<const S extends readonly UseSource<unknown>[], R>(
  ...args: [...sources: S, fn: (...values: Values<S>) => R]
): Signal<Result<R>>;
export function joined<const S extends readonly UseSource<unknown>[]>(
  ...sources: S
): Signal<Result<Values<S>>>;
export function joined<const S extends readonly UseSource<unknown>[]>(
  ...args: [...sources: S, options: JoinedOptions<NoInfer<Values<S>>>]
): Signal<Result<Values<S>>>;
export function joined(...args: unknown[]): Signal<Result<unknown>> {
  let options: JoinedOptions<unknown> | undefined;
  let fn: ((...values: unknown[]) => unknown) | undefined;
  let end = args.length;
  const last = args[end - 1];
  if (end > 0 && !isSource(last) && typeof last === 'object') {
    options = last as JoinedOptions<unknown>;
    end--;
  }
  const next = args[end - 1];
  if (end > 0 && !isSource(next) && typeof next === 'function') {
    fn = next as (...values: unknown[]) => unknown;
    end--;
  }
  const sources = args.slice(0, end) as UseSource<unknown>[];
  const precedence = options?.precedence ?? 'pending-first';
  const equalValue: ValueEqualityFn<unknown> =
    options?.equal ??
    (fn ? Object.is : (a, b) => sameElements(a as unknown[], b as unknown[]));
  const thrownEdge = createEdgeMemo();

  return computed<Result<unknown>>(
    () => {
      try {
        const demands = sources.map(demandOf);
        const absorber = joinAbsorbers(demands, precedence);
        if (absorber) return settle(absorber);
        const values = demands.map((d) => (isDone(d) ? undefined : d));
        if (!fn) return { kind: 'value', value: values };
        return { kind: 'value', value: fn(...values) };
      } catch (e) {
        return settle(isAbsorbing(e) ? e : thrownEdge(e));
      }
    },
    {
      equal: (a, b) =>
        a === b ||
        (a.kind === 'value' &&
          b.kind === 'value' &&
          equalValue(a.value, b.value)),
    },
  );
}
