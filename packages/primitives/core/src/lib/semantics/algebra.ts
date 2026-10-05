import { type Absorbing, isAbsorbing } from './sentinel';

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
