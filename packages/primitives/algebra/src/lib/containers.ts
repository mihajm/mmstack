import {
  type Absorbing,
  isAbsorbing,
  joinAbsorbers,
} from '@mmstack/primitives/core';
import { invoke, joinAbsorbersDeep } from './algebra';

export type ApplyFn = (target: unknown, args: readonly unknown[]) => unknown;

export type ArrayMethodShim = (
  receiver: readonly unknown[],
  args: readonly unknown[],
  apply: ApplyFn,
) => unknown;

export function spreadArray(source: unknown): Absorbing | readonly unknown[] {
  if (isAbsorbing(source)) return source;
  if (!Array.isArray(source)) {
    throw new TypeError('Spread source must be an array');
  }
  return source;
}

const passthroughShim =
  (
    method: string,
    scanArgs: 'all' | 'none' | readonly number[] = 'all',
  ): ArrayMethodShim =>
  (receiver, args) => {
    if (scanArgs === 'all') {
      const argAbsorber = joinAbsorbers(args);
      if (argAbsorber) return argAbsorber;
    } else if (scanArgs !== 'none') {
      const scanned = joinAbsorbers(scanArgs.map((i) => args[i]));
      if (scanned) return scanned;
    }
    return (
      receiver as unknown as Record<string, (...fnArgs: unknown[]) => unknown>
    )[method](...args);
  };

type SearchMethod = 'indexOf' | 'lastIndexOf' | 'includes';

const toIntegerOrInfinity = (value: unknown): number => {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  if (number === Infinity || number === -Infinity) return number;
  return Math.trunc(number);
};

const sameValueZero = (x: unknown, t: unknown): boolean =>
  x === t || (x !== x && t !== t);

const searchShim =
  (method: SearchMethod): ArrayMethodShim =>
  (receiver, args) => {
    const argAbsorber = joinAbsorbers(args);
    if (argAbsorber) return argAbsorber;
    const len = receiver.length;
    const target = args[0];
    const matches =
      method === 'includes'
        ? (element: unknown) => sameValueZero(element, target)
        : (element: unknown) => element === target;

    if (method === 'lastIndexOf') {
      let from = args.length > 1 ? toIntegerOrInfinity(args[1]) : len - 1;
      if (from < 0) {
        from = len + from;
        if (from < 0) return -1;
      } else if (from > len - 1) {
        from = len - 1;
      }
      for (let i = from; i >= 0; i--) {
        const element = receiver[i];
        if (isAbsorbing(element)) return element;
        if (matches(element)) return i;
      }
      return -1;
    }

    let start = args.length > 1 ? toIntegerOrInfinity(args[1]) : 0;
    if (start < 0) {
      start = len + start;
      if (start < 0) start = 0;
    }
    for (let i = start; i < len; i++) {
      const element = receiver[i];
      if (isAbsorbing(element)) return element;
      if (matches(element)) return method === 'includes' ? true : i;
    }
    return method === 'includes' ? false : -1;
  };

/**
 * The IsCallable precondition shared by every callback-taking shim: pending outranks the structural
 * throw. Without it, an EMPTY receiver never invokes the callback, so `[].map(5)` would silently
 * answer instead of throwing.
 */
const withCallback =
  (shim: ArrayMethodShim): ArrayMethodShim =>
  (receiver, args, apply) => {
    const cb = args[0];
    if (isAbsorbing(cb)) return cb;
    if (typeof cb !== 'function')
      throw new TypeError(`${String(cb)} is not a function`);
    return shim(receiver, args, apply);
  };

const shimMap: ArrayMethodShim = (receiver, args, apply) =>
  receiver.map((element, index) => invoke(args[0], [element, index], apply));

const shimFlatMap: ArrayMethodShim = (receiver, args, apply) =>
  (shimMap(receiver, args, apply) as unknown[]).flat();

type Settled = { value: unknown } | undefined;

const decisionShim =
  (
    settle: (verdict: unknown, element: unknown, index: number) => Settled,
    fallthrough: () => unknown,
    reverse = false,
  ): ArrayMethodShim =>
  (receiver, args, apply) => {
    const last = receiver.length - 1;
    for (let step = 0; step <= last; step++) {
      const index = reverse ? last - step : step;
      const verdict = invoke(args[0], [receiver[index], index], apply);
      if (isAbsorbing(verdict)) return verdict;
      const settled = settle(verdict, receiver[index], index);
      if (settled) return settled.value;
    }
    return fallthrough();
  };

const shimFilter: ArrayMethodShim = (receiver, args, apply) => {
  const out: unknown[] = [];
  for (let index = 0; index < receiver.length; index++) {
    const verdict = invoke(args[0], [receiver[index], index], apply);
    if (isAbsorbing(verdict)) return verdict;
    if (verdict) out.push(receiver[index]);
  }
  return out;
};

const shimReduce: ArrayMethodShim = (receiver, args, apply) => {
  let accumulator: unknown;
  let start: number;
  if (args.length > 1) {
    accumulator = args[1];
    start = 0;
  } else {
    if (!receiver.length)
      throw new TypeError('Reduce of empty array with no initial value');
    accumulator = receiver[0];
    start = 1;
  }
  for (let index = start; index < receiver.length; index++) {
    accumulator = invoke(args[0], [accumulator, receiver[index], index], apply);
  }
  return accumulator;
};

const shimJoin: ArrayMethodShim = (receiver, args) => {
  const cellAbsorber = joinAbsorbersDeep(receiver);
  if (cellAbsorber) return cellAbsorber;
  const argAbsorber = joinAbsorbers(args);
  if (argAbsorber) return argAbsorber;
  return receiver.join(args[0] as string | undefined);
};

/**
 * Collects every absorbing comparison and joins them by precedence rather than aborting on the
 * first, so the result kind is schedule-independent. Every comparison the sort schedules still
 * runs — a pure comparator, so extra doomed calls are harmless.
 */
const shimToSorted: ArrayMethodShim = (receiver, args, apply) => {
  const comparator = args[0];
  if (comparator === undefined) {
    const cellAbsorber = joinAbsorbersDeep(receiver);
    if (cellAbsorber) return cellAbsorber;
    return [...receiver].sort();
  }
  if (isAbsorbing(comparator)) return comparator;
  if (typeof comparator !== 'function') {
    throw new TypeError(
      'The comparison function must be either a function or undefined',
    );
  }
  const absorbers: unknown[] = [];
  const out = [...receiver].sort((a, b) => {
    const verdict = invoke(comparator, [a, b], apply);
    if (isAbsorbing(verdict)) {
      absorbers.push(verdict);
      return 0;
    }
    return verdict as number;
  });
  return joinAbsorbers(absorbers) ?? out;
};

export const ARRAY_METHOD_SHIMS: Readonly<Record<string, ArrayMethodShim>> =
  Object.freeze({
    at: passthroughShim('at'),
    concat: passthroughShim('concat', 'none'),
    slice: passthroughShim('slice'),
    includes: searchShim('includes'),
    indexOf: searchShim('indexOf'),
    lastIndexOf: searchShim('lastIndexOf'),
    flat: passthroughShim('flat'),
    toReversed: passthroughShim('toReversed'),
    toSpliced: passthroughShim('toSpliced', [0, 1]),
    with: passthroughShim('with', [0]),
    join: shimJoin,
    toSorted: shimToSorted,
    map: withCallback(shimMap),
    flatMap: withCallback(shimFlatMap),
    filter: withCallback(shimFilter),
    reduce: withCallback(shimReduce),
    find: withCallback(
      decisionShim(
        (verdict, element) => (verdict ? { value: element } : undefined),
        () => undefined,
      ),
    ),
    findIndex: withCallback(
      decisionShim(
        (verdict, _, index) => (verdict ? { value: index } : undefined),
        () => -1,
      ),
    ),
    findLast: withCallback(
      decisionShim(
        (verdict, element) => (verdict ? { value: element } : undefined),
        () => undefined,
        true,
      ),
    ),
    findLastIndex: withCallback(
      decisionShim(
        (verdict, _, index) => (verdict ? { value: index } : undefined),
        () => -1,
        true,
      ),
    ),
    some: withCallback(
      decisionShim(
        (verdict) => (verdict ? { value: true } : undefined),
        () => false,
      ),
    ),
    every: withCallback(
      decisionShim(
        (verdict) => (verdict ? undefined : { value: false }),
        () => true,
      ),
    ),
  });
