/** The survivor permutation's fast paths: each one pinned by the path it takes. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSurvivorPermutation } from './survivor-permutation';

describe('createSurvivorPermutation', () => {
  it('[PIN M3 path same] the same array ⇒ null without a scan', () => {
    const perm = createSurvivorPermutation<string>();
    const a = ['a', 'b'];
    expect(perm(a, a)).toBeNull();
    expect(perm.lastPath).toBe('same');
  });

  it('[PIN M3 path equal] pairwise equal (SameValueZero, NaN included) ⇒ null', () => {
    const perm = createSurvivorPermutation<unknown>();
    expect(perm(['a', NaN], ['a', NaN])).toBeNull();
    expect(perm.lastPath).toBe('equal');
  });

  it('[PIN M3 path append] the previous state a prefix of the next ⇒ null', () => {
    const perm = createSurvivorPermutation<string>();
    expect(perm(['a', 'b'], ['a', 'b', 'c'])).toBeNull();
    expect(perm.lastPath).toBe('append');
  });

  it('[PIN M3 path prepend] the previous state a suffix of the next (the prepend example) ⇒ null', () => {
    const perm = createSurvivorPermutation<string>();
    expect(perm(['t1', 't2'], ['t0', 't1', 't2'])).toBeNull();
    expect(perm.lastPath).toBe('prepend');
  });

  it('[PIN M3 path walk] anything else walks the survivors', () => {
    const perm = createSurvivorPermutation<string>();
    expect(perm(['a', 'b', 'c'], ['c', 'd', 'a'])).toEqual({
      before: ['a', 'c'],
      after: ['c', 'a'],
    });
    expect(perm.lastPath).toBe('walk');
    expect(perm(['a', 'b', 'c'], ['a', 'x', 'c'])).toBeNull();
    expect(perm.lastPath).toBe('walk');
  });

  it('[PIN M3 paths agree] every path agrees with the plain filter-and-compare definition', () => {
    const perm = createSurvivorPermutation<number>();
    const list = fc.uniqueArray(fc.integer({ min: 0, max: 8 }), {
      maxLength: 8,
    });
    fc.assert(
      fc.property(list, list, (prev, next) => {
        const inPrev = new Set(prev);
        const inNext = new Set(next);
        const before = prev.filter((h) => inNext.has(h));
        const after = next.filter((h) => inPrev.has(h));
        const moved = before.some((h, i) => h !== after[i]);
        expect(perm(prev, next)).toEqual(moved ? { before, after } : null);
      }),
      { numRuns: 500 },
    );
  });
});
