/**
 * A change of relative order among the entries present in both of two consecutive states, named
 * by their handles: `before` in the previous order, `after` the SAME handles in the current order.
 */
export type Permutation<H> = {
  readonly before: readonly H[];
  readonly after: readonly H[];
};

/** Which check decided the last call (for specs). @internal */
export type PermutationPath = 'same' | 'equal' | 'append' | 'prepend' | 'walk';

/** The equality `Map` and `Set` use, so `NaN` compares equal to itself. */
const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (a !== a && b !== b);

/**
 * A reusable survivor-permutation function: owns its two membership sets, so it allocates only
 * when it returns a permutation (the two arrays it hands out are new and safe to keep).
 *
 * Checks, cheapest first, all allocation-free: the same array; equal arrays; the previous state a
 * prefix of the next (an append); a suffix (a prepend); otherwise one walk over the survivors of
 * both sides that stops at the first rank change. @internal
 */
export function createSurvivorPermutation<H>(): {
  (prev: readonly H[], next: readonly H[]): Permutation<H> | null;
  lastPath: PermutationPath;
} {
  const inPrev = new Set<H>();
  const inNext = new Set<H>();

  const fn = (
    prev: readonly H[],
    next: readonly H[],
  ): Permutation<H> | null => {
    if (prev === next) {
      fn.lastPath = 'same';
      return null;
    }
    const pl = prev.length;
    const nl = next.length;
    if (pl === nl && matches(prev, next, 0)) {
      fn.lastPath = 'equal';
      return null;
    }
    if (pl <= nl && matches(prev, next, 0)) {
      fn.lastPath = 'append';
      return null;
    }
    if (pl <= nl && matches(prev, next, nl - pl)) {
      fn.lastPath = 'prepend';
      return null;
    }

    fn.lastPath = 'walk';
    for (let i = 0; i < pl; i++) inPrev.add(prev[i]);
    for (let j = 0; j < nl; j++) inNext.add(next[j]);
    let changed = false;
    for (let i = 0, j = 0; ; i++, j++) {
      while (i < pl && !inNext.has(prev[i])) i++;
      while (j < nl && !inPrev.has(next[j])) j++;
      if (i >= pl || j >= nl) break;
      if (!sameValueZero(prev[i], next[j])) {
        changed = true;
        break;
      }
    }
    const out = changed
      ? {
          before: prev.filter((h) => inNext.has(h)),
          after: next.filter((h) => inPrev.has(h)),
        }
      : null;
    inPrev.clear();
    inNext.clear();
    return out;
  };
  fn.lastPath = 'same' as PermutationPath;
  return fn;
}

/** `prev` equals `next` from `offset` on, element by element (SameValueZero). */
function matches<H>(
  prev: readonly H[],
  next: readonly H[],
  offset: number,
): boolean {
  for (let i = 0; i < prev.length; i++)
    if (!sameValueZero(prev[i], next[offset + i])) return false;
  return true;
}
