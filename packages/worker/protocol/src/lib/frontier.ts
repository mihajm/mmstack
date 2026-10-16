import { frontierEquals, type AppliedFrontier } from '@mmstack/primitives/core';

/**
 * What a store replica (or its owner) has applied, scoped to ONE owner generation. `instance` is the
 * owner host's id (the `instance` its envelopes carry): frontiers from different owner generations
 * never compare equal, because a fresh owner restarts the per-origin history. `''` means no
 * generation is known yet (before the first checkpoint, or after a disconnect).
 */
export type StoreFrontier = {
  readonly instance: string;
  readonly applied: AppliedFrontier;
};

/** The frontier of a replica that holds no owner generation yet. */
export const UNKNOWN_FRONTIER: StoreFrontier = Object.freeze({
  instance: '',
  applied: Object.freeze({}),
});

/**
 * Whether two {@link StoreFrontier}s describe the same applied op set: same known owner generation,
 * then the same stamp per origin. Compare the frontier a published derivation carries with a
 * replica's `applied` to tell whether the result describes the document the replica shows.
 */
export function storeFrontierEquals(
  a: StoreFrontier,
  b: StoreFrontier,
): boolean {
  return (
    a.instance !== '' &&
    a.instance === b.instance &&
    frontierEquals(a.applied, b.applied)
  );
}
