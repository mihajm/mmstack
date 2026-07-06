import { runBootRace } from './boot-race';

/**
 * These tests CHARACTERIZE a known gap — they assert the current (wrong) boot behavior so it is
 * pinned and visible. When worker+mesh+persist compose on one store, boot has two hydration
 * sources (disk + relay welcome) with no provenance, so `persist`'s boot-window guard resolves it
 * by attach-order/timing, never a merge. The right answer (rebase the disk's offline edits onto the
 * room state) is branching-state's job; when B lands, these expectations flip to "converged".
 */
describe('scenario: boot race (disk vs relay) — KNOWN GAP, feeds branching-state', () => {
  it('persist-first: the relay welcome wins and the offline disk edits are LOST', async () => {
    const res = await runBootRace({ attachOrder: 'persist-first' });
    expect(res.bootRoot.labels.x).toBe('from-room'); // relay state adopted
    expect(res.bootRoot.labels.x).not.toBe('offline-edit'); // <- data loss: the offline edit is gone
    expect(res.bootRoot.counters.a).toBe(7); // relay's value, not disk's 42
  });

  it('mesh-first: the boot peer silently adopts stale disk and DIVERGES from the room (split-brain)', async () => {
    const res = await runBootRace({ attachOrder: 'mesh-first' });
    expect(res.bootRoot.labels.x).toBe('offline-edit'); // stale disk adopted over the synced state
    expect(res.bootRoot.counters.a).toBe(42); // disk's value
    expect(res.roomRoot.labels.x).toBe('from-room'); // <- the room disagrees: no merge, a split brain
  });

  it('the two orderings disagree — the boot outcome is unarbitrated (never a merge)', async () => {
    const a = await runBootRace({ attachOrder: 'persist-first' });
    const b = await runBootRace({ attachOrder: 'mesh-first' });
    expect(a.bootRoot.labels.x).not.toBe(b.bootRoot.labels.x); // same inputs, different outcome
    // and neither is the merge a human would want (offline-edit on x AND from-room's counters):
    const merged = (r: typeof a) => r.bootRoot.labels.x === 'offline-edit' && r.bootRoot.counters.a === 7;
    expect(merged(a)).toBe(false);
    expect(merged(b)).toBe(false);
  });
});
