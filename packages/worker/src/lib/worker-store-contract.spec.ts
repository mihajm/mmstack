import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createStoreContext,
  injectTransitionScope,
  provideTransitionScope,
  store,
} from '@mmstack/primitives/core';
import {
  createWorkerHost,
  type WorkerEnvelope,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import {
  workerStore,
  type WorkerStoreOptions,
  type WorkerStoreRef,
} from './worker-store';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: never met');
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

type Model = { user: { name: string }; n: number };
const initial = (): Model => ({ user: { name: 'ada' }, n: 0 });

/** Owner + a respawnable worker; records what each side receives per spawned port. */
function world() {
  const owned = store<Model>(initial(), createStoreContext());
  const host = createWorkerHost({
    stores: { app: owned, other: store({ x: 1 }, createStoreContext()) },
  });
  const up: WorkerEnvelope[][] = [];
  const down: WorkerEnvelope[][] = [];
  const spawn = (): WorkerPortLike => {
    const { port1, port2 } = new MessageChannel();
    host.connect(port2 as unknown as WorkerPortLike);
    const i = up.length;
    up.push([]);
    down.push([]);
    const port: WorkerPortLike = {
      onmessage: null,
      postMessage: (m, t) => {
        up[i].push(structuredClone(m) as WorkerEnvelope);
        port1.postMessage(m, t ?? []);
      },
      close: () => port1.close(),
    };
    port1.onmessage = (ev) => {
      down[i].push(ev.data as WorkerEnvelope);
      port.onmessage?.(ev);
    };
    return port;
  };
  const injector = TestBed.inject(Injector);
  const worker = connectWorker(spawn, { injector, restartDelay: () => 0 });
  const replica = (
    key = 'app',
    opt: WorkerStoreOptions<Model> = {},
  ): WorkerStoreRef<Model> =>
    workerStore<Model>(worker as WorkerRef, key, { injector, ...opt });
  return { owned, host, worker, replica, up, down, injector };
}

describe('workerStore: call shape and lifecycle', () => {
  it('works outside an injection context with an explicit injector', async () => {
    const { replica } = world();
    const r = replica();
    await tick();
    expect(r.value()).toEqual(initial());
  });

  it('isLoading is true until hydrated', async () => {
    const { replica } = world();
    const r = replica();
    expect(r.isLoading()).toBe(true);
    await tick();
    expect(r.isLoading()).toBe(false);
  });

  it('a replica created after the handshake hydrates', async () => {
    const { worker, replica } = world();
    await tick();
    expect(worker.connected()).toBe(true);
    const r = replica();
    await tick();
    expect(r.status()).toBe('resolved');
    expect(r.value()).toEqual(initial());
  });

  it('a direct write before the handshake reaches the owner once hydrated', async () => {
    const { owned, replica } = world();
    const r = replica('app', { defaultValue: initial() });
    r.store.n.set(4);
    await tick();
    expect(owned().n).toBe(4);
    expect(r.value()).toEqual(owned());
  });

  it('a destroyed replica stops folding at once, and the host stops sending to it', async () => {
    const { owned, host, replica, down } = world();
    const r = replica();
    await tick();
    owned.n.set(1);
    host.flush();
    r.destroy();
    await tick();
    expect(r.value()?.n).toBe(0);
    const before = down[0].filter((m) => m.type === 'store:sync').length;
    owned.n.set(2);
    await tick();
    expect(down[0].filter((m) => m.type === 'store:sync').length).toBe(before);
  });

  it('destroying the owning injector rejects a pending write with AbortError', async () => {
    const { replica } = world();
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const r = replica('app', { injector: child });
    await tick();
    const pending = r.write((d) => d.n.set(3));
    child.destroy();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });
});

describe('workerStore: across a dropped connection', () => {
  it('direct writes made while down land on the owner in order after the respawn', async () => {
    const { owned, worker, replica } = world();
    const r = replica();
    await tick();
    worker.restart();
    r.store.n.set(7);
    await Promise.resolve();
    await Promise.resolve();
    r.store.user.name.set('offline');
    r.store.n.set(8);
    await waitFor(() => worker.connected() && owned().n === 8);
    await tick();
    expect(owned()).toEqual({ user: { name: 'offline' }, n: 8 });
    expect(r.value()).toEqual(owned());
  });

  it('acked writes are not resent after the respawn', async () => {
    const { worker, replica, up } = world();
    const r = replica();
    await tick();
    await r.write((d) => d.n.set(1));
    await r.write((d) => d.n.set(2));
    worker.restart();
    await waitFor(() => worker.connected() && r.status() === 'resolved');
    await tick();
    expect(up[1].filter((m) => m.type === 'store:sync')).toHaveLength(0);
  });

  it('a destroyed replica does not subscribe again after a respawn; a live one does', async () => {
    const { worker, replica, up } = world();
    const gone = replica('app');
    replica('other');
    await tick();
    gone.destroy();
    worker.restart();
    await waitFor(() => worker.connected());
    await tick();
    const subs = up[1].filter((m) => m.type === 'store:subscribe');
    expect(subs.map((m) => (m as { store: string }).store)).toEqual(['other']);
  });
});

describe('workerStore: register', () => {
  const setup = () => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    const w = world();
    const scope = TestBed.runInInjectionContext(() => injectTransitionScope());
    return { ...w, scope };
  };
  const make = (
    w: ReturnType<typeof setup>,
    register?: 'indicator' | 'suspend',
  ) =>
    TestBed.runInInjectionContext(() =>
      workerStore<Model>(w.worker, 'app', { register }),
    );

  it('without register it stays out of the scope', () => {
    const w = setup();
    make(w);
    expect(w.scope.resources()).toHaveLength(0);
    expect(w.scope.pending()).toBe(false);
  });

  it("'indicator' drives pending and never suspends", async () => {
    const w = setup();
    make(w, 'indicator');
    expect(w.scope.pending()).toBe(true);
    expect(w.scope.suspended('value')).toBe(false);
    await tick();
    expect(w.scope.pending()).toBe(false);
  });

  it("'suspend' gates first paint until hydrated", async () => {
    const w = setup();
    make(w, 'suspend');
    expect(w.scope.suspended('value')).toBe(true);
    await tick();
    expect(w.scope.suspended('value')).toBe(false);
  });

  it('a manual destroy while loading leaves the scope and settles pending writes', async () => {
    const w = setup();
    const r = make(w, 'suspend');
    expect(w.scope.pending()).toBe(true);
    r.destroy();
    expect(w.scope.resources()).not.toContain(r);
    expect(w.scope.pending()).toBe(false);
    expect(w.scope.suspended('value')).toBe(false);
  });

  it('a manual destroy of a hydrated replica rejects its pending write', async () => {
    const w = setup();
    const r = make(w, 'indicator');
    await tick();
    const pending = r.write((d) => d.n.set(5));
    r.destroy();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(w.scope.resources()).not.toContain(r);
  });
});
