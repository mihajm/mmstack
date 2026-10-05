import {
  type Absorbing,
  isAbsorbing,
  isSentinelAware,
  joinAbsorbers,
} from '@mmstack/primitives/core';

export type Thunk = () => unknown;

/**
 * Like {@link joinAbsorbers} but recursing through nested ARRAYS ONLY, matching the depth at which
 * `Array.prototype.toString`/`join` coerce their elements — plain objects are NOT descended (they
 * stringify as `[object Object]` without recursing). Lets the content-coercing shims convert a
 * would-be leak into a ranked propagation at every depth native coercion would actually reach.
 */
export function joinAbsorbersDeep(
  values: readonly unknown[],
): Absorbing | undefined {
  let winner: Absorbing | undefined;
  for (const value of values) {
    if (isAbsorbing(value)) winner = joinAbsorbers([winner, value]);
    else if (Array.isArray(value))
      winner = joinAbsorbers([winner, joinAbsorbersDeep(value)]);
  }
  return winner;
}

export function strictUnary(
  value: unknown,
  apply: (value: unknown) => unknown,
): unknown {
  return isAbsorbing(value) ? value : apply(value);
}

export function strictBinary(
  left: unknown,
  right: unknown,
  apply: (left: unknown, right: unknown) => unknown,
): unknown {
  return joinAbsorbers([left, right]) ?? apply(left, right);
}

export function and(left: unknown, right: Thunk): unknown {
  if (isAbsorbing(left)) return left;
  return left ? right() : left;
}

export function or(left: unknown, right: Thunk): unknown {
  if (isAbsorbing(left)) return left;
  return left ? left : right();
}

export function coalesce(left: unknown, right: Thunk): unknown {
  if (isAbsorbing(left)) return left;
  return left != null ? left : right();
}

export function conditional(
  test: unknown,
  whenTrue: Thunk,
  whenFalse: Thunk,
): unknown {
  if (isAbsorbing(test)) return test;
  return test ? whenTrue() : whenFalse();
}

export function member(
  object: unknown,
  read: (object: unknown) => unknown,
): unknown {
  return isAbsorbing(object) ? object : read(object);
}

/**
 * A call joins the callee with ALL its arguments before the not-callable structural check, so a
 * higher-precedence pending argument outranks an error callee or the TypeError a non-callable
 * target would throw. A sentinel-AWARE target is exempt — it receives its raw arguments.
 */
export function invoke(
  target: unknown,
  args: readonly unknown[],
  apply: (target: unknown, args: readonly unknown[]) => unknown,
): unknown {
  if (isSentinelAware(target)) return apply(target, args);
  const absorber = joinAbsorbers([target, joinAbsorbers(args)]);
  if (absorber) return absorber;
  return apply(target, args);
}
