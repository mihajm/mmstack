import {
  type Absorbing,
  isAbsorbing,
  isSentinelAware,
  joinAbsorbers,
} from '@mmstack/primitives/core';
import {
  canonicalize,
  isLabeled,
  label,
  labeledInArrays,
  mapBack,
  markingThrows,
  openUnwrap,
  SENSITIVE_POLICY,
  underLabel,
  unlabel,
} from './sensitive';

export type Thunk = () => unknown;

/**
 * Like {@link joinAbsorbers} but recursing through nested ARRAYS ONLY, matching the depth at which
 * `Array.prototype.toString`/`join` coerce their elements — plain objects are NOT descended (they
 * stringify as `[object Object]` without recursing). Lets the content-coercing shims convert a
 * would-be leak into a ranked propagation at every depth native coercion would actually reach.
 * While sensitive values are boxed it also looks through boxes, and the winner is labeled when a
 * label was crossed on the way.
 */
export function joinAbsorbersDeep(
  values: readonly unknown[],
): Absorbing | undefined {
  if (SENSITIVE_POLICY.mode) return labeledJoinDeep(values);
  let winner: Absorbing | undefined;
  for (const value of values) {
    if (isAbsorbing(value)) winner = joinAbsorbers([winner, value]);
    else if (Array.isArray(value))
      winner = joinAbsorbers([winner, joinAbsorbersDeep(value)]);
  }
  return winner;
}

function labeledJoinDeep(values: readonly unknown[]): Absorbing | undefined {
  const unwrap = openUnwrap();
  const winner = joinCanonical(
    canonicalize(values, unwrap, false) as readonly unknown[],
  );
  return winner && unwrap.found ? (label(winner) as Absorbing) : winner;
}

function joinCanonical(values: readonly unknown[]): Absorbing | undefined {
  let winner: Absorbing | undefined;
  for (const value of values) {
    if (isAbsorbing(value)) winner = joinAbsorbers([winner, value]);
    else if (Array.isArray(value))
      winner = joinAbsorbers([winner, joinCanonical(value)]);
  }
  return winner;
}

export function strictUnary(
  value: unknown,
  apply: (value: unknown) => unknown,
): unknown {
  if (SENSITIVE_POLICY.mode) return labeledUnary(value, apply);
  return isAbsorbing(value) ? value : apply(value);
}

export function strictBinary(
  left: unknown,
  right: unknown,
  apply: (left: unknown, right: unknown) => unknown,
): unknown {
  if (SENSITIVE_POLICY.mode) return labeledBinary(left, right, apply);
  return joinAbsorbers([left, right]) ?? apply(left, right);
}

export function and(left: unknown, right: Thunk): unknown {
  if (SENSITIVE_POLICY.mode) return labeledAnd(left, right);
  if (isAbsorbing(left)) return left;
  return left ? right() : left;
}

export function or(left: unknown, right: Thunk): unknown {
  if (SENSITIVE_POLICY.mode) return labeledOr(left, right);
  if (isAbsorbing(left)) return left;
  return left ? left : right();
}

export function coalesce(left: unknown, right: Thunk): unknown {
  if (SENSITIVE_POLICY.mode) return labeledCoalesce(left, right);
  if (isAbsorbing(left)) return left;
  return left != null ? left : right();
}

export function conditional(
  test: unknown,
  whenTrue: Thunk,
  whenFalse: Thunk,
): unknown {
  if (SENSITIVE_POLICY.mode)
    return labeledConditional(test, whenTrue, whenFalse);
  if (isAbsorbing(test)) return test;
  return test ? whenTrue() : whenFalse();
}

export function member(
  object: unknown,
  read: (object: unknown) => unknown,
): unknown {
  if (SENSITIVE_POLICY.mode) return labeledMember(object, read);
  return isAbsorbing(object) ? object : read(object);
}

/**
 * A call joins the callee with ALL its arguments before the not-callable structural check, so a
 * higher-precedence pending argument outranks an error callee or the TypeError a non-callable
 * target would throw. A sentinel-AWARE target is exempt — it receives its raw arguments.
 * While sensitive values are boxed, an aware target still receives the raw arguments (boxes
 * included) and its result is labeled when an argument is; any other target receives one canonical
 * copy per argument value, and its result maps back to the original it is a copy of. A labeled
 * target runs the whole call as a labeled region.
 */
export function invoke(
  target: unknown,
  args: readonly unknown[],
  apply: (target: unknown, args: readonly unknown[]) => unknown,
): unknown {
  if (SENSITIVE_POLICY.mode) return labeledInvoke(target, args, apply);
  if (isSentinelAware(target)) return apply(target, args);
  const absorber = joinAbsorbers([target, joinAbsorbers(args)]);
  if (absorber) return absorber;
  return apply(target, args);
}

// The mode-on branches live out of line so each hook stays as small as it is today. Each starts
// with the WeakSet test; an unlabeled operand takes today's path.

/** The test position: the branch is chosen on the inner value, and its result is labeled. */
function labeledTest(
  left: unknown,
  right: Thunk,
  takesRight: (test: unknown) => boolean,
): unknown {
  const plain = unlabel(left);
  if (isAbsorbing(plain)) return left;
  return takesRight(plain) ? label(underLabel(right)) : left;
}

function labeledAnd(left: unknown, right: Thunk): unknown {
  if (isLabeled(left)) return labeledTest(left, right, (test) => !!test);
  if (isAbsorbing(left)) return left;
  return left ? right() : left;
}

function labeledOr(left: unknown, right: Thunk): unknown {
  if (isLabeled(left)) return labeledTest(left, right, (test) => !test);
  if (isAbsorbing(left)) return left;
  return left ? left : right();
}

function labeledCoalesce(left: unknown, right: Thunk): unknown {
  if (isLabeled(left)) return labeledTest(left, right, (test) => test == null);
  if (isAbsorbing(left)) return left;
  return left != null ? left : right();
}

function labeledConditional(
  test: unknown,
  whenTrue: Thunk,
  whenFalse: Thunk,
): unknown {
  if (!isLabeled(test)) {
    if (isAbsorbing(test)) return test;
    return test ? whenTrue() : whenFalse();
  }
  const plain = unlabel(test);
  if (isAbsorbing(plain)) return test;
  return label(underLabel(plain ? whenTrue : whenFalse));
}

function labeledMember(
  object: unknown,
  read: (object: unknown) => unknown,
): unknown {
  if (!isLabeled(object)) return isAbsorbing(object) ? object : read(object);
  const plain = unlabel(object);
  if (isAbsorbing(plain)) return object;
  return label(underLabel(() => read(plain)));
}

function labeledUnary(
  value: unknown,
  apply: (value: unknown) => unknown,
): unknown {
  const labeled = labeledInArrays(value);
  const plain = unlabel(value);
  if (isAbsorbing(plain)) return labeled ? label(plain) : plain;
  if (!labeled) return apply(value);
  const unwrap = openUnwrap();
  const operand = canonicalize(value, unwrap, false);
  return label(
    mapBack(
      underLabel(() => apply(operand)),
      unwrap,
    ),
  );
}

function labeledBinary(
  left: unknown,
  right: unknown,
  apply: (left: unknown, right: unknown) => unknown,
): unknown {
  const labeled = labeledInArrays(left) || labeledInArrays(right);
  const absorber = joinAbsorbers([unlabel(left), unlabel(right)]);
  if (absorber) return labeled ? label(absorber) : absorber;
  if (!labeled) return apply(left, right);
  const unwrap = openUnwrap();
  const a = canonicalize(left, unwrap, false);
  const b = canonicalize(right, unwrap, false);
  return label(
    mapBack(
      underLabel(() => apply(a, b)),
      unwrap,
    ),
  );
}

function labeledInvoke(
  target: unknown,
  args: readonly unknown[],
  apply: (target: unknown, args: readonly unknown[]) => unknown,
): unknown {
  const targetLabeled = isLabeled(target);
  const callee = unlabel(target);
  if (isSentinelAware(callee)) {
    if (!targetLabeled && !args.some(labeledInArrays))
      return apply(target, args);
    // A labeled target was chosen by a secret: the whole call is a labeled region. A plain target
    // over labeled arguments propagates by data, so only its throws are marked.
    const run = () => apply(callee, args);
    return label(targetLabeled ? underLabel(run) : markingThrows(run));
  }
  const absorber = joinAbsorbers([callee, joinAbsorbers(args.map(unlabel))]);
  if (absorber)
    return targetLabeled || args.some(isLabeled) ? label(absorber) : absorber;
  const unwrap = openUnwrap();
  const plainArgs = args.map((arg) => canonicalize(arg, unwrap, true));
  if (!targetLabeled && !unwrap.found) return apply(target, args);
  // Position cost: a labeled argument the callee ignores still runs the call as a labeled region,
  // so the call's own mints are reported sensitive.
  return label(
    mapBack(
      underLabel(() => apply(callee, plainArgs)),
      unwrap,
    ),
  );
}
