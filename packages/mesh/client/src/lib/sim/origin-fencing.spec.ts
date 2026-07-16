import { TestBed } from '@angular/core/testing';
import { createRelay, type SeqEnvelope } from '@mmstack/mesh-protocol';
import {
  OP_PROTO_VERSION,
  store,
  tabSync,
  type AsyncStore,
  type OpEnvelope,
  type TabSyncBus,
} from '@mmstack/primitives';
import { vi } from 'vitest';
import { meshSync, type MeshSyncOptions } from '../mesh-sync';
import { directTransport } from '../transport';

/**
 * Origin fencing: a dot is `(origin, hlc)`, so convergence stands on every replica minting
 * on an origin nobody else uses. These tests pin the two boundary cases: tabs (each tab is
 * its own replica → its own origin) and cloned persisted storage (the classic dot-reuse
 * killer).
 */

type State = { title: string; n: number };
const initial = (): State => ({ title: 'init', n: 0 });

/** A synchronous cross-tab bus network shaped like `TabSyncBus`, recording all traffic. */
class FakeBusNet {
  readonly buses = new Set<FakeBus>();
  readonly posted: unknown[] = [];
  broadcast(from: FakeBus, id: string, value: unknown): void {
    this.posted.push(value);
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
  for (let i = 0; i < 24; i++) {
    await Promise.resolve();
    vi.advanceTimersByTime(50);
    TestBed.tick();
  }
}

const offlineEnv = (): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  origin: 'A',
  writer: 'wa',
  version: 1,
  hlc: { p: 1_700_000_000_000, l: 0 },
  policyVersion: 0,
  ops: [{ kind: 'set', path: ['n'], next: 42, prev: 0, cites: [], epoch: 0 }],
});

describe('origin fencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('two tabs under store-mode tabSync mint DISTINCT origins (each replica is its own origin)', async () => {
    const net = new FakeBusNet();
    const t1 = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      tabSync(s, { id: 'doc', bus: new FakeBus(net) });
      return s;
    });
    const t2 = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      tabSync(s, { id: 'doc', bus: new FakeBus(net) });
      return s;
    });
    await settle();

    t1.title.set('from-tab-1');
    await settle();
    t2.n.set(7);
    await settle();

    const envOrigins = new Set(
      net.posted
        .filter(
          (m): m is { t: 'env'; env: OpEnvelope } =>
            typeof m === 'object' && m !== null && (m as { t?: string }).t === 'env',
        )
        .map((m) => m.env.origin),
    );
    expect(envOrigins.size).toBe(2); // both tabs wrote, each on its own origin
    expect(t1()).toEqual({ title: 'from-tab-1', n: 7 });
    expect(t2()).toEqual(t1());
  });

  it('a cloned outbox restores as identical duplicates: the resent envelope is idempotent everywhere', async () => {
    const seen: SeqEnvelope[] = [];
    const relay = createRelay({ onCommit: (_r, env) => seen.push(env) });
    const witness = TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = meshSync(s, {
        room: 'clone',
        writer: 'ww',
        transport: directTransport(relay, { writer: 'ww' }),
      });
      return { s, mesh };
    });
    await settle();
    witness.s.title.set('room');
    await settle();

    // the same persisted outbox, byte-cloned onto two disks (backup restore, profile copy)
    const persisted = { origin: 'A', version: 1, envs: [offlineEnv()] };
    const disk1 = memStore();
    disk1.backing.set('k', structuredClone(persisted));
    const disk2 = memStore();
    disk2.backing.set('k', structuredClone(persisted));

    const boot = (disk: AsyncStore, over?: Partial<MeshSyncOptions>) =>
      TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'clone',
          writer: 'wa',
          transport: directTransport(relay, { writer: 'wa' }),
          outbox: { key: 'k', store: disk, crossTab: 'off' },
          ...over,
        });
        return { s, mesh };
      });

    const a1 = boot(disk1.store);
    await settle();
    expect(witness.s().n).toBe(42); // the restored offline write reached the room
    a1.mesh.close();
    await settle();

    const a2 = boot(disk2.store); // the clone restores and resends the SAME envelope
    await settle();

    // the duplicate is dedup'd by (origin, version): nothing double-applies, all converge
    expect(seen.filter((e) => e.origin === 'A' && e.version === 1).length).toBeGreaterThanOrEqual(1);
    expect(witness.s()).toEqual({ title: 'room', n: 42 });
    expect(a2.s()).toEqual(witness.s());

    a2.mesh.close();
    witness.mesh.close();
  });

  it('per-boot origin fencing: two clones of one outbox mint DISTINCT origins, so new writes never collide', async () => {
    // The classic dot-reuse killer: one persisted outbox byte-cloned onto two disks. Each boot mints
    // a FRESH origin and only RESENDS the persisted tail verbatim under its recorded origin (origin
    // 'A'). So the two clones resend an identical 'A' envelope (a duplicate, dedup'd at receivers)
    // while every NEW write lands on the clone's own fresh origin. Two distinct origins cannot share
    // a dot, so nothing collides and both clones converge.
    const persisted = { origin: 'A', version: 1, envs: [offlineEnv()] };
    const disk1 = memStore();
    disk1.backing.set('k', structuredClone(persisted));
    const disk2 = memStore();
    disk2.backing.set('k', structuredClone(persisted));

    // one shared relay (room): both clones join, each resends the 'A' tail, then writes on its own
    const relay = createRelay();
    const boot = (disk: AsyncStore, writer: string) =>
      TestBed.runInInjectionContext(() => {
        const s = store<State>(initial());
        const mesh = meshSync(s, {
          room: 'clone',
          writer,
          transport: directTransport(relay, { writer }),
          outbox: { key: 'k', store: disk, crossTab: 'off' },
        });
        return { s, mesh };
      });

    // both boot as 'wa' — the writer the tail was recorded under (a byte clone is the same
    // principal on two disks; a tail under a FOREIGN writer is dropped at restore, not resent)
    const a1 = boot(disk1.store, 'wa');
    const a2 = boot(disk2.store, 'wa');
    await settle();

    const pinned1 = (disk1.backing.get('k') as { origin: string }).origin;
    const pinned2 = (disk2.backing.get('k') as { origin: string }).origin;
    expect(pinned1).not.toBe('A'); // fresh origin minted, the persisted 'A' is NOT reused for minting
    expect(pinned2).not.toBe('A');
    expect(pinned1).not.toBe(pinned2); // the two clones fenced onto distinct origins

    // both applied the resent offline tail (n=42) and converge after independent fresh-origin writes
    expect(a1.s().n).toBe(42); // the cloned offline edit reached the room
    expect(a2.s().n).toBe(42);
    a1.s.title.set('from-1');
    await settle();
    expect(a2.s().title).toBe('from-1'); // a1's fresh-origin write reached a2
    expect(a1.s()).toEqual(a2.s()); // no divergence: distinct origins never mint a colliding dot
    expect(a1.s()).toEqual({ title: 'from-1', n: 42 });

    a1.mesh.close();
    a2.mesh.close();
  });
});
