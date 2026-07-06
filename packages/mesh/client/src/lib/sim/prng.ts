/**
 * A tiny seeded PRNG (mulberry32). Deterministic given a seed, so a failing simulation
 * reproduces exactly by re-running with the printed seed.
 */
export type Prng = {
  /** Float in [0, 1). */
  float(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** `true` with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** A uniformly random element of `arr` (throws on empty). */
  pick<T>(arr: readonly T[]): T;
};

/** 16 bytes drawn from the stream — feed to `uuid`'s v4 `rng` for deterministic UUIDs. */
export function bytes16(r: Prng): Uint8Array {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = r.int(256);
  return b;
}

export function prng(seed: number): Prng {
  let a = seed >>> 0;
  const float = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float,
    int: (maxExclusive) => Math.floor(float() * maxExclusive),
    bool: (p = 0.5) => float() < p,
    pick: (arr) => {
      if (arr.length === 0) throw new Error('prng.pick: empty array');
      return arr[Math.floor(float() * arr.length)];
    },
  };
}
