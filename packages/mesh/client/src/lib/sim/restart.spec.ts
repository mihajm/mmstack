import { converged, journalFoldsFrom, seqDense } from './invariants';
import { runRestartSimulation } from './chaos-harness';

describe('scenario: relay restart + hydrate', () => {
  it('delta resume (epoch preserved): clients reconnect onto the restored relay and converge', () => {
    const res = runRestartSimulation({
      seed: 1,
      peers: 3,
      rounds: 12,
      opsPerRound: 2,
      faults: { minLatencyMs: 1, maxLatencyMs: 15 },
      restartRound: 6,
      preserveEpoch: true,
    });
    expect(res.statuses.every((s) => s === 'live'), 'a client failed to rejoin the restored relay').toBe(true);
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    // seq space CONTINUED across the restart (hydrate restored the watermark, no reset)
    expect(res.postSeq).toBeGreaterThan(res.checkpointSeq);
    // the restored relay's post-restart journal folds from the hydrated checkpoint root to its root
    const audit = journalFoldsFrom(res.checkpointRoot, res.postJournal, res.postRelayRoot);
    expect(audit.ok, audit.message).toBe(true);
  });

  it('snapshot resume (fresh epoch): clients re-snapshot and still converge', () => {
    const res = runRestartSimulation({
      seed: 2,
      peers: 3,
      rounds: 12,
      opsPerRound: 2,
      faults: { minLatencyMs: 1, maxLatencyMs: 15 },
      restartRound: 6,
      preserveEpoch: false,
    });
    expect(res.statuses.every((s) => s === 'live')).toBe(true);
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    const audit = journalFoldsFrom(res.checkpointRoot, res.postJournal, res.postRelayRoot);
    expect(audit.ok, audit.message).toBe(true);
  });

  it('converges across several seeds (both resume modes)', () => {
    for (let seed = 0; seed < 12; seed++) {
      const res = runRestartSimulation({
        seed,
        peers: 3,
        rounds: 10,
        opsPerRound: 2,
        faults: { minLatencyMs: 1, maxLatencyMs: 15 },
        restartRound: 5,
        preserveEpoch: seed % 2 === 0,
      });
      const c = converged(res.roots);
      expect(c.ok, `seed ${seed} (preserveEpoch=${seed % 2 === 0}): ${c.message}`).toBe(true);
      expect(res.statuses.every((s) => s === 'live'), `seed ${seed}: not all live`).toBe(true);
    }
  });
});
