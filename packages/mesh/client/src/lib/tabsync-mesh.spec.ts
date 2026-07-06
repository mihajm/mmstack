import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import {
  store,
  tabSync,
  type AsyncStore,
  type TabSyncBus,
} from '@mmstack/primitives';
import { vi } from 'vitest';
import { meshSync } from './mesh-sync';
import { directTransport } from './transport';

/**
 * The compose recipe: one store synced across tabs with `tabSync` AND to a room with `meshSync`. The
 * outbox lock makes exactly one tab hold the relay connection (the leader); the others stay inert on
 * the mesh side but still share state through `tabSync`. A follower's write reaches the room through
 * the leader, and a room write reaches a follower through `tabSync`.
 */

type State = { title: string; n: number };
const initial = (): State => ({ title: 'init', n: 0 });

/** A synchronous cross-tab bus network shaped like `TabSyncBus`. */
class FakeBusNet {
  readonly buses = new Set<FakeBus>();
  broadcast(from: FakeBus, id: string, value: unknown): void {
    for (const b of this.buses) if (b !== from) b.deliver(id, value);
  }
}
class FakeBus implements TabSyncBus {
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>();
  constructor(private readonly net: FakeBusNet) {
    net.buses.add(this);
  }
  subscribe<T>(id: string, listener: (data: T) => void) {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    const wrapped = (v: unknown) => listener(v as T);
    set.add(wrapped);
    return {
      unsub: () => set?.delete(wrapped),
      post: (v: T) => this.net.broadcast(this, id, v),
    };
  }
  deliver(id: string, value: unknown): void {
    for (const l of [...(this.listeners.get(id) ?? [])]) l(value);
  }
}

function memStore(): AsyncStore {
  const backing = new Map<string, unknown>();
  return {
    get: (k) => backing.get(k),
    set: (k, v) => void backing.set(k, v),
    del: (k) => void backing.delete(k),
  };
}

/** A minimal exclusive-queue Web Locks stand-in (see outbox-lock.spec for the full one). */
function installFakeLocks(): () => void {
  const held = new Set<string>();
  const waiters = new Map<string, (() => void)[]>();
  const pump = (name: string) => {
    if (held.has(name)) return;
    waiters.get(name)?.shift()?.();
  };
  const request = (
    name: string,
    _o: unknown,
    cb: (l: unknown) => Promise<unknown>,
  ) =>
    new Promise((resolve, reject) => {
      const run = () => {
        held.add(name);
        Promise.resolve(cb({ name })).then(
          (v) => (held.delete(name), resolve(v), pump(name)),
          (e) => (held.delete(name), reject(e), pump(name)),
        );
      };
      const q = waiters.get(name) ?? [];
      q.push(run);
      waiters.set(name, q);
      pump(name);
    });
  const nav = globalThis.navigator as unknown as { locks?: unknown };
  const prev = Object.getOwnPropertyDescriptor(nav, 'locks');
  Object.defineProperty(nav, 'locks', { value: { request }, configurable: true });
  return () => {
    if (prev) Object.defineProperty(nav, 'locks', prev);
    else delete nav.locks;
  };
}

// fake timers own setTimeout (tabSync hello) + Date.now (HLC); the loop also flushes microtasks
// (outbox load + the Web Lock) and ticks Angular effects (the opSync drain)
async function settle(): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await Promise.resolve();
    vi.advanceTimersByTime(50);
    TestBed.tick();
  }
}

describe('compose: tabSync + meshSync on one store', () => {
  let restoreLocks: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    restoreLocks = installFakeLocks();
  });
  afterEach(() => {
    restoreLocks();
    vi.useRealTimers();
  });

  // a tab: one store, shared across tabs by tabSync, synced to the room by meshSync (lock leader)
  function tab(net: FakeBusNet, relay: Relay, disk: AsyncStore, writer: string) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      tabSync(s, { id: 'doc', bus: new FakeBus(net) });
      const mesh = meshSync(s, {
        room: 'r',
        writer,
        transport: directTransport(relay, { writer }),
        outbox: { key: 'shared', store: disk },
      });
      return { s, mesh };
    });
  }
  // a plain room peer, no tabs, to act as the far side of the mesh
  function witness(relay: Relay, writer: string) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'r',
        writer,
        transport: directTransport(relay, { writer }),
      });
      return { s, mesh };
    });
  }

  it('one tab leads the connection, the other waits but still shares state', async () => {
    const net = new FakeBusNet();
    const relay = createRelay();
    const disk = memStore();
    const a = tab(net, relay, disk, 'wa');
    const b = tab(net, relay, disk, 'wb');
    await settle();

    expect(a.mesh.status()).toBe('live'); // A holds the outbox lock
    expect(b.mesh.status()).toBe('connecting'); // B waits on the mesh side

    a.s.title.set('from-a');
    await settle();
    expect(b.s().title).toBe('from-a'); // but B still gets A's write through tabSync

    a.mesh.close();
    b.mesh.close();
  });

  it('a room write reaches the inert follower through tabSync', async () => {
    const net = new FakeBusNet();
    const relay = createRelay();
    const disk = memStore();
    const a = tab(net, relay, disk, 'wa'); // leader
    const b = tab(net, relay, disk, 'wb'); // follower (inert on mesh)
    const c = witness(relay, 'wc');
    await settle();

    c.s.title.set('from-room'); // a far peer writes to the room
    await settle();

    expect(a.s().title).toBe('from-room'); // the leader applied it
    expect(b.s().title).toBe('from-room'); // and tabSync fanned it to the follower

    a.mesh.close();
    b.mesh.close();
    c.mesh.close();
  });

  it("a follower's write reaches the room through the leader", async () => {
    const net = new FakeBusNet();
    const relay = createRelay();
    const disk = memStore();
    const a = tab(net, relay, disk, 'wa'); // leader
    const b = tab(net, relay, disk, 'wb'); // follower
    const c = witness(relay, 'wc');
    await settle();

    b.s.n.set(42); // the follower, which has NO live mesh connection, writes
    await settle();

    // routed follower -> (tabSync) -> leader -> (mesh) -> room -> witness
    expect(a.s().n).toBe(42);
    expect(c.s().n).toBe(42);

    a.mesh.close();
    b.mesh.close();
    c.mesh.close();
  });

  it('on leader close, the follower takes over the connection', async () => {
    const net = new FakeBusNet();
    const relay = createRelay();
    const disk = memStore();
    const a = tab(net, relay, disk, 'wa');
    const b = tab(net, relay, disk, 'wb');
    await settle();
    expect(b.mesh.status()).toBe('connecting');

    a.mesh.close(); // the leader leaves
    await settle();

    expect(b.mesh.status()).toBe('live'); // the follower acquires the lock and connects

    b.mesh.close();
  });
});
