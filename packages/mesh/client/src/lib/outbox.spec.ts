import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay, type SeqEnvelope } from '@mmstack/mesh-protocol';
import { store, type AsyncStore, type OpEnvelope } from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport } from './transport';

type State = { title: string; v: number };
const initial = (): State => ({ title: 'init', v: 0 });

function peer(relay: Relay, writer: string, over?: Partial<MeshSyncOptions>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<State>(initial());
    const mesh = meshSync(s, {
      room: 'm',
      writer,
      transport: directTransport(relay, { writer }),
      ...over,
    });
    return { s, mesh };
  });
}

/** A synchronous in-memory AsyncStore (promises resolve on the microtask queue). */
function memStore(): { store: AsyncStore; backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>();
  return {
    backing,
    store: {
      get: (k) => backing.get(k),
      set: (k, v) => void backing.set(k, v),
      del: (k) => void backing.delete(k),
    },
  };
}

// let the async outbox load (2 microtask hops) + connect + any tick-deferred drain settle
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

const offlineEnv = (): OpEnvelope => ({
  proto: 1,
  origin: 'A',
  writer: 'wa',
  version: 1,
  hlc: { p: Date.now(), l: 0 },
  policyVersion: 0,
  ops: [{ kind: 'set', path: ['title'], next: 'offline', prev: 'init' }],
});

describe('meshSync durable outbox — reboot survival', () => {
  it('restores a persisted outbox on boot: applies the offline edit, resends to the room, a later joiner converges', async () => {
    const relay = createRelay();
    const { store: disk, backing } = memStore();
    // as a prior (rebooted) session left it: origin A, emitted through v1, one unacked offline edit
    backing.set('m:A', { origin: 'A', version: 1, envs: [offlineEnv()] });

    const a = peer(relay, 'wa', { outbox: { key: 'm:A', store: disk, crossTab: 'off' } });
    await settle(); // A boots, restores 'offline', reconnects and resends it to the room

    expect(a.s().title).toBe('offline'); // offline edit applied on boot

    const b = peer(relay, 'wb'); // a joiner AFTER the room carries the restored edit
    await settle();
    expect(b.s().title).toBe('offline'); // the room replayed the restored write → B converges

    a.mesh.close();
    b.mesh.close();
  });

  it('continues the version sequence past the restored high-water (no collision with an acked-but-dropped mint)', async () => {
    const seen: SeqEnvelope[] = [];
    const relay = createRelay({ onCommit: (_r, env) => seen.push(env) });
    const { store: disk, backing } = memStore();
    // high-water 5, but only v3 still unacked (v4/v5 were acked before the reboot, dropped from disk)
    backing.set('m:A', {
      origin: 'A',
      version: 5,
      envs: [
        {
          proto: 1,
          origin: 'A',
          writer: 'wa',
          version: 3,
          hlc: { p: Date.now(), l: 0 },
          policyVersion: 0,
          ops: [{ kind: 'set', path: ['title'], next: 'restored', prev: 'init' }],
        } satisfies OpEnvelope,
      ],
    });

    const a = peer(relay, 'wa', { outbox: { key: 'm:A', store: disk, crossTab: 'off' } });
    await settle();
    a.s.v.set(9); // a fresh local write after boot
    await settle();

    const aVersions = seen.filter((e) => e.origin === 'A').map((e) => e.version);
    expect(aVersions).toContain(3); // the restored tail resent
    expect(aVersions).toContain(6); // the fresh write minted ABOVE the high-water, never re-mints 4/5
    expect(Math.min(...aVersions.filter((v) => v > 3))).toBe(6);

    a.mesh.close();
  });

  it('persists the origin immediately on boot and the unacked tail as it accrues', async () => {
    const relay = createRelay();
    const { store: disk, backing } = memStore();

    const a = peer(relay, 'wa', { outbox: { key: 'm:A', store: disk, crossTab: 'off' } });
    await settle();

    // a fresh origin was minted and pinned to disk immediately (so a later boot reuses it)
    const pinned = backing.get('m:A') as { origin: string; version: number };
    expect(typeof pinned.origin).toBe('string');
    expect(pinned.origin.length).toBeGreaterThan(0);
    const origin = pinned.origin;

    // reboot: a second session over the SAME disk adopts that origin, not a fresh one
    a.mesh.close();
    await settle();
    const b = peer(relay, 'wa', { outbox: { key: 'm:A', store: disk, crossTab: 'off' } });
    await settle();
    expect((backing.get('m:A') as { origin: string }).origin).toBe(origin);

    b.mesh.close();
  });

  it('a store with no persisted outbox boots clean and replicates through the deferred boot', async () => {
    const relay = createRelay();
    const { store: disk } = memStore();
    const a = peer(relay, 'wa', { outbox: { key: 'absent', store: disk, crossTab: 'off' } });
    await settle(); // deferred boot with an empty slot: fresh origin, no restore

    a.s.title.set('live-write');
    await settle(); // A establishes the room with the write

    const b = peer(relay, 'wb');
    await settle();
    expect(b.s().title).toBe('live-write'); // normal replication works through the deferred boot

    a.mesh.close();
    b.mesh.close();
  });
});

describe('meshSync whenReady — assemble the local base before connecting', () => {
  it('holds the connection until whenReady resolves, and loads the outbox only after', async () => {
    const relay = createRelay();
    const order: string[] = [];
    const backing = new Map<string, unknown>();
    const disk: AsyncStore = {
      get: (k) => {
        order.push('outbox-load');
        return backing.get(k);
      },
      set: (k, v) => void backing.set(k, v),
      del: (k) => void backing.delete(k),
    };
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    const a = peer(relay, 'wa', {
      whenReady: () => {
        order.push('ready-start');
        return ready.then(() => void order.push('ready-done'));
      },
      outbox: { key: 'k', store: disk, crossTab: 'off' },
    });
    await settle();
    expect(a.mesh.status()).toBe('connecting'); // gated: no connect yet
    expect(order).toEqual(['ready-start']); // and the outbox has not loaded

    release();
    await settle();
    expect(a.mesh.status()).toBe('live');
    expect(order).toEqual(['ready-start', 'ready-done', 'outbox-load']); // base, then outbox, then connect
    a.mesh.close();
  });

  it('the room supersedes the assembled base, while an outbox edit rebases on top (worker + outbox + mesh)', async () => {
    const relay = createRelay();
    const seeder = peer(relay, 'seed');
    await settle();
    seeder.s.title.set('room-title'); // the room's truth
    await settle();

    const backing = new Map<string, unknown>();
    const disk: AsyncStore = {
      get: (k) => backing.get(k),
      set: (k, v) => void backing.set(k, v),
      del: (k) => void backing.delete(k),
    };
    // an offline edit persisted in the outbox: origin A, v1, sets v = 42
    backing.set('k', {
      origin: 'A',
      version: 1,
      envs: [
        {
          proto: 1,
          origin: 'A',
          writer: 'wa',
          version: 1,
          hlc: { p: Date.now(), l: 0 },
          policyVersion: 0,
          ops: [{ kind: 'set', path: ['v'], next: 42, prev: 0 }],
        },
      ],
    });

    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    const a = peer(relay, 'wa', {
      whenReady: () => ready,
      outbox: { key: 'k', store: disk, crossTab: 'off' },
    });
    // an external source (a worker, say) fills the base while the connection is gated
    a.s.title.set('worker-base');
    a.s.v.set(7);
    release();
    await settle();

    const out = a.s();
    expect(out.title).toBe('room-title'); // the room supersedes the assembled base
    expect(out.v).toBe(42); // the outbox edit rebased on top of the room, not the base's 7

    a.mesh.close();
    seeder.mesh.close();
  });
});
