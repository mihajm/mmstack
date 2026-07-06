import { store } from '@mmstack/primitives';
import { v4 as uuidv4 } from 'uuid';
import { bytes16, type Prng } from './prng';

export const BASE_TIME = 1_700_000_000_000;

/** The document every simulated peer replicates — a spread of scalar leaves at two depths. */
export type SimDoc = {
  counters: { a: number; b: number; c: number };
  labels: { x: string; y: string };
};

export const initialDoc = (): SimDoc => ({
  counters: { a: 0, b: 0, c: 0 },
  labels: { x: '', y: '' },
});

export const simStore = () => store<SimDoc>(initialDoc());
export type SimStore = ReturnType<typeof simStore>;

/** One random write a peer can make. Kept small and shared-path so peers actually collide. */
const mutations: ReadonlyArray<(s: SimStore, r: Prng) => void> = [
  (s, r) => s.counters.a.set(r.int(1000)),
  (s, r) => s.counters.b.set(r.int(1000)),
  (s, r) => s.counters.c.set(r.int(1000)),
  (s, r) => s.labels.x.set(`x${r.int(1000)}`),
  (s, r) => s.labels.y.set(`y${r.int(1000)}`),
];

/** Apply `n` seeded random writes to a peer's store. */
export function applyWrites(s: SimStore, r: Prng, n: number): void {
  for (let k = 0; k < n; k++) r.pick(mutations)(s, r);
}

/**
 * Route `Math.random` (reconnect jitter) and `crypto.randomUUID` (opSync origin) through the
 * seeded stream so a run reproduces exactly. `Date.now` (HLC) is left alone — the baseline runner
 * stubs it to a fixed clock, the chaos runner lets fake timers own it. Returns a restore fn.
 */
export function installRng(r: Prng): () => void {
  const origRandom = Math.random;
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const origUuid = cryptoObj?.randomUUID;

  Math.random = () => r.float();
  if (cryptoObj) {
    try {
      cryptoObj.randomUUID = () =>
        uuidv4({ rng: () => bytes16(r) }) as `${string}-${string}-${string}-${string}-${string}`;
    } catch {
      // non-writable: opSync falls back to the (stubbed) Math.random
    }
  }

  return () => {
    Math.random = origRandom;
    if (cryptoObj && origUuid) {
      try {
        cryptoObj.randomUUID = origUuid;
      } catch {
        // ignore
      }
    }
  };
}
