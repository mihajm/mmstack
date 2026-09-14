import { isDevMode } from '@angular/core';

/** Hybrid logical clock stamp: physical epoch ms + logical counter for same-ms ordering. */
export type Hlc = { readonly p: number; readonly l: number };

/** Total order over stamps alone; ties break on `writer` via {@link compareTotal}. */
export function compareHlc(a: Hlc, b: Hlc): number {
  return a.p !== b.p ? a.p - b.p : a.l - b.l;
}

/** The protocol's total order: (hlc.p, hlc.l, writer). Never returns 0 for distinct writers. */
export function compareTotal(a: Hlc, writerA: string, b: Hlc, writerB: string): number {
  const byClock = compareHlc(a, b);
  if (byClock !== 0) return byClock;
  return writerA < writerB ? -1 : writerA > writerB ? 1 : 0;
}

const SKEW_WARN_MS = 5 * 60_000;

export type HlcClock = {
  /** Stamp for a locally-emitted envelope: monotonic even when wall time stalls or rewinds. */
  next(): Hlc;
  /** Fold an observed remote stamp in, so subsequent local stamps sort after it. */
  observe(remote: Hlc): void;
};

/**
 * HLC per Kulkarni et al.: convergence never depends on wall clocks, but LWW fairness
 * degrades under large skew, so observing a remote clock far ahead warns in dev mode.
 */
export function createHlcClock(now: () => number = Date.now): HlcClock {
  let p = 0;
  let l = 0;

  const advance = (wall: number, observed?: Hlc): void => {
    const nextP = Math.max(p, wall, observed?.p ?? 0);
    if (nextP === p) {
      l = Math.max(l, observed && observed.p === nextP ? observed.l : 0) + 1;
    } else {
      p = nextP;
      l = observed && observed.p === nextP ? observed.l + 1 : 0;
    }
  };

  return {
    next: () => {
      advance(now());
      return { p, l };
    },
    observe: (remote) => {
      const wall = now();
      if (isDevMode() && remote.p - wall > SKEW_WARN_MS) {
        console.warn(
          `[@mmstack/primitives] observed remote clock ${Math.round((remote.p - wall) / 1000)}s ahead — convergence holds, but last-writer-wins fairness degrades under clock skew`,
        );
      }
      advance(wall, remote);
    },
  };
}
