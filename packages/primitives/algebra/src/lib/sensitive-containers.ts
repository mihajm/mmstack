import {
  type Absorbing,
  isAbsorbing,
  joinAbsorbers,
} from '@mmstack/primitives/core';
import { invoke, joinAbsorbersDeep } from './algebra';
import type { ApplyFn, ArrayMethodShim } from './containers';
import {
  canonicalize,
  isLabeled,
  labelAt,
  type Level,
  levelInArrays,
  levelOf,
  markThrown,
  maxLevel,
  openUnwrap,
  raise,
  underLabel,
  unlabel,
} from './sensitive';

// The shims' branches for while sensitive values are boxed. A shim unlabels its receiver, runs
// today's schedule over the inner array, hands callbacks the elements of a boxed receiver boxed,
// and labels its whole result when the receiver was boxed or a scanned argument or verdict was
// labeled. Callbacks whose running at all follows a labeled value run as a labeled region.
//
// Two rules hold for every shim here. (A) Over a labeled receiver the whole shim runs as a labeled
// region and every answer, early returns and throws included, carries the label (`overReceiver`):
// reading its elements may run an accessor. Reads out of a labeled nested array run in the region
// too. (B) Every early return carries the labels of the operands scanned before it. Every label is
// applied at the highest level read (`Level`): a shim that read an always-sensitive operand answers
// always sensitive.

type Settled = { value: unknown } | undefined;

function open(receiver: unknown): { xs: readonly unknown[]; boxed: Level } {
  return {
    xs: unlabel(receiver) as readonly unknown[],
    boxed: levelOf(receiver),
  };
}

/** Rule (A): over a labeled receiver the shim runs as a labeled region and its answer is labeled. */
function overReceiver(shim: ArrayMethodShim): ArrayMethodShim {
  return (receiver, args, apply) => {
    const level = levelOf(receiver);
    return level
      ? labelAt(
          level,
          underLabel(() => shim(receiver, args, apply), level),
        )
      : shim(receiver, args, apply);
  };
}

function throwLabeled(level: Level, thrown: Error): never {
  if (level) markThrown(thrown, level);
  throw thrown;
}

const toIntegerOrInfinity = (value: unknown): number => {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  if (number === Infinity || number === -Infinity) return number;
  return Math.trunc(number);
};

/** Canonical (box-free at array depth) form of a coerced argument. */
const coercible = (value: unknown): unknown =>
  canonicalize(value, openUnwrap(), false);

/** Runs a coercion over `value`; over a labeled value it runs as a labeled region. */
function coerce<T>(value: unknown, run: (plain: unknown) => T): T {
  const level = levelInArrays(value);
  return level ? underLabel(() => run(coercible(value)), level) : run(value);
}

export function labeledPassthrough(
  method: string,
  scanArgs: 'all' | 'none' | readonly number[],
): ArrayMethodShim {
  const scans = (i: number): boolean =>
    scanArgs === 'all' || (scanArgs !== 'none' && scanArgs.includes(i));
  return overReceiver((receiver, args) => {
    const { xs, boxed } = open(receiver);
    const scanned = args.filter((_, i) => scans(i));
    const absorber = joinAbsorbers(scanned.map(unlabel));
    if (absorber)
      return labelAt(raise(boxed, maxLevel(scanned, levelInArrays)), absorber);
    const level = raise(boxed, maxLevel(args, levelInArrays));
    if (!level)
      return (xs as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ](...args);
    return labelAt(
      level,
      underLabel(() => {
        const plainArgs = args.map((arg, i) =>
          scans(i) ? coercible(arg) : unlabel(arg),
        );
        return (xs as unknown as Record<string, (...a: unknown[]) => unknown>)[
          method
        ](...plainArgs);
      }, level),
    );
  });
}

/**
 * `flat` reads through boxes: elements read out of a boxed array come out boxed, and the result is
 * labeled whole when any element it read was labeled (whether it spread decides the length).
 */
export const labeledFlat: ArrayMethodShim = overReceiver((receiver, args) => {
  const { xs, boxed } = open(receiver);
  const absorber = joinAbsorbers(args.map(unlabel));
  if (absorber)
    return labelAt(raise(boxed, maxLevel(args, levelInArrays)), absorber);
  let depth = coerce(args[0], (raw) =>
    raw === undefined ? 1 : toIntegerOrInfinity(raw),
  );
  if (depth < 0) depth = 0;
  const out: unknown[] = [];
  let read: Level = 0;
  const into = (
    source: readonly unknown[],
    level: number,
    fromBox: Level,
  ): void => {
    for (let i = 0; i < source.length; i++) {
      if (!(i in source)) continue;
      // Reading out of a labeled array may run an accessor: in the region.
      const element = fromBox
        ? underLabel(() => labelAt(fromBox, source[i]), fromBox)
        : source[i];
      read = raise(read, levelOf(element));
      const inner = unlabel(element);
      if (level > 0 && Array.isArray(inner))
        into(inner, level - 1, levelOf(element));
      else out.push(element);
    }
  };
  into(xs, depth, 0);
  return labelAt(raise(raise(boxed, read), levelInArrays(args[0])), out);
});

type SearchMethod = 'indexOf' | 'lastIndexOf' | 'includes';

const sameValueZero = (x: unknown, t: unknown): boolean =>
  x === t || (x !== x && t !== t);

/** Search compares canonical values of one unwrap; the prefix through the hit decides the label. */
export function labeledSearch(method: SearchMethod): ArrayMethodShim {
  return overReceiver((receiver, args) => {
    const { xs, boxed } = open(receiver);
    const argAbsorber = joinAbsorbers(args.map(unlabel));
    if (argAbsorber)
      return labelAt(raise(boxed, maxLevel(args, levelInArrays)), argAbsorber);
    const unwrap = openUnwrap();
    const len = xs.length;
    const target = canonicalize(args[0], unwrap, true);
    let labeled: Level = raise(
      raise(boxed, levelOf(args[0])),
      args.length > 1 ? levelInArrays(args[1]) : 0,
    );
    // Labeled by the prefix through the hit. Comparisons read canonical values at the top level
    // (objects by identity), so the level is that of the target and the elements scanned.
    const at = (): Level => labeled;
    const matches =
      method === 'includes'
        ? (element: unknown) => sameValueZero(element, target)
        : (element: unknown) => element === target;
    const visit = (i: number): Settled => {
      const element = xs[i];
      labeled = raise(labeled, levelOf(element));
      const plain = unlabel(element);
      if (isAbsorbing(plain)) return { value: labelAt(at(), plain) };
      if (matches(canonicalize(element, unwrap, true)))
        return { value: labelAt(at(), method === 'includes' ? true : i) };
      return undefined;
    };
    if (method === 'lastIndexOf') {
      let from =
        args.length > 1 ? coerce(args[1], toIntegerOrInfinity) : len - 1;
      if (from < 0) {
        from = len + from;
        if (from < 0) return labelAt(at(), -1);
      } else if (from > len - 1) {
        from = len - 1;
      }
      for (let i = from; i >= 0; i--) {
        const hit = visit(i);
        if (hit) return hit.value;
      }
      return labelAt(at(), -1);
    }
    let start = args.length > 1 ? coerce(args[1], toIntegerOrInfinity) : 0;
    if (start < 0) {
      start = len + start;
      if (start < 0) start = 0;
    }
    for (let i = start; i < len; i++) {
      const hit = visit(i);
      if (hit) return hit.value;
    }
    return labelAt(at(), method === 'includes' ? false : -1);
  });
}

/**
 * The callable check. An absorbing callback answers itself, labeled when the receiver is. A labeled
 * callback was chosen by a secret: the whole shim runs as a labeled region over the plain callback
 * and its result is labeled.
 */
export function labeledWithCallback(shim: ArrayMethodShim): ArrayMethodShim {
  return overReceiver((receiver, args, apply) => {
    const cb = args[0];
    const cbLevel = levelOf(cb);
    const plain = unlabel(cb);
    if (isAbsorbing(plain)) return labelAt(levelOf(receiver), cb);
    if (typeof plain !== 'function') {
      const source = cbLevel ? cb : plain;
      // Labeled as before (callback or receiver); the message's own labels only raise the level.
      const base = raise(cbLevel, levelOf(receiver));
      const level = base ? raise(base, levelInArrays(source)) : 0;
      const message = coerce(source, (p) => String(p));
      throwLabeled(level, new TypeError(`${message} is not a function`));
    }
    if (!cbLevel) return shim(receiver, args, apply);
    return labelAt(
      cbLevel,
      underLabel(
        () => shim(receiver, [plain, ...args.slice(1)], apply),
        cbLevel,
      ),
    );
  });
}

/** One callback call; once its running follows a labeled value it runs as a labeled region. */
function call(
  cb: unknown,
  args: unknown[],
  apply: ApplyFn,
  level: Level,
): unknown {
  return level
    ? underLabel(() => invoke(cb, args, apply), level)
    : invoke(cb, args, apply);
}

export const labeledMap: ArrayMethodShim = overReceiver(
  (receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    const out = xs.map((element, index) =>
      call(args[0], [labelAt(boxed, element), index], apply, boxed),
    );
    return labelAt(boxed, out);
  },
);

export const labeledFlatMap: ArrayMethodShim = overReceiver(
  (receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    const mapped = xs.map((element, index) =>
      call(args[0], [labelAt(boxed, element), index], apply, boxed),
    );
    // Whether a result spreads decides the length: any labeled element read labels the whole result.
    let read: Level = 0;
    const spreadable = mapped.map((result) => {
      const inner = unlabel(result);
      const level = levelOf(result);
      if (level) read = raise(read, level);
      else if (Array.isArray(inner))
        read = raise(read, maxLevel(inner, levelOf));
      return level && Array.isArray(inner)
        ? underLabel(() => inner.map((x) => labelAt(level, x)), level)
        : result;
    });
    return labelAt(raise(boxed, read), spreadable.flat());
  },
);

/** Verdicts are read on their inner value; a labeled verdict labels the answer and what follows. */
export function labeledDecision(
  settle: (verdict: unknown, element: unknown, index: number) => Settled,
  fallthrough: () => unknown,
  reverse: boolean,
): ArrayMethodShim {
  return overReceiver((receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    let labeled: Level = boxed;
    const last = xs.length - 1;
    for (let step = 0; step <= last; step++) {
      const index = reverse ? last - step : step;
      const element = labelAt(boxed, xs[index]);
      const verdict = call(args[0], [element, index], apply, labeled);
      labeled = raise(labeled, levelOf(verdict));
      const plain = unlabel(verdict);
      if (isAbsorbing(plain)) return labelAt(labeled, plain);
      const settled = settle(plain, element, index);
      if (settled) return labelAt(labeled, settled.value);
    }
    return labelAt(labeled, fallthrough());
  });
}

export const labeledFilter: ArrayMethodShim = overReceiver(
  (receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    let labeled: Level = boxed;
    const out: unknown[] = [];
    for (let index = 0; index < xs.length; index++) {
      const element = labelAt(boxed, xs[index]);
      const verdict = call(args[0], [element, index], apply, labeled);
      labeled = raise(labeled, levelOf(verdict));
      const plain = unlabel(verdict);
      if (isAbsorbing(plain)) return labelAt(labeled, plain);
      if (plain) out.push(element);
    }
    return labelAt(labeled, out);
  },
);

/** The accumulator is labeled by position once an element, the seed or a step was labeled. */
export const labeledReduce: ArrayMethodShim = overReceiver(
  (receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    let accumulator: unknown;
    let start: number;
    if (args.length > 1) {
      accumulator = args[1];
      start = 0;
    } else {
      if (!xs.length)
        throwLabeled(
          boxed,
          new TypeError('Reduce of empty array with no initial value'),
        );
      accumulator = labelAt(boxed, xs[0]);
      start = 1;
    }
    let labeled = raise(boxed, levelOf(accumulator));
    for (let index = start; index < xs.length; index++) {
      const element = labelAt(boxed, xs[index]);
      accumulator = call(
        args[0],
        [accumulator, element, index],
        apply,
        labeled,
      );
      labeled = raise(labeled, levelOf(accumulator));
    }
    return labelAt(labeled, accumulator);
  },
);

export const labeledJoin: ArrayMethodShim = overReceiver((receiver, args) => {
  const { xs, boxed } = open(receiver);
  const labeled = raise(
    raise(boxed, levelInArrays(xs)),
    maxLevel(args, levelInArrays),
  );
  const cellAbsorber = joinAbsorbersDeep(xs);
  if (cellAbsorber) return labelAt(labeled, unlabel(cellAbsorber));
  const argAbsorber = joinAbsorbers(args.map(unlabel));
  if (argAbsorber) return labelAt(labeled, argAbsorber);
  if (!labeled) return xs.join(args[0] as string | undefined);
  const unwrap = openUnwrap();
  const cells = canonicalize(xs, unwrap, false) as readonly unknown[];
  return labelAt(
    labeled,
    underLabel(
      () =>
        cells.join(canonicalize(args[0], unwrap, false) as string | undefined),
      labeled,
    ),
  );
});

/**
 * Default order: UTF-16 order of each element's string form, undefined last, coercing exactly what
 * the native sort coerces: nothing with fewer than two defined elements, otherwise each defined
 * element once. Precision cost: the keys of public elements beside a labeled one are built in the
 * labeled region too, so a mint inside a public `toString` is reported sensitive.
 */
function sortDefault(xs: readonly unknown[], level: Level): unknown[] {
  const unwrap = openUnwrap();
  const defined: { plain: unknown; element: unknown }[] = [];
  const undefinedOnes: unknown[] = [];
  for (const element of [...xs]) {
    const plain = canonicalize(element, unwrap, false);
    if (plain === undefined) undefinedOnes.push(element);
    else defined.push({ plain, element });
  }
  if (defined.length < 2)
    return [...defined.map((d) => d.element), ...undefinedOnes];
  const keyed = underLabel(
    () => defined.map((d) => ({ key: String(d.plain), element: d.element })),
    level,
  );
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...keyed.map((k) => k.element), ...undefinedOnes];
}

/** Every comparison the sort schedules still runs and absorbing verdicts fold, as today. */
export const labeledToSorted: ArrayMethodShim = overReceiver(
  (receiver, args, apply) => {
    const { xs, boxed } = open(receiver);
    const comparator = args[0];
    let labeled = raise(boxed, levelOf(comparator));
    const plainComparator = unlabel(comparator);
    if (plainComparator === undefined) {
      labeled = raise(labeled, levelInArrays(xs));
      const cellAbsorber = joinAbsorbersDeep(xs);
      if (cellAbsorber) return labelAt(labeled, unlabel(cellAbsorber));
      // The native sort coerces nothing with fewer than two elements.
      if (xs.length < 2) return labelAt(labeled, [...xs]);
      return labelAt(
        labeled,
        labeled ? sortDefault(xs, labeled) : [...xs].sort(),
      );
    }
    if (isAbsorbing(plainComparator)) return labelAt(labeled, comparator);
    if (typeof plainComparator !== 'function')
      throwLabeled(
        labeled,
        new TypeError(
          'The comparison function must be either a function or undefined',
        ),
      );
    const absorbers: unknown[] = [];
    // The native sort never hands `undefined` to the comparator and moves it last; a boxed undefined
    // must do the same.
    const items = [...xs];
    const defined = items.filter((x) => unlabel(x) !== undefined);
    const trailing = items.filter((x) => unlabel(x) === undefined);
    // Setting undefined aside reads every element, so with two or more a labeled one decides the order.
    if (items.length > 1) labeled = raise(labeled, maxLevel(items, levelOf));
    const sorted = defined.sort((a, b) => {
      const pair = [labelAt(boxed, a), labelAt(boxed, b)];
      const verdict = call(plainComparator, pair, apply, labeled);
      labeled = raise(labeled, levelOf(verdict));
      const plain = unlabel(verdict);
      if (isAbsorbing(plain)) {
        absorbers.push(plain);
        return 0;
      }
      // The sort coerces the verdict to a number; over a label that runs as a labeled region.
      if (labeled) return underLabel(() => Number(coercible(plain)), labeled);
      return (
        typeof plain === 'object' && plain !== null ? coercible(plain) : plain
      ) as number;
    });
    const out = trailing.length ? [...sorted, ...trailing] : sorted;
    const absorber = joinAbsorbers(absorbers);
    return labelAt(labeled, absorber ?? out);
  },
);

/** A boxed array spreads as a fresh array of boxed elements (holes read as boxed undefined). */
export function labeledSpread(source: unknown): Absorbing | readonly unknown[] {
  if (!isLabeled(source)) {
    if (isAbsorbing(source)) return source;
    if (!Array.isArray(source))
      throw new TypeError('Spread source must be an array');
    return source;
  }
  const inner = unlabel(source);
  const level = levelOf(source);
  if (isAbsorbing(inner)) return source as Absorbing;
  if (!Array.isArray(inner))
    throwLabeled(level, new TypeError('Spread source must be an array'));
  // Reading out of the labeled array may run an accessor: in the region.
  return underLabel(
    () =>
      Array.from(inner as readonly unknown[], (element) =>
        labelAt(level, element),
      ),
    level,
  );
}
