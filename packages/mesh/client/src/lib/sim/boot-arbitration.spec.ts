import { TestBed } from '@angular/core/testing';
import { isConflicted, opSync, policyStrategy, preserve, store } from '@mmstack/primitives';
import { initialDoc, type SimDoc } from './model';

/**
 * The branching-state answer to the boot race (boot-race.spec characterizes the current loss).
 * Instead of "first writer wins" (offline edits lost, or stale disk clobbers the room), the disk's
 * offline edits are a BRANCH that rebases onto the room state via the shipped `policyStrategy`
 * 3-way merge (ancestor = last-synced, mine = disk, theirs = relay welcome). This test proves the
 * substrate B builds on already resolves what A flagged — both sides survive, no split-brain.
 */
describe('boot arbitration (branching-state) — resolves the boot race by rebase, not race', () => {
  const ancestor: SimDoc = { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'synced', y: '' } };

  it('preserves BOTH offline edits and room edits when they touch different fields', () => {
    const disk: SimDoc = { counters: { a: 42, b: 0, c: 0 }, labels: { x: 'offline-edit', y: '' } };
    const room: SimDoc = { counters: { a: 0, b: 5, c: 0 }, labels: { x: 'synced', y: 'room-edit' } };

    const merged = policyStrategy<SimDoc>([])(ancestor, disk, room);

    // offline edits (a, x) AND room edits (b, y) both survive — the boot race loses one or the other
    expect(merged).toEqual({ counters: { a: 42, b: 5, c: 0 }, labels: { x: 'offline-edit', y: 'room-edit' } });
  });

  it('resolves a true conflict per policy (default lww keeps the offline side deterministically)', () => {
    const disk: SimDoc = { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'offline-x', y: '' } };
    const room: SimDoc = { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'room-x', y: '' } };

    const merged = policyStrategy<SimDoc>([])(ancestor, disk, room);
    expect(merged.labels.x).toBe('offline-x'); // both changed x → lww default → mine (disk)
  });

  it('a preserve policy surfaces the conflict as data instead of silently dropping a side', () => {
    const disk: SimDoc = { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'offline-x', y: '' } };
    const room: SimDoc = { counters: { a: 0, b: 0, c: 0 }, labels: { x: 'room-x', y: '' } };

    const merged = policyStrategy<SimDoc>([{ path: 'labels.x', merge: preserve }])(ancestor, disk, room);
    expect(isConflicted(merged.labels.x)).toBe(true);
  });

  it('the ops model: offline opSync edits survive a reconnect hydrate and merge with room changes', () => {
    // This is the durable-outbox mechanism in-memory: offline edits are unacked ops that
    // opSync.hydrate re-applies on top of the room snapshot, rather than being clobbered by it.
    const result = TestBed.runInInjectionContext(() => {
      const s = store<SimDoc>(initialDoc());
      const sync = opSync(s, { writer: 'offline', origin: 'o1' });
      s.labels.x.set('offline-edit'); // edited while disconnected (never sent)
      TestBed.tick();

      const roomRoot: SimDoc = { counters: { a: 0, b: 5, c: 0 }, labels: { x: 'init', y: 'room-edit' } };
      sync.hydrate(roomRoot, {}); // reconnect: adopt the room, re-apply the offline pending
      TestBed.tick();

      const out = s();
      sync.destroy();
      return out;
    });

    expect(result.labels.x).toBe('offline-edit'); // offline edit preserved
    expect(result.labels.y).toBe('room-edit'); // room edit present
    expect(result.counters.b).toBe(5); // room edit present
  });
});
