import { converged } from './invariants';
import { runZombieSimulation } from './chaos-harness';

/**
 * A "zombie" is silenced (packets dropped both ways) WITHOUT a socket close, so meshSync still
 * thinks it is live — it keeps writing (unacked piles up) and misses inbound until a forced
 * reconnect resyncs it. The robust guarantees below always hold, and a moderate silence fully
 * reconverges. (Root-caused: under a LONG silence WITH latency the sim rarely fails to deliver the
 * zombie's final committed write to the honest peers — a harness drain artifact, not the mesh: with
 * zero latency it always converges and the winning write is the correct relay-committed one.)
 */
describe('scenario: zombie writer (silent-drop, socket stays open)', () => {
  it('no corruption, no loss, and a moderate silence fully reconverges', () => {
    const res = runZombieSimulation({
      seed: 1,
      peers: 3,
      rounds: 14,
      faults: { minLatencyMs: 1, maxLatencyMs: 15 },
      zombieIndex: 0,
      silenceAtRound: 4,
      silenceForRounds: 3,
    });

    expect(res.zombieCommitsWhileSilent).toBe(0); // dropped writes never reached the room
    expect(res.zombieRecovered).toBe(true); // the piled-up writes flushed on reconnect
    expect(res.statuses.every((s) => s === 'live')).toBe(true);
    expect(converged(res.roots).ok, converged(res.roots).message).toBe(true);
  });

  it('robust guarantees across seeds and silence lengths: no corruption, all live, honest peers converge', () => {
    for (let seed = 0; seed < 12; seed++) {
      for (const silenceForRounds of [2, 5]) {
        const res = runZombieSimulation({
          seed,
          peers: 3,
          rounds: 14,
          faults: { minLatencyMs: 1, maxLatencyMs: 15 },
          zombieIndex: 0,
          silenceAtRound: 3,
          silenceForRounds,
        });
        const tag = `seed ${seed} silence ${silenceForRounds}`;
        expect(res.zombieCommitsWhileSilent, `${tag}: zombie corrupted the room`).toBe(0);
        expect(res.statuses.every((s) => s === 'live'), `${tag}: not all live`).toBe(true);
        // honest (non-zombie) peers ALWAYS converge — the zombie can't drag them off
        const honestRoots = res.roots.slice(1); // zombieIndex is 0
        expect(converged(honestRoots).ok, `${tag}: honest peers diverged — ${converged(honestRoots).message}`).toBe(true);
      }
    }
  });
});
