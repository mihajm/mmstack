import { commitOrdered, converged, journalFoldMatchesClients, relayRetainsJournal, seqDense, versionsMonotone } from './invariants';
import { runSimulation } from './harness';

describe('mesh simulation harness — baseline convergence (no faults)', () => {
  it('3 peers, concurrent writes over many rounds: all converge; journal audits', () => {
    const res = runSimulation({ seed: 1, peers: 3, rounds: 20, opsPerRound: 3 });

    expect(res.statuses.every((s) => s === 'live')).toBe(true); // no faults → all connected, none ejected
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    // audit 2a: the journal, folded through a client-side register+fold, IS every peer's root
    const j = journalFoldMatchesClients(undefined, res.journal, res.roots);
    expect(j.ok, j.message).toBe(true);
    // audit 2b: the relay retained exactly what re-ingesting the journal through the twin yields
    const r = relayRetainsJournal(undefined, res.journal, res.relayRegisters);
    expect(r.ok, r.message).toBe(true);
    expect(seqDense(res.journal, res.seq).ok, seqDense(res.journal, res.seq).message).toBe(true);
    expect(versionsMonotone(res.journal).ok, versionsMonotone(res.journal).message).toBe(true);
    // post local-pending-as-branch: no re-entrant flush, so onCommit fires in seq order
    expect(commitOrdered(res.journal).ok, commitOrdered(res.journal).message).toBe(true);
  });

  it('property mode: convergence + audit + watermark monotonicity across 100 seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const res = runSimulation({ seed, peers: 3, rounds: 8, opsPerRound: 2 });
      const c = converged(res.roots);
      const j = journalFoldMatchesClients(undefined, res.journal, res.roots);
      const r = relayRetainsJournal(undefined, res.journal, res.relayRegisters);
      const d = seqDense(res.journal, res.seq);
      const m = versionsMonotone(res.journal); // invariant 4
      const o = commitOrdered(res.journal); // onCommit seq-ordered (no re-entrant flush)
      // seed printed in the message for exact repro
      expect(c.ok, `seed ${seed}: ${c.message}`).toBe(true);
      expect(j.ok, `seed ${seed}: ${j.message}`).toBe(true);
      expect(r.ok, `seed ${seed}: ${r.message}`).toBe(true);
      expect(d.ok, `seed ${seed}: ${d.message}`).toBe(true);
      expect(m.ok, `seed ${seed}: ${m.message}`).toBe(true);
      expect(o.ok, `seed ${seed}: ${o.message}`).toBe(true);
    }
  });

  it('scales to more peers', () => {
    const res = runSimulation({ seed: 42, peers: 6, rounds: 10, opsPerRound: 2 });
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
    const j = journalFoldMatchesClients(undefined, res.journal, res.roots);
    expect(j.ok, j.message).toBe(true);
  });

  it('is reproducible: the same seed produces the identical run (roots, journal, origins)', () => {
    const cfg = { seed: 77, peers: 3, rounds: 12, opsPerRound: 3 } as const;
    const a = runSimulation(cfg);
    const b = runSimulation(cfg);
    expect(a.roots).toEqual(b.roots);
    expect(a.relayRegisters).toEqual(b.relayRegisters);
    // full journal equality (incl. origins/hlc) proves the RNG + clock are fully controlled
    expect(a.journal).toEqual(b.journal);
  });

  it('actually mutates state (the sim is not a no-op)', () => {
    const res = runSimulation({ seed: 5, peers: 2, rounds: 6, opsPerRound: 2 });
    expect(res.roots[0]).not.toEqual({
      counters: { a: 0, b: 0, c: 0 },
      labels: { x: '', y: '' },
    });
  });
});
