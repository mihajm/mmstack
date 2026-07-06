import { runMigrationSimulation } from './chaos-harness';
import { converged } from './invariants';

describe('scenario: migration during partition', () => {
  it('every v1 client ends "outdated" — the healed one too — and none adopt the v2 shape', () => {
    const res = runMigrationSimulation({
      seed: 1,
      v1Peers: 3,
      v2Peers: 2,
      rounds: 10,
      faults: { minLatencyMs: 1, maxLatencyMs: 15 },
      partitionIndex: 0,
      migrateRound: 5,
    });

    // all v1 clients (connected + the partitioned/healed one) surface 'outdated'
    expect(
      res.v1Healths.every((h) => h === 'outdated'),
      `v1 healths: ${res.v1Healths}`,
    ).toBe(true);
    // the partitioned client healed into a migrated room without corrupting to the v2 shape
    expect(res.partitionedRoot.labels.x).not.toBe('v2');

    // fresh v2 clients get the migrated state and converge
    expect(res.v2Statuses.every((s) => s === 'live')).toBe(true);
    expect(res.v2Roots.every((r) => r.labels.x === 'v2')).toBe(true);
    expect(converged(res.v2Roots).ok, converged(res.v2Roots).message).toBe(
      true,
    );
    expect(res.v2Roots[0].labels.y).toBe('v2-write');
  });

  it('holds across several seeds', () => {
    for (let seed = 0; seed < 10; seed++) {
      const res = runMigrationSimulation({
        seed,
        v1Peers: 3,
        v2Peers: 2,
        rounds: 8,
        faults: { minLatencyMs: 1, maxLatencyMs: 12 },
        partitionIndex: seed % 3,
        migrateRound: 4,
      });
      expect(
        res.v1Healths.every((h) => h === 'outdated'),
        `seed ${seed}: ${res.v1Healths}`,
      ).toBe(true);
      expect(res.partitionedRoot.labels.x, `seed ${seed}: corrupted`).not.toBe(
        'v2',
      );
      expect(
        converged(res.v2Roots).ok,
        `seed ${seed}: ${converged(res.v2Roots).message}`,
      ).toBe(true);
    }
  });
});
