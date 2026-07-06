import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  MESH_PROTO_VERSION,
  type OpPolicy,
  type Relay,
  type SeqEnvelope,
} from '@mmstack/mesh-protocol';
import { vi } from 'vitest';
import { meshSync, type MeshStatus, type SyncHealthStatus } from '../mesh-sync';
import { directTransport, type MeshTransportFactory } from '../transport';
import { chaosLink, type Faults } from './chaos';
import type { SimResult } from './harness';
import {
  applyWrites,
  BASE_TIME,
  installRng,
  simStore,
  type SimDoc,
} from './model';
import { prng } from './prng';

// a distinct salt so network chaos and app writes draw from independent streams
const NETWORK_SALT = 0x9e3779b9;

export type ChaosOptions = {
  readonly seed: number;
  readonly peers: number;
  readonly rounds: number;
  readonly opsPerRound?: number;
  readonly faults?: Faults;
  /** Partition peer `index` from round `atRound`, healing `forRounds` rounds later. */
  readonly partition?: {
    readonly index: number;
    readonly atRound: number;
    readonly forRounds: number;
  };
};

/**
 * Runs the sim over the REAL stack under network faults: every `meshSync` client's transport is
 * wrapped in a {@link chaosLink}, and time is virtual (fake timers own `setTimeout` + `Date.now`,
 * so HLC and reconnect backoff are deterministic). Optionally partitions a peer mid-run; on heal
 * it reconnects and resumes via delta/snapshot. Drains to quiescence, then returns the invariant
 * material. A pure function of `seed` + `faults`.
 */
export function runChaosSimulation(opt: ChaosOptions): SimResult {
  const app = prng(opt.seed);
  const net = prng((opt.seed ^ NETWORK_SALT) >>> 0);
  const opsPerRound = opt.opsPerRound ?? 3;
  const restoreRng = installRng(app);
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  try {
    const journal: SeqEnvelope[] = [];
    let relayRoot: unknown = undefined;
    const relay = createRelay({
      onCommit: (_room, env, state) => {
        journal.push(env);
        relayRoot = state.root;
      },
    });

    const peers = Array.from({ length: opt.peers }, (_, i) => {
      const writer = `p${i}`;
      const link = chaosLink(
        directTransport(relay, { writer }),
        net,
        opt.faults ?? {},
      );
      return TestBed.runInInjectionContext(() => {
        const s = simStore();
        const mesh = meshSync(s, {
          room: 'sim',
          writer,
          transport: link.transport,
        });
        return {
          writer,
          s,
          link,
          status: () => mesh.status(),
          close: () => mesh.close(),
        };
      });
    });

    drain(); // initial joins settle through the faulty links

    for (let round = 0; round < opt.rounds; round++) {
      const p = opt.partition;
      if (p && round === p.atRound) peers[p.index].link.partition();
      if (p && round === p.atRound + p.forRounds) peers[p.index].link.heal();

      for (const peer of peers) applyWrites(peer.s, app, opsPerRound);
      TestBed.tick();

      // a cut peer reconnect-loops forever, so bound the steps while partitioned
      if (peers.some((pe) => pe.link.isCut())) step(200);
      else drain();
    }

    for (const peer of peers) peer.link.heal(); // heal anything still cut, then converge
    drain();

    const result: SimResult = {
      roots: peers.map((pe) => pe.s()),
      relayRoot,
      journal,
      seq: relay.room('sim')?.seq ?? 0,
      statuses: peers.map((pe) => pe.status()),
      seed: opt.seed,
    };
    for (const peer of peers) peer.close();
    return result;
  } finally {
    vi.useRealTimers();
    restoreRng();
  }
}

export type RestartResult = {
  readonly roots: SimDoc[];
  readonly statuses: MeshStatus[];
  readonly checkpointSeq: number;
  readonly checkpointRoot: unknown;
  readonly postSeq: number;
  readonly postRelayRoot: unknown;
  readonly postJournal: SeqEnvelope[];
};

export type RestartOptions = {
  readonly seed: number;
  readonly peers: number;
  readonly rounds: number;
  readonly opsPerRound?: number;
  readonly faults?: Faults;
  readonly restartRound: number;
  /** Restore the room epoch so returning clients keep their watermark (delta resume); else they
   *  meet a fresh epoch and re-snapshot. */
  readonly preserveEpoch?: boolean;
};

/**
 * The relay-restart + hydrate scenario: run a room, checkpoint it (the `onCommit` egress), then
 * stand up a FRESH relay hydrated from that checkpoint and force the live clients onto it (a
 * partition swaps the relay underneath them, so they reconnect and resume via delta or snapshot).
 * Exercises the persistence round-trip under live clients + the seq-space continuity across a
 * restart.
 */
export function runRestartSimulation(opt: RestartOptions): RestartResult {
  const app = prng(opt.seed);
  const net = prng((opt.seed ^ NETWORK_SALT) >>> 0);
  const opsPerRound = opt.opsPerRound ?? 2;
  const restoreRng = installRng(app);
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  try {
    let journal: SeqEnvelope[] = [];
    let relayRoot: unknown = undefined;
    let relayEpoch = '';
    let relaySeq = 0;
    const onCommit = (
      _room: string,
      env: SeqEnvelope,
      state: { seq: number; epoch: string; root: unknown },
    ) => {
      journal.push(env);
      relayRoot = state.root;
      relayEpoch = state.epoch;
      relaySeq = state.seq;
    };
    let currentRelay = createRelay({ onCommit });

    const peers = Array.from({ length: opt.peers }, (_, i) => {
      const writer = `p${i}`;
      // re-reads the (mutable) current relay on every reconnect, so a restart swaps it underneath
      const innerFactory: MeshTransportFactory = () =>
        directTransport(currentRelay, { writer })();
      const link = chaosLink(innerFactory, net, opt.faults ?? {});
      return TestBed.runInInjectionContext(() => {
        const s = simStore();
        const mesh = meshSync(s, {
          room: 'sim',
          writer,
          transport: link.transport,
        });
        return {
          writer,
          s,
          link,
          status: () => mesh.status(),
          close: () => mesh.close(),
        };
      });
    });
    drain();

    let checkpointRoot: unknown = undefined;
    let checkpointSeq = 0;

    for (let round = 0; round < opt.rounds; round++) {
      if (round === opt.restartRound) {
        checkpointRoot = relayRoot;
        checkpointSeq = relaySeq;
        const preJournal = [...journal];
        const restored = createRelay({ onCommit });
        restored.hydrate('sim', {
          seq: checkpointSeq,
          root: checkpointRoot,
          epoch: opt.preserveEpoch ? relayEpoch : undefined,
          journal: preJournal,
        });
        journal = []; // capture post-restart commits only
        for (const p of peers) p.link.partition();
        step(50); // clients notice the drop
        currentRelay = restored;
        for (const p of peers) p.link.heal();
        drain(); // reconnect onto the restored relay + resume
      }
      for (const peer of peers) applyWrites(peer.s, app, opsPerRound);
      TestBed.tick();
      drain();
    }
    drain();

    const result: RestartResult = {
      roots: peers.map((p) => p.s()),
      statuses: peers.map((p) => p.status()),
      checkpointSeq,
      checkpointRoot,
      postSeq: relaySeq,
      postRelayRoot: relayRoot,
      postJournal: journal,
    };
    for (const peer of peers) peer.close();
    return result;
  } finally {
    vi.useRealTimers();
    restoreRng();
  }
}

/** A deploy-job migrator: bumps the room to `schemaVersion` with a root-set. */
function migrateRoom(
  relay: Relay,
  room: string,
  root: unknown,
  schemaVersion: number,
): void {
  const conn = relay.connect(
    { send: () => undefined, close: () => undefined },
    { writer: 'migrator' },
  );
  conn.receive({
    t: 'hello',
    room,
    origin: 'mig',
    proto: MESH_PROTO_VERSION,
    policyVersion: 0,
    schemaVersion,
  });
  conn.receive({
    t: 'env',
    room,
    env: {
      proto: MESH_PROTO_VERSION,
      origin: 'mig',
      writer: 'migrator',
      version: 1,
      hlc: { p: BASE_TIME, l: 0 },
      policyVersion: 0,
      ops: [{ kind: 'set', path: [], next: root }],
      schemaVersion,
    },
  });
  conn.disconnect();
}

export type MigrationResult = {
  /** Health of every v1 client after the migration (all should be 'outdated'). */
  readonly v1Healths: SyncHealthStatus[];
  /** The partitioned client's root — must NOT contain the v2 shape (heals outdated, not corrupt). */
  readonly partitionedRoot: SimDoc;
  readonly v2Roots: SimDoc[];
  readonly v2Statuses: MeshStatus[];
};

export type MigrationOptions = {
  readonly seed: number;
  readonly v1Peers: number;
  readonly v2Peers: number;
  readonly rounds: number;
  readonly opsPerRound?: number;
  readonly faults?: Faults;
  /** The v1 peer partitioned across the migration (so it misses it and heals into a new shape). */
  readonly partitionIndex: number;
  readonly migrateRound: number;
};

/**
 * Migration-during-partition: v1 clients run, one is partitioned, a
 * migrator bumps the room to v2, then the partitioned client heals. Every v1 client must end
 * 'outdated' (the connected ones on the migration envelope, the healed one on a schema reject) and
 * NONE may adopt the v2 shape — outdated, not corrupt. Fresh v2 clients join the migrated room and
 * converge.
 */
export function runMigrationSimulation(opt: MigrationOptions): MigrationResult {
  const app = prng(opt.seed);
  const net = prng((opt.seed ^ NETWORK_SALT) >>> 0);
  const opsPerRound = opt.opsPerRound ?? 1;
  const restoreRng = installRng(app);
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  try {
    const relay = createRelay();
    const mk = (writer: string, schemaVersion: number) =>
      TestBed.runInInjectionContext(() => {
        const s = simStore();
        const link = chaosLink(
          directTransport(relay, { writer }),
          net,
          opt.faults ?? {},
        );
        const mesh = meshSync(s, {
          room: 'sim',
          writer,
          transport: link.transport,
          schemaVersion,
        });
        return { s, link, mesh };
      });

    const v1 = Array.from({ length: opt.v1Peers }, (_, i) => mk(`v1_${i}`, 1));
    drain();

    for (let round = 0; round < opt.rounds; round++) {
      if (round === opt.migrateRound) {
        v1[opt.partitionIndex].link.partition(); // this peer misses the migration
        step(100);
        migrateRoom(
          relay,
          'sim',
          { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'v2', y: '' } },
          2,
        );
        step(100);
        v1[opt.partitionIndex].link.heal(); // heals into the migrated room → schema reject
        drain();
      } else {
        for (const p of v1) applyWrites(p.s, app, opsPerRound);
        TestBed.tick();
        drain();
      }
    }
    drain();

    const v2 = Array.from({ length: opt.v2Peers }, (_, i) => mk(`v2_${i}`, 2));
    drain();
    if (v2[0]) {
      v2[0].s.labels.y.set('v2-write');
      TestBed.tick();
      drain();
    }

    const result: MigrationResult = {
      v1Healths: v1.map((p) => p.mesh.health().status),
      partitionedRoot: structuredClone(v1[opt.partitionIndex].s()),
      v2Roots: v2.map((p) => structuredClone(p.s())),
      v2Statuses: v2.map((p) => p.mesh.status()),
    };
    for (const p of v1) p.mesh.close();
    for (const p of v2) p.mesh.close();
    return result;
  } finally {
    vi.useRealTimers();
    restoreRng();
  }
}

export type ZombieResult = {
  readonly roots: SimDoc[];
  readonly statuses: MeshStatus[];
  /** Envelopes the zombie's writer committed to the room WHILE silenced (must be 0 — dropped). */
  readonly zombieCommitsWhileSilent: number;
  /** The zombie's committed count grew after recovery (its piled-up writes flushed, no loss). */
  readonly zombieRecovered: boolean;
};

export type ZombieOptions = {
  readonly seed: number;
  readonly peers: number;
  readonly rounds: number;
  readonly opsPerRound?: number;
  readonly faults?: Faults;
  readonly zombieIndex: number;
  readonly silenceAtRound: number;
  readonly silenceForRounds: number;
};

/**
 * Zombie-writer (evolution.md §8 hazard): one peer goes SILENT — its packets are dropped both ways
 * but the socket stays open, so meshSync still thinks it is live, keeps writing (unacked piles up),
 * and misses inbound. A silenced writer must NOT reach the room (no corruption), and its writes must
 * survive to merge once a real reconnect (close→heal) forces a resync (no loss). Honest peers keep
 * converging throughout.
 */
export function runZombieSimulation(opt: ZombieOptions): ZombieResult {
  const app = prng(opt.seed);
  const net = prng((opt.seed ^ NETWORK_SALT) >>> 0);
  const opsPerRound = opt.opsPerRound ?? 1;
  const restoreRng = installRng(app);
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  try {
    const journal: SeqEnvelope[] = [];
    const relay = createRelay({ onCommit: (_room, env) => journal.push(env) });
    const zombieWriter = `p${opt.zombieIndex}`;
    const zombieCommits = () => journal.filter((e) => e.writer === zombieWriter).length;

    const peers = Array.from({ length: opt.peers }, (_, i) => {
      const writer = `p${i}`;
      const link = chaosLink(directTransport(relay, { writer }), net, opt.faults ?? {});
      return TestBed.runInInjectionContext(() => {
        const s = simStore();
        const mesh = meshSync(s, { room: 'sim', writer, transport: link.transport });
        return { writer, s, link, status: () => mesh.status(), close: () => mesh.close() };
      });
    });
    drain();

    let commitsAtSilenceStart = 0;
    let zombieCommitsWhileSilent = 0;
    for (let round = 0; round < opt.rounds; round++) {
      if (round === opt.silenceAtRound) {
        commitsAtSilenceStart = zombieCommits();
        peers[opt.zombieIndex].link.silence(); // go zombie: drop both ways, socket stays open
      }
      if (round === opt.silenceAtRound + opt.silenceForRounds) {
        zombieCommitsWhileSilent = zombieCommits() - commitsAtSilenceStart; // must be 0
        peers[opt.zombieIndex].link.unsilence();
        peers[opt.zombieIndex].link.partition(); // a real close forces the reconnect + resync
        step(100);
        peers[opt.zombieIndex].link.heal();
        drain();
      }

      for (const peer of peers) applyWrites(peer.s, app, opsPerRound);
      TestBed.tick();
      if (peers.some((pe) => pe.link.isCut())) step(200);
      else drain();
    }

    peers[opt.zombieIndex].link.unsilence();
    peers[opt.zombieIndex].link.heal();
    for (let i = 0; i < 4; i++) {
      TestBed.tick(); // settle any in-flight flush of the zombie's piled-up writes
      drain();
    }

    const result: ZombieResult = {
      roots: peers.map((pe) => pe.s()),
      statuses: peers.map((pe) => pe.status()),
      zombieCommitsWhileSilent,
      zombieRecovered: zombieCommits() > commitsAtSilenceStart,
    };
    for (const peer of peers) peer.close();
    return result;
  } finally {
    vi.useRealTimers();
    restoreRng();
  }
}

/** The room rejects negative numbers. Honest peers never write them; the rogue does. */
const noNegatives: OpPolicy = {
  validate: (op) =>
    !(op.kind === 'set' && typeof op.next === 'number' && op.next < 0),
};

export type EjectionResult = {
  readonly honestRoots: SimDoc[];
  readonly honestStatuses: MeshStatus[];
  readonly rogueStatus: MeshStatus;
  readonly journal: SeqEnvelope[];
  readonly relayRoot: unknown;
};

export type EjectionOptions = {
  readonly seed: number;
  readonly honestPeers: number;
  readonly rounds: number;
  readonly opsPerRound?: number;
  readonly faults?: Faults;
  readonly violateAtRound: number;
};

/**
 * The tripwire scenario: honest peers carry the room's emit-side policy (they self-censor); a
 * rogue peer carries none and writes a policy-violating value, so the relay ejects it. Asserts
 * invariant 3 with teeth — the rogue IS ejected, honest peers stay live and converge among
 * themselves, and the poison value never enters the journal or an honest root.
 */
export function runEjectionSimulation(opt: EjectionOptions): EjectionResult {
  const app = prng(opt.seed);
  const net = prng((opt.seed ^ NETWORK_SALT) >>> 0);
  const opsPerRound = opt.opsPerRound ?? 2;
  const restoreRng = installRng(app);
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  try {
    const journal: SeqEnvelope[] = [];
    let relayRoot: unknown = undefined;
    const relay = createRelay({
      policy: noNegatives,
      onCommit: (_room, env, state) => {
        journal.push(env);
        relayRoot = state.root;
      },
    });

    const mkPeer = (writer: string, withPolicy: boolean) =>
      TestBed.runInInjectionContext(() => {
        const s = simStore();
        const link = chaosLink(
          directTransport(relay, { writer }),
          net,
          opt.faults ?? {},
        );
        const mesh = meshSync(s, {
          room: 'sim',
          writer,
          transport: link.transport,
          policy: withPolicy ? noNegatives : undefined,
        });
        return {
          writer,
          s,
          status: () => mesh.status(),
          close: () => mesh.close(),
        };
      });

    const honest = Array.from({ length: opt.honestPeers }, (_, i) =>
      mkPeer(`h${i}`, true),
    );
    const rogue = mkPeer('rogue', false);
    drain();

    for (let round = 0; round < opt.rounds; round++) {
      for (const p of honest) applyWrites(p.s, app, opsPerRound);
      applyWrites(rogue.s, app, opsPerRound);
      if (round === opt.violateAtRound) rogue.s.counters.a.set(-1); // trips the relay policy
      TestBed.tick();
      drain();
    }
    drain();

    const result: EjectionResult = {
      honestRoots: honest.map((p) => p.s()),
      honestStatuses: honest.map((p) => p.status()),
      rogueStatus: rogue.status(),
      journal,
      relayRoot,
    };
    for (const p of honest) p.close();
    rogue.close();
    return result;
  } finally {
    vi.useRealTimers();
    restoreRng();
  }
}

/**
 * Drain to quiescence, firing ONE timer per tick. One-at-a-time (not `advanceTimersByTime`)
 * keeps each delivery in its own change-detection cycle — a burst of deliveries in a single tick
 * (e.g. a reconnecting peer's delta + the re-entrant flush cascade) trips Angular's NG0103
 * stabilization guard. Bounded for safety.
 */
function drain(maxSteps = 20_000): void {
  TestBed.tick();
  let steps = 0;
  while (vi.getTimerCount() > 0 && steps < maxSteps) {
    vi.advanceTimersToNextTimer();
    TestBed.tick();
    steps++;
  }
  TestBed.tick();
}

/** Fire up to `n` timers one at a time (used while a peer is partitioned and would loop forever). */
function step(n: number): void {
  for (let i = 0; i < n && vi.getTimerCount() > 0; i++) {
    vi.advanceTimersToNextTimer();
    TestBed.tick();
  }
}
