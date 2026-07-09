import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  type RegisterCheckpoint,
  type SeqEnvelope,
} from '@mmstack/mesh-protocol';
import { meshSync, type MeshStatus } from '../mesh-sync';
import { directTransport } from '../transport';
import { prng, type Prng } from './prng';
import { applyWrites, BASE_TIME, installRng, simStore, type SimDoc, type SimStore } from './model';

export type { SimDoc } from './model';

const ROUND_MS = 1000;

/**
 * The baseline runner also stubs `Date.now` to a fixed-per-round clock (the chaos runner lets
 * fake timers own it instead), on top of {@link installRng}.
 */
function installDeterminism(r: Prng, clock: { now: number }): () => void {
  const restoreRng = installRng(r);
  const origNow = Date.now;
  Date.now = () => clock.now;
  return () => {
    Date.now = origNow;
    restoreRng();
  };
}

type Peer = {
  readonly writer: string;
  readonly s: SimStore;
  readonly status: () => MeshStatus;
  close(): void;
};

export type SimResult = {
  /** Each peer's final root. */
  readonly roots: SimDoc[];
  /** The relay's retained register state at the last commit (the relay holds no root). */
  readonly relayRegisters: readonly RegisterCheckpoint[];
  /** The room journal in commit order. */
  readonly journal: SeqEnvelope[];
  /** The room's final seq. */
  readonly seq: number;
  /** Each peer's terminal mesh status (to detect ejects/disconnects among honest peers). */
  readonly statuses: MeshStatus[];
  readonly seed: number;
};

export type SimOptions = {
  readonly seed: number;
  readonly peers: number;
  readonly rounds: number;
  /** Writes each peer makes per round before the round propagates. @default 3 */
  readonly opsPerRound?: number;
};

/**
 * Runs a deterministic multi-peer simulation over the REAL stack: N `meshSync` clients on a
 * shared `store`, one in-process `createRelay`, wired with the reliable `directTransport`.
 * Each round every peer makes seeded random writes (concurrent — they propagate together),
 * then the round settles. Returns the material the invariants assert on.
 *
 * This is the baseline (no faults) run; the chaos transport + scenario deck layer on top.
 */
export function runSimulation(opt: SimOptions): SimResult {
  const r = prng(opt.seed);
  const opsPerRound = opt.opsPerRound ?? 3;
  const clock = { now: BASE_TIME };
  const restore = installDeterminism(r, clock);
  try {
    const journal: SeqEnvelope[] = [];
    let relayRegisters: readonly RegisterCheckpoint[] = [];
    const relay = createRelay({
      onCommit: (_room, env, state) => {
        journal.push(env);
        relayRegisters = state.registers;
      },
    });

    const peers: Peer[] = Array.from({ length: opt.peers }, (_, i) => {
      const writer = `p${i}`;
      return TestBed.runInInjectionContext(() => {
        const s = simStore();
        const mesh = meshSync(s, {
          room: 'sim',
          writer,
          transport: directTransport(relay, { writer }),
        });
        return { writer, s, status: () => mesh.status(), close: () => mesh.close() };
      });
    });
    TestBed.tick(); // flush the seed envelope + welcomes

    for (let round = 0; round < opt.rounds; round++) {
      clock.now += ROUND_MS; // each round advances physical time (concurrent within a round)
      for (const peer of peers) applyWrites(peer.s, r, opsPerRound);
      TestBed.tick(); // this round's writes emit + propagate together (concurrent)
    }
    TestBed.tick(); // final settle

    const result: SimResult = {
      roots: peers.map((p) => p.s()),
      relayRegisters,
      journal,
      seq: relay.room('sim')?.seq ?? 0,
      statuses: peers.map((p) => p.status()),
      seed: opt.seed,
    };
    for (const peer of peers) peer.close();
    return result;
  } finally {
    restore();
  }
}
