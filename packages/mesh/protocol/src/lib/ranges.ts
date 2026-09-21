import type { VersionRange } from './wire';

/**
 * The admitted versions of one origin, as disjoint inclusive ranges in ascending order: the
 * relay's admission evidence. A version inside a range was admitted and its resend is an
 * acknowledgement; a version above the maximum is new; a version below the maximum that no
 * range holds was never admitted. In practice one range grows from 1 — a hole appears only
 * where a version was refused — so this stays a few numbers per origin.
 */
export type Ranges = {
  has(version: number): boolean;
  /** Record an admitted version; false when it was already there. */
  add(version: number): boolean;
  /** The highest admitted version, 0 when none. */
  max(): number;
  /** The end of the range that starts at 1 — the contiguously admitted prefix — or 0. */
  prefix(): number;
  toJSON(): readonly VersionRange[];
};

export function createRanges(initial: readonly VersionRange[] = []): Ranges {
  let ranges: [number, number][] = initial
    .map(([a, b]) => [a, b] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const indexOf = (v: number): number => {
    for (let i = 0; i < ranges.length; i++) {
      if (v < ranges[i][0]) return -1;
      if (v <= ranges[i][1]) return i;
    }
    return -1;
  };
  return {
    has: (v) => indexOf(v) >= 0,
    add: (v) => {
      if (indexOf(v) >= 0) return false;
      ranges.push([v, v]);
      ranges.sort((x, y) => x[0] - y[0]);
      const merged: [number, number][] = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push(r);
      }
      ranges = merged;
      return true;
    },
    max: () => (ranges.length ? ranges[ranges.length - 1][1] : 0),
    prefix: () => (ranges.length && ranges[0][0] === 1 ? ranges[0][1] : 0),
    toJSON: () => ranges.map(([a, b]) => [a, b] as const),
  };
}
