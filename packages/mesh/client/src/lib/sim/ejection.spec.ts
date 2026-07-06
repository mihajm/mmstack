import { converged, journalFolds } from './invariants';
import { runEjectionSimulation } from './chaos-harness';

const hasNegative = (root: unknown): boolean =>
  typeof root === 'object' &&
  root !== null &&
  Object.values(root).some((v) =>
    typeof v === 'number' ? v < 0 : hasNegative(v),
  );

describe('scenario: policy tripwire ejection', () => {
  it('ejects the rogue; honest peers stay live, converge, and never see the poison', () => {
    const res = runEjectionSimulation({
      seed: 1,
      honestPeers: 3,
      rounds: 12,
      opsPerRound: 2,
      faults: { minLatencyMs: 1, maxLatencyMs: 15 },
      violateAtRound: 5,
    });

    expect(res.rogueStatus).toBe('ejected'); // the tripwire fired
    expect(res.honestStatuses.every((s) => s === 'live'), 'an honest peer was wrongly affected').toBe(true);
    expect(converged(res.honestRoots).ok, converged(res.honestRoots).message).toBe(true);
    // the poison never entered the journal or any honest root
    expect(journalFolds(res.journal, res.relayRoot).ok).toBe(true);
    expect(res.honestRoots.some(hasNegative)).toBe(false);
  });

  it('holds across several seeds', () => {
    for (let seed = 0; seed < 12; seed++) {
      const res = runEjectionSimulation({
        seed,
        honestPeers: 3,
        rounds: 10,
        opsPerRound: 2,
        faults: { minLatencyMs: 1, maxLatencyMs: 15 },
        violateAtRound: 4,
      });
      expect(res.rogueStatus, `seed ${seed}: rogue not ejected`).toBe('ejected');
      expect(res.honestStatuses.every((s) => s === 'live'), `seed ${seed}: honest peer affected`).toBe(true);
      const c = converged(res.honestRoots);
      expect(c.ok, `seed ${seed}: ${c.message}`).toBe(true);
      expect(res.honestRoots.some(hasNegative), `seed ${seed}: poison leaked`).toBe(false);
    }
  });
});
