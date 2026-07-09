import { converged, journalFoldMatchesClients, relayRetainsJournal, seqDense, versionsMonotone } from './invariants';
import { runChaosSimulation } from './chaos-harness';

describe('chaos scenarios — the real stack under network faults', () => {
  it('(a) reorder: latency variance, all delivered → still converges', () => {
    const res = runChaosSimulation({
      seed: 1,
      peers: 3,
      rounds: 15,
      opsPerRound: 2,
      faults: { minLatencyMs: 1, maxLatencyMs: 50 },
    });
    expect(res.statuses.every((s) => s === 'live')).toBe(true);
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    const j = journalFoldMatchesClients(undefined, res.journal, res.roots);
    expect(j.ok, j.message).toBe(true);
    const r = relayRetainsJournal(undefined, res.journal, res.relayRegisters);
    expect(r.ok, r.message).toBe(true);
    expect(seqDense(res.journal, res.seq).ok, seqDense(res.journal, res.seq).message).toBe(true);
    expect(versionsMonotone(res.journal).ok, versionsMonotone(res.journal).message).toBe(true); // inv 4
  });

  it('(a) reorder is reproducible per seed', () => {
    const cfg = { seed: 4, peers: 3, rounds: 10, opsPerRound: 2, faults: { minLatencyMs: 1, maxLatencyMs: 40 } } as const;
    const a = runChaosSimulation(cfg);
    const b = runChaosSimulation(cfg);
    expect(a.roots).toEqual(b.roots);
    expect(a.journal).toEqual(b.journal);
  });

  it('(a) reorder converges across many seeds', () => {
    for (let seed = 0; seed < 30; seed++) {
      const res = runChaosSimulation({ seed, peers: 3, rounds: 8, opsPerRound: 2, faults: { minLatencyMs: 1, maxLatencyMs: 60 } });
      const c = converged(res.roots);
      expect(c.ok, `seed ${seed}: ${c.message}`).toBe(true);
      expect(res.statuses.every((s) => s === 'live'), `seed ${seed}: not all live`).toBe(true);
    }
  });

  it('(b) partition-heal: a cut peer edits offline, reconnects, resumes, and converges (inv 5)', () => {
    const res = runChaosSimulation({
      seed: 2,
      peers: 3,
      rounds: 12,
      opsPerRound: 2,
      faults: { minLatencyMs: 1, maxLatencyMs: 20 },
      partition: { index: 0, atRound: 4, forRounds: 4 },
    });
    expect(res.statuses.every((s) => s === 'live'), 'a peer failed to rejoin after heal').toBe(true);
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    const j = journalFoldMatchesClients(undefined, res.journal, res.roots);
    expect(j.ok, j.message).toBe(true);
  });

  it('(b) partition-heal converges across several seeds', () => {
    for (let seed = 0; seed < 15; seed++) {
      const res = runChaosSimulation({
        seed,
        peers: 3,
        rounds: 10,
        opsPerRound: 2,
        faults: { minLatencyMs: 1, maxLatencyMs: 20 },
        partition: { index: seed % 3, atRound: 3, forRounds: 3 },
      });
      const c = converged(res.roots);
      expect(c.ok, `seed ${seed}: ${c.message}`).toBe(true);
      expect(res.statuses.every((s) => s === 'live'), `seed ${seed}: not all live`).toBe(true);
    }
  });
});
