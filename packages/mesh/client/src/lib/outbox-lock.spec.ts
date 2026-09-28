import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import { store, type AsyncStore } from '@mmstack/primitives/core';
import { meshSync, type MeshSyncOptions as Opts } from './mesh-sync';
import { installFakeLocks, LOCK } from './testing/fake-locks';
import { directTransport } from './transport';

type State = { title: string };

function peer(relay: Relay, writer: string, over?: Partial<Opts>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<State>({ title: 'init' });
    const mesh = meshSync(s, {
      room: 'm',
      writer,
      transport: directTransport(relay, { writer }),
      ...over,
    });
    return { s, mesh };
  });
}

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

async function settle(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

describe('meshSync durable outbox — cross-tab single-writer lock', () => {
  let fake: ReturnType<typeof installFakeLocks> | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });

  it('crossTab:"queue" (default) acquires the lock and boots live', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const { store: disk } = memStore();
    const a = peer(relay, 'wa', { outbox: { key: 'k', store: disk } }); // default crossTab
    await settle();

    expect(a.mesh.status()).toBe('live');
    expect(fake.held.has(LOCK('k'))).toBe(true); // held for this tab's lifetime
    expect(fake.requests()).toBe(1);

    a.mesh.close();
    await settle();
    expect(fake.held.has(LOCK('k'))).toBe(false); // released on close
  });

  it('a second tab on the same key WAITS while the first holds, then takes over on close (minting a fresh origin)', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const { store: disk, backing } = memStore();

    const a = peer(relay, 'wa', { outbox: { key: 'shared', store: disk } });
    await settle();
    expect(a.mesh.status()).toBe('live');
    const ownedOrigin = (backing.get('shared') as { origin: string }).origin;

    // B contends for the SAME key — it must not boot while A holds the lock
    const b = peer(relay, 'wb', { outbox: { key: 'shared', store: disk } });
    await settle();
    expect(b.mesh.status()).toBe('waiting'); // queued, never went live
    expect(fake.held.has(LOCK('shared'))).toBe(true); // still A's

    // A closes → the lock hands off → B boots. It does NOT reuse A's origin: every boot mints a
    // fresh one (a byte clone of this disk must never resurrect an origin and mint colliding dots).
    // A's unacked tail still resends verbatim under A's origin; B's new writes are its own.
    a.mesh.close();
    await settle();
    expect(b.mesh.status()).toBe('live');
    expect((backing.get('shared') as { origin: string }).origin).not.toBe(ownedOrigin); // fresh mint

    b.mesh.close();
  });

  it('distinct keys do not contend — both tabs are live at once', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const { store: disk } = memStore();

    const a = peer(relay, 'wa', { outbox: { key: 'ka', store: disk } });
    const b = peer(relay, 'wb', { outbox: { key: 'kb', store: disk } });
    await settle();

    expect(a.mesh.status()).toBe('live');
    expect(b.mesh.status()).toBe('live');
    expect(fake.held.has(LOCK('ka'))).toBe(true);
    expect(fake.held.has(LOCK('kb'))).toBe(true);

    a.mesh.close();
    b.mesh.close();
  });

  it('crossTab:"off" never touches the lock — two tabs on one key both boot', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const { store: disk } = memStore();

    const a = peer(relay, 'wa', { outbox: { key: 'k', store: disk, crossTab: 'off' } });
    const b = peer(relay, 'wb', { outbox: { key: 'k', store: disk, crossTab: 'off' } });
    await settle();

    expect(a.mesh.status()).toBe('live');
    expect(b.mesh.status()).toBe('live'); // no lock → no waiting
    expect(fake.requests()).toBe(0); // the lock manager was never asked
  });

  it('closing a WAITING tab cancels its queued request, so it never steals the lock from the next waiter', async () => {
    fake = installFakeLocks();
    const relay = createRelay();
    const { store: disk } = memStore();

    const a = peer(relay, 'wa', { outbox: { key: 'shared', store: disk } });
    await settle();
    const b = peer(relay, 'wb', { outbox: { key: 'shared', store: disk } }); // queued behind A
    const c = peer(relay, 'wc', { outbox: { key: 'shared', store: disk } }); // queued behind B
    await settle();
    expect(b.mesh.status()).toBe('waiting');
    expect(c.mesh.status()).toBe('waiting');

    b.mesh.close(); // abort B's queued request before it is ever granted
    await settle();
    expect(b.mesh.status()).toBe('closed');

    a.mesh.close(); // hand off — C (not the cancelled B) must acquire
    await settle();
    expect(c.mesh.status()).toBe('live');
    expect(b.mesh.status()).toBe('closed'); // B stayed torn down, never resurrected by a late grant

    c.mesh.close();
  });

  it('without navigator.locks, crossTab:"queue" warns in dev and boots without a lock', async () => {
    // no installFakeLocks — jsdom has no navigator.locks
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const relay = createRelay();
      const { store: disk } = memStore();
      const a = peer(relay, 'wa', { outbox: { key: 'k', store: disk } });
      await settle();

      expect(a.mesh.status()).toBe('live'); // degrades gracefully to no-lock
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Web Locks'),
      );
      a.mesh.close();
    } finally {
      warn.mockRestore();
    }
  });
});
