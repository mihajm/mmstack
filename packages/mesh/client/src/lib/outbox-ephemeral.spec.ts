import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import { store, type AsyncStore } from '@mmstack/primitives/core';
import { meshSync, type MeshSyncOptions as Opts } from './mesh-sync';
import { installFakeLocks, LOCK } from './testing/fake-locks';
import { directTransport } from './transport';

// W2 + W3 of the second-tab charter: `crossTab: 'ephemeral'` on the real client. The persisted
// outbox is a single-writer slot; a tab that did not get the lock runs live on its own origin and
// never reads or writes the slot. Every tab here uses ONE writer (the same user in two tabs).

type State = { title: string; note: string };
const WRITER = 'w';

function peer(relay: Relay, over?: Partial<Opts>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<State>({ title: 'init', note: '' });
    const mesh = meshSync(s, {
      room: 'm',
      writer: WRITER,
      transport: directTransport(relay, { writer: WRITER }),
      ...over,
    });
    return { s, mesh };
  });
}

/** A memory slot store that records every access: `get` keys, `set` keys with the payload origin. */
function spyStore(): {
  store: AsyncStore;
  backing: Map<string, unknown>;
  gets: string[];
  sets: { key: string; origin: string }[];
  /** From now on every `set` lands (and resolves) only when `release` is called. */
  hold: () => { release: () => void };
} {
  const backing = new Map<string, unknown>();
  const gets: string[] = [];
  const sets: { key: string; origin: string }[] = [];
  let held: (() => void)[] | undefined;
  return {
    backing,
    gets,
    sets,
    hold: () => {
      held = [];
      return {
        release: () => {
          const land = held ?? [];
          held = undefined;
          for (const fn of land) fn();
        },
      };
    },
    store: {
      get: (k) => {
        gets.push(k);
        return backing.get(k);
      },
      set: (k, v) => {
        sets.push({ key: k, origin: (v as { origin: string }).origin });
        const queue = held;
        if (!queue) return void backing.set(k, v);
        return new Promise<void>((resolve) =>
          queue.push(() => {
            backing.set(k, v);
            resolve();
          }),
        );
      },
      del: (k) => void backing.delete(k),
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

/** A relay that records the origin of every committed envelope. */
function recordingRelay(): { relay: Relay; origins: string[] } {
  const origins: string[] = [];
  const relay = createRelay({
    onCommit: (_r, env) => void origins.push(env.origin),
  });
  return { relay, origins };
}

const slotOrigin = (backing: Map<string, unknown>, key = 'k'): string =>
  (backing.get(key) as { origin: string }).origin;

/** A store the ephemeral tab must never touch: every call is recorded and throws. */
function trapStore(): { store: AsyncStore; calls: string[] } {
  const calls: string[] = [];
  const boom = (op: string): never => {
    calls.push(op);
    throw new Error(`an ephemeral tab touched the slot: ${op}`);
  };
  return {
    calls,
    store: {
      get: () => boom('get'),
      set: () => boom('set'),
      del: () => boom('del'),
    },
  };
}

const eph = (disk: AsyncStore, key = 'k'): Partial<Opts> => ({
  outbox: { key, store: disk, crossTab: 'ephemeral', debounceMs: 0 },
});
const queue = (disk: AsyncStore, key = 'k'): Partial<Opts> => ({
  outbox: { key, store: disk, crossTab: 'queue', debounceMs: 0 },
});

/** Lets a debounced persist (a macrotask, even at `debounceMs: 0`) fire before counting slot writes. */
const timers = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("meshSync durable outbox — crossTab:'ephemeral' (W2)", () => {
  let fake: ReturnType<typeof installFakeLocks> | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  it.each(['queue', 'ephemeral'] as const)(
    "lock held by a '%s' owner: an 'ephemeral' second tab is live at once and never touches the slot",
    async (ownerMode) => {
      fake = installFakeLocks();
      const { relay, origins } = recordingRelay();
      const disk = spyStore();
      const a = peer(
        relay,
        ownerMode === 'queue' ? queue(disk.store) : eph(disk.store),
      );
      await settle();
      expect(a.mesh.status()).toBe('live');
      const aOrigin = slotOrigin(disk.backing);
      const setsBeforeB = disk.sets.length;

      const b = peer(relay, eph(disk.store));
      await settle();
      expect(b.mesh.status()).toBe('live');
      expect(b.mesh.health().status).toBe('live');
      expect(fake.held.has(LOCK('k'))).toBe(true); // still A's
      expect(fake.grants()).toBe(1);
      expect(disk.gets).toEqual(['k']); // A's restore, and only that
      expect(disk.sets.length).toBe(setsBeforeB); // nothing written between B's open and B live
      expect(disk.sets.every((s) => s.origin === aOrigin)).toBe(true);

      // B's writes go out on its own origin, which is not the slot's
      b.s.note.set('from b');
      await settle();
      await timers();
      const bOrigins = origins.filter((o) => o !== aOrigin);
      expect(bOrigins.length).toBeGreaterThan(0);
      expect(slotOrigin(disk.backing)).toBe(aOrigin);
      expect(disk.sets.filter((s) => bOrigins.includes(s.origin))).toEqual([]);

      a.mesh.close();
      b.mesh.close();
    },
  );

  it('a live ephemeral tab writes through the room; the slot never carries its origin', async () => {
    fake = installFakeLocks();
    const { relay, origins } = recordingRelay();
    const disk = spyStore();
    const a = peer(relay, eph(disk.store));
    await settle();
    const aOrigin = slotOrigin(disk.backing);
    const b = peer(relay, eph(disk.store));
    await settle();

    a.s.title.set('from a'); // A persists on its own outbox changes
    b.s.note.set('from b');
    await settle();
    await timers();

    expect(a.s.note()).toBe('from b'); // B's write reached the relay, and A through it
    const bOrigins = origins.filter((o) => o !== aOrigin);
    expect(bOrigins.length).toBeGreaterThan(0);
    expect(disk.sets.length).toBeGreaterThan(1); // A did persist
    expect(disk.sets.filter((s) => s.origin !== aOrigin)).toEqual([]); // none attributable to B
    expect(disk.gets).toEqual(['k']);

    a.mesh.close();
    b.mesh.close();
  });

  it('D2: the owner closes → the ephemeral tab stays ephemeral and live; the NEXT tab to open owns', async () => {
    fake = installFakeLocks();
    const { relay, origins } = recordingRelay();
    const disk = spyStore();
    const a = peer(relay, eph(disk.store));
    await settle();
    const aOrigin = slotOrigin(disk.backing);
    const b = peer(relay, eph(disk.store));
    await settle();

    a.mesh.close();
    await settle();
    expect(b.mesh.status()).toBe('live');
    expect(fake.held.size).toBe(0); // nobody owns the slot now; B was not promoted
    expect(fake.grants()).toBe(1);

    b.s.note.set('after a');
    await settle();
    await timers();
    const bOrigins = origins.filter((o) => o !== aOrigin);
    expect(bOrigins.length).toBeGreaterThan(0);
    expect(disk.gets).toEqual(['k']); // B never read
    expect(disk.sets.filter((s) => s.origin !== aOrigin)).toEqual([]); // B never wrote

    const c = peer(relay, eph(disk.store));
    await settle();
    expect(c.mesh.status()).toBe('live');
    expect(fake.held.has(LOCK('k'))).toBe(true);
    expect(fake.grants()).toBe(2); // C was granted the lock
    expect(disk.gets).toEqual(['k', 'k']); // C restored
    const cOrigin = slotOrigin(disk.backing);
    expect(cOrigin).not.toBe(aOrigin);
    expect(bOrigins).not.toContain(cOrigin);

    b.mesh.close();
    c.mesh.close();
  });

  it("lock free: an 'ephemeral' tab boots as owner exactly like a 'queue' tab", async () => {
    const observe = async (mode: 'queue' | 'ephemeral') => {
      fake = installFakeLocks();
      const { relay } = recordingRelay();
      const disk = spyStore();
      const a = peer(
        relay,
        mode === 'queue' ? queue(disk.store) : eph(disk.store),
      );
      await settle();
      const seen = {
        status: a.mesh.status(),
        held: fake.held.has(LOCK('k')),
        grants: fake.grants(),
        gets: [...disk.gets],
        setsOwnOrigin:
          disk.sets.length > 0 &&
          disk.sets.every((s) => s.origin === slotOrigin(disk.backing)),
      };
      a.mesh.close();
      fake.restore();
      fake = undefined;
      return seen;
    };
    const q = await observe('queue');
    expect(q).toEqual({
      status: 'live',
      held: true,
      grants: 1,
      gets: ['k'],
      setsOwnOrigin: true,
    });
    expect(await observe('ephemeral')).toEqual(q);
  });

  it("'queue' second tab reports 'waiting' while the owner holds, then goes live when it closes", async () => {
    fake = installFakeLocks();
    const { relay } = recordingRelay();
    const disk = spyStore();
    const a = peer(relay, queue(disk.store));
    await settle();
    const b = peer(relay, queue(disk.store));
    const seen: string[] = [b.mesh.status()];
    const sample = (): void => {
      if (seen[seen.length - 1] !== b.mesh.status()) seen.push(b.mesh.status());
    };
    const sampled = async (): Promise<void> => {
      for (let i = 0; i < 14; i++) {
        await Promise.resolve();
        sample();
        TestBed.tick();
        sample();
      }
    };
    await sampled();
    expect(b.mesh.status()).toBe('waiting');
    expect(b.mesh.health().status).toBe('waiting');
    expect(disk.gets).toEqual(['k']); // a waiting tab has not read the slot

    a.mesh.close();
    await sampled();
    expect(b.mesh.status()).toBe('live');
    // the grant ends the wait: 'connecting' until the welcome, never 'waiting' again
    expect(seen.slice(seen.indexOf('waiting'))).toEqual([
      'waiting',
      'connecting',
      'live',
    ]);
    expect(b.mesh.health().status).toBe('live');
    expect(disk.gets).toEqual(['k', 'k']);

    b.mesh.close();
  });

  it("closing a 'waiting' tab ends it 'closed', never resurrected by a late grant", async () => {
    fake = installFakeLocks();
    const { relay } = recordingRelay();
    const disk = spyStore();
    const a = peer(relay, queue(disk.store));
    await settle();
    const b = peer(relay, queue(disk.store)); // queued behind A
    const c = peer(relay, queue(disk.store)); // queued behind B
    await settle();
    expect(b.mesh.status()).toBe('waiting');
    expect(c.mesh.status()).toBe('waiting');

    b.mesh.close();
    await settle();
    expect(b.mesh.status()).toBe('closed');

    a.mesh.close(); // hand off — C, not the cancelled B, acquires
    await settle();
    expect(c.mesh.status()).toBe('live');
    expect(b.mesh.status()).toBe('closed');
    expect(fake.grants()).toBe(2);

    c.mesh.close();
  });

  it("without navigator.locks, 'ephemeral' warns in dev and boots as the slot owner", async () => {
    // no installFakeLocks — jsdom has no navigator.locks
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { relay } = recordingRelay();
      const disk = spyStore();
      const a = peer(relay, eph(disk.store));
      await settle();
      expect(a.mesh.status()).toBe('live');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Web Locks'));
      expect(disk.gets).toEqual(['k']);
      expect(disk.sets.length).toBeGreaterThan(0); // durable: it pins its origin in the slot
      expect(
        disk.sets.every((s) => s.origin === slotOrigin(disk.backing)),
      ).toBe(true);
      a.mesh.close();
    } finally {
      warn.mockRestore();
    }
  });
});

type Slot = {
  origin: string;
  envs: { origin: string }[];
  floors?: { path: (string | number)[]; epoch: number }[];
  clock?: { p: number; l: number };
};

describe('meshSync durable outbox — slot hand-off and isolation (W2)', () => {
  let fake: ReturnType<typeof installFakeLocks> | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  it("the owner releases the lock only once its final write lands; the successor then restores the owner's tail", async () => {
    fake = installFakeLocks();
    const relay = createRelay({
      onCommit: () => new Promise<void>(() => undefined),
    }); // never acks
    const disk = spyStore();
    const a = peer(relay, queue(disk.store));
    await settle();
    const aOrigin = slotOrigin(disk.backing);
    a.s.title.set('offline');
    await settle();
    await timers();
    expect(a.mesh.acked()).toBe(false); // A has an unacked tail
    const b = peer(relay, queue(disk.store));
    await settle();
    expect(b.mesh.status()).toBe('waiting');

    const slow = disk.hold();
    a.mesh.close(); // its final `set` is in flight
    await settle();
    await timers();
    expect(fake.held.has(LOCK('k'))).toBe(true); // still A's
    expect(fake.grants()).toBe(1);
    expect(disk.gets).toEqual(['k']); // B has not read the slot
    expect(b.mesh.status()).toBe('waiting');

    slow.release();
    await settle();
    expect(fake.grants()).toBe(2);
    expect(disk.gets).toEqual(['k', 'k']);
    // granted, no longer waiting; this relay never commits, so B is never welcomed
    expect(b.mesh.status()).toBe('connecting');
    expect(b.s.title()).toBe('offline');
    const slot = disk.backing.get('k') as Slot;
    expect(slot.origin).not.toBe(aOrigin); // B pinned its own fresh origin
    expect(slot.envs.map((e) => e.origin)).toContain(aOrigin); // and carries A's tail on

    b.mesh.close();
  });

  it.each(['resolve', 'reject'] as const)(
    'waits for an earlier save to %s before saving the final tail and handing off',
    async (outcome) => {
      fake = installFakeLocks();
      const relay = createRelay({
        onCommit: () => new Promise<void>(() => undefined),
      }); // never acks
      const disk = spyStore();
      const a = peer(relay, queue(disk.store));
      await settle();
      const aOrigin = slotOrigin(disk.backing);
      const b = peer(relay, queue(disk.store));
      await settle();

      const originalSet = disk.store.set;
      let finish!: () => void;
      let calls = 0;
      disk.store.set = (key, value) => {
        if (++calls !== 1) return originalSet(key, value);
        return new Promise<void>((resolve, reject) => {
          finish = () => {
            if (outcome === 'reject') reject(new Error('save failed'));
            else {
              originalSet(key, value);
              resolve();
            }
          };
        });
      };

      a.s.title.set('first');
      await settle();
      await timers(); // start a save that stays pending while the owner keeps editing
      expect(calls).toBe(1);
      a.s.note.set('final');
      await settle();
      a.mesh.close();
      await settle();
      expect(calls).toBe(1); // even the final save must wait for the older one
      expect(b.mesh.status()).toBe('waiting');
      expect(fake.grants()).toBe(1);
      expect(disk.gets).toEqual(['k']);

      finish();
      await settle();
      await settle();
      expect(fake.grants()).toBe(2);
      expect(disk.gets).toEqual(['k', 'k']);
      expect(b.s()).toEqual({ title: 'first', note: 'final' });
      const slot = disk.backing.get('k') as Slot;
      expect(slot.origin).not.toBe(aOrigin);
      expect(slot.envs.map((e) => e.origin)).toContain(aOrigin);
      b.mesh.close();
    },
  );

  it('an ephemeral tab never calls its store: boot, write, ack, the owner closing, its own close', async () => {
    fake = installFakeLocks();
    const { relay, origins } = recordingRelay();
    const disk = spyStore();
    const trap = trapStore();
    const a = peer(relay, queue(disk.store));
    await settle();
    const aOrigin = slotOrigin(disk.backing);

    const b = peer(relay, eph(trap.store));
    await settle();
    expect(b.mesh.status()).toBe('live');
    b.s.note.set('one');
    await settle();
    await timers();
    expect(b.mesh.acked()).toBe(true);
    expect(a.s.note()).toBe('one');

    a.mesh.close();
    await settle();
    b.s.note.set('two');
    await settle();
    await timers();
    expect(b.mesh.status()).toBe('live');
    expect(b.mesh.acked()).toBe(true);

    b.mesh.close();
    await settle();
    await timers();
    expect(b.mesh.status()).toBe('closed');
    expect(trap.calls).toEqual([]);
    expect(origins.filter((o) => o !== aOrigin).length).toBeGreaterThan(0);
    expect(disk.sets.filter((s) => s.origin !== aOrigin)).toEqual([]);
  });

  it("mixed: a 'queue' tab waits and takes over; an 'ephemeral' tab is live throughout and never waits", async () => {
    fake = installFakeLocks();
    const { relay } = recordingRelay();
    const disk = spyStore();
    const trap = trapStore();
    const a = peer(relay, queue(disk.store));
    await settle();
    const b = peer(relay, queue(disk.store));
    const c = peer(relay, eph(trap.store));
    const seen = new Set<string>([c.mesh.status()]);
    // sample C's status after every microtask turn and every tick, across both phases
    const sampled = async (): Promise<void> => {
      for (let i = 0; i < 14; i++) {
        await Promise.resolve();
        seen.add(c.mesh.status());
        TestBed.tick();
        seen.add(c.mesh.status());
      }
    };
    await sampled();
    expect(b.mesh.status()).toBe('waiting');
    expect(c.mesh.status()).toBe('live');

    a.mesh.close();
    await sampled();
    expect(b.mesh.status()).toBe('live'); // B owns now
    expect(fake.grants()).toBe(2);
    expect(disk.gets).toEqual(['k', 'k']); // A's restore, then B's
    expect(c.mesh.status()).toBe('live');
    expect([...seen]).toEqual(['connecting', 'live']);
    expect(trap.calls).toEqual([]);

    b.mesh.close();
    c.mesh.close();
  });
});

describe('meshSync durable outbox — a write-free slot keeps its floors and clock', () => {
  it('restores floors and the clock high-water even with an empty tail at version 0', async () => {
    const relay = createRelay();
    const disk = spyStore();
    const future = { p: Date.now() + 60_000, l: 0 };
    const floor = { path: ['title'], epoch: 3 };
    disk.backing.set('k', {
      origin: 'old',
      version: 0,
      envs: [],
      floors: [floor],
      clock: future,
    });
    const a = peer(relay, {
      outbox: { key: 'k', store: disk.store, crossTab: 'off', debounceMs: 0 },
    });
    await settle();
    expect(a.mesh.status()).toBe('live');
    const booted = disk.backing.get('k') as Slot;
    expect(booted.origin).not.toBe('old');
    expect(booted.floors).toContainEqual(floor); // via sync.floors()
    expect(booted.clock).toEqual(future); // carried forward until this boot mints its own stamp

    a.s.note.set('x'); // the first mint stamps at or above the restored clock
    await settle();
    await timers();
    const after = disk.backing.get('k') as Slot;
    expect(after.clock?.p).toBeGreaterThanOrEqual(future.p);

    a.mesh.close();
  });
});

describe('meshSync durable outbox — two live tabs on one key converge (W3)', () => {
  let fake: ReturnType<typeof installFakeLocks> | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  it('owner and ephemeral both write and converge; the ephemeral tab keeps landing writes after the owner closes', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const disk = spyStore();
    const a = peer(relay, eph(disk.store)); // owner: the lock was free
    await settle();
    const b = peer(relay, eph(disk.store)); // ephemeral
    const watcher = peer(relay); // no outbox: a plain reader of the room
    await settle();

    a.s.title.set('from a');
    b.s.note.set('from b');
    await settle();
    const union = { title: 'from a', note: 'from b' };
    expect(a.s()).toEqual(union);
    expect(b.s()).toEqual(union);

    a.mesh.close();
    b.s.note.set('after a');
    await settle();
    expect(b.mesh.status()).toBe('live');
    expect(watcher.s()).toEqual({ title: 'from a', note: 'after a' }); // ownership never gated the room

    b.mesh.close();
    watcher.mesh.close();
  });
});
