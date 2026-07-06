import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import { store, type AsyncStore } from '@mmstack/primitives';
import { meshSync, type MeshSyncOptions as Opts } from './mesh-sync';
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

const LOCK = (key: string) => `@mmstack/mesh:outbox:${key}`;

/** A faithful in-process Web Locks stand-in: exclusive, FIFO-queued, `AbortSignal`-cancelable. */
function installFakeLocks() {
  const held = new Set<string>();
  const waiters = new Map<string, { run: () => void; entry: symbol }[]>();
  let requests = 0;

  const pump = (name: string): void => {
    if (held.has(name)) return;
    const q = waiters.get(name);
    if (!q || q.length === 0) return;
    q.shift()?.run();
  };

  const request = (
    name: string,
    options: { mode?: string; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    requests++;
    return new Promise((resolve, reject) => {
      let done = false;
      const entry = Symbol();
      const run = (): void => {
        if (done) return;
        held.add(name);
        Promise.resolve(callback({ name, mode: options.mode ?? 'exclusive' })).then(
          (v) => {
            done = true;
            held.delete(name);
            resolve(v);
            pump(name);
          },
          (e) => {
            done = true;
            held.delete(name);
            reject(e);
            pump(name);
          },
        );
      };
      const q = waiters.get(name) ?? [];
      q.push({ run, entry });
      waiters.set(name, q);
      const onAbort = (): void => {
        const arr = waiters.get(name);
        const i = arr?.findIndex((w) => w.entry === entry) ?? -1;
        if (i >= 0 && !done) {
          arr?.splice(i, 1);
          done = true;
          reject(new DOMException('aborted', 'AbortError'));
        }
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort);
      pump(name);
    });
  };

  const nav = globalThis.navigator as unknown as { locks?: unknown };
  const prev = Object.getOwnPropertyDescriptor(nav, 'locks');
  Object.defineProperty(nav, 'locks', { value: { request }, configurable: true });

  return {
    held,
    requests: () => requests,
    restore: () => {
      if (prev) Object.defineProperty(nav, 'locks', prev);
      else delete nav.locks;
    },
  };
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

  it('a second tab on the same key WAITS while the first holds, then takes over on close (reusing the origin)', async () => {
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
    expect(b.mesh.status()).toBe('connecting'); // queued, never went live
    expect(fake.held.has(LOCK('shared'))).toBe(true); // still A's

    // A closes → the lock hands off → B boots and adopts the persisted (A-owned) origin
    a.mesh.close();
    await settle();
    expect(b.mesh.status()).toBe('live');
    expect((backing.get('shared') as { origin: string }).origin).toBe(ownedOrigin); // reused, not re-minted

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
    expect(b.mesh.status()).toBe('connecting');
    expect(c.mesh.status()).toBe('connecting');

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
