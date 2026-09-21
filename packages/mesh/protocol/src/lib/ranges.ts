import type { Hlc, VersionRange } from './wire';

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
  /**
   * The end of the first range — the origin's first contiguous run of admitted versions — or 0.
   * The run starts wherever the origin entered the generation: at 1 for a fresh origin, higher
   * for one that lived through a cut or whose first envelope was the cut. Reading a settled
   * stamp off it is sound only while a version below an admitted one is never admitted later
   * (the relay refuses it as out of order); an admission rule that fills holes must anchor this
   * at the version the origin could first have written, not at the first one that arrived.
   */
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
    prefix: () => (ranges.length ? ranges[0][1] : 0),
    toJSON: () => ranges.map(([a, b]) => [a, b] as const),
  };
}

/** A room's admission evidence as it is held while the room runs. */
export type AdmissionEvidence = {
  readonly ranges: Map<string, Ranges>;
  readonly settled: Map<string, Hlc>;
};

/**
 * Records one admitted envelope in a room's evidence: its version joins the origin's ranges, and
 * the origin's settled stamp becomes this envelope's when its first contiguous run grew. The
 * relay runs this on every envelope it sequences; anything that rebuilds a room from a checkpoint
 * and the envelopes admitted since (recovery) runs the same step over them, in sequence order,
 * so the two cannot drift apart. The envelope that cuts a generation is not recorded: it belongs
 * to the generation it closed.
 */
export function recordAdmission(
  evidence: AdmissionEvidence,
  env: { readonly origin: string; readonly version: number; readonly hlc: Hlc },
): void {
  let held = evidence.ranges.get(env.origin);
  if (!held) evidence.ranges.set(env.origin, (held = createRanges()));
  const before = held.prefix();
  held.add(env.version);
  // the run grows only by the version just admitted: one below the maximum is refused as out of
  // order before it gets here, so a hole never fills and no later stamp is owed
  if (held.prefix() > before) evidence.settled.set(env.origin, env.hlc);
}
