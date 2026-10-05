import { type Absorbing, isAbsorbing, isSentinelAware } from './sentinel';

export type Thunk = () => unknown;

/**
 * Ascending join precedence for the absorbing kinds. The SOLE order of record — a change here is a
 * deliberate flip, guarded by a pinned literal witness; never duplicated.
 */
export const ABSORBER_PRECEDENCE = Object.freeze(['error', 'loading'] as const);

/**
 * Which absorber wins a join: `'pending-first'` (the default, {@link ABSORBER_PRECEDENCE}) ranks
 * `loading` above `error`, because nothing with a member still in flight is settled;
 * `'error-first'` inverts it, so a failure presents while others still load.
 */
type AbsorberOrder = 'pending-first' | 'error-first';

function absorberRank(value: unknown, order: AbsorberOrder): number {
  if (!isAbsorbing(value)) return -1;
  const rank = ABSORBER_PRECEDENCE.indexOf(value.kind);
  return order === 'error-first' ? ABSORBER_PRECEDENCE.length - 1 - rank : rank;
}

function higherAbsorber(
  left: unknown,
  right: unknown,
  order: AbsorberOrder = 'pending-first',
): Absorbing | undefined {
  const rankRight = absorberRank(right, order);
  if (rankRight < 0) return isAbsorbing(left) ? left : undefined;
  const rankLeft = absorberRank(left, order);
  if (rankLeft < 0) return right as Absorbing;
  return rankRight > rankLeft ? (right as Absorbing) : (left as Absorbing);
}

/**
 * The central join replacing every first-found sentinel scan, over all syntactically-evaluated
 * operands. Associative — folding left-to-right is what lets a construct's per-site joins compose
 * into one operation-wide join. Ties keep the leftmost operand. `order` defaults to
 * `'pending-first'`; pass `'error-first'` to let a failure outrank work still in flight.
 */
export function joinAbsorbers(
  operands: readonly unknown[],
  order: AbsorberOrder = 'pending-first',
): Absorbing | undefined {
  let winner: Absorbing | undefined;
  for (const operand of operands)
    winner = higherAbsorber(winner, operand, order);
  return winner;
}

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
    if (isAbsorbing(value)) winner = higherAbsorber(winner, value);
    else if (Array.isArray(value))
      winner = higherAbsorber(winner, joinAbsorbersDeep(value));
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
  return higherAbsorber(left, right) ?? apply(left, right);
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
  const absorber = higherAbsorber(target, joinAbsorbers(args));
  if (absorber) return absorber;
  return apply(target, args);
}
