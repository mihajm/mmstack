import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { crashablePort, droppingPort, type CrashablePort } from '../testing/harness';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

/** Poll until `cond` holds (or time out). Robust against the variable round-trip count of a crash
 *  respawn (hello, ready, re-subscribe, snapshot), which fixed ticks race on a slow machine. */
async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition never met');
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

type Model = { user: { name: string; age: number }; tags: string[] };
const initial = (): Model => ({ user: { name: 'ada', age: 36 }, tags: ['x'] });

/** A tiny deterministic PRNG so "random" interleavings reproduce across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('workerStore — version-gap recovery', () => {
  it('re-hydrates after a lost batch, recovering the dropped change', async () => {
    const owned = store<Model>(initial(), createStoreContext());
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ stores: { app: owned }, port: port2 });
    const injector = TestBed.inject(Injector);
    // drop the batch that would carry version 2
    const port = droppingPort(
      port1 as unknown as WorkerPortLike,
      (msg) => msg.type === 'store:ops' && msg.batch.version === 2,
    );
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port, { injector }),
    );
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app', { injector }),
    );
    await tick();

    owned.user.name.set('A'); // v1 — applied
    await tick();
    owned.user.age.set(50); // v2 — DROPPED by the port
    await tick();
    owned.tags.set(['A', 'B']); // v3 — gap detected → resync
    await tick();
    await tick();

    // the fresh snapshot carries everything, including the dropped v2 change
    expect(replica.value()).toEqual(owned());
    expect(replica.store.user.age()).toBe(50);
    expect(replica.status()).toBe('resolved');
  });
});

function wire2() {
  const owned = store<Model>(initial(), createStoreContext());
  const injector = TestBed.inject(Injector);
  const host = createWorkerHost({ stores: { app: owned } });
  const mk = () => {
    const { port1, port2 } = new MessageChannel();
    host.connect(port2 as unknown as WorkerPortLike);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
    );
    return TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app', { injector }),
    );
  };
  return { owned, a: mk(), b: mk() };
}

describe('connectWorker — crash / restart', () => {
  function wireCrashable() {
    const owned = store<Model>(initial(), createStoreContext());
    const host = createWorkerHost({
      stores: { app: owned },
      tasks: { echo: (x: number) => x },
    });
    const injector = TestBed.inject(Injector);
    let port: CrashablePort | null = null;
    const spawn = () => {
      const { port1, port2 } = new MessageChannel();
      host.connect(port2 as unknown as WorkerPortLike);
      port = crashablePort(port1 as unknown as WorkerPortLike);
      return port;
    };
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(spawn, { injector, restartDelay: () => 0 }),
    );
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app', { injector }),
    );
    return { owned, worker, replica, crash: () => port!.crash() };
  }

  it('respawns after a crash and re-hydrates to the current owner value', async () => {
    const { owned, worker, replica, crash } = wireCrashable();
    await tick();
    expect(replica.value()).toEqual(initial());

    owned.user.name.set('after-crash');
    crash();
    await waitFor(
      () => worker.connected() && replica.value()?.user.name === 'after-crash',
    );

    expect(worker.connected()).toBe(true); // respawned + re-handshaked
    expect(replica.value()?.user.name).toBe('after-crash'); // re-subscribed + re-hydrated
    expect(replica.status()).toBe('resolved');
  });

  it('rejects an in-flight write with WorkerCrashedError on crash', async () => {
    const { replica, crash } = wireCrashable();
    await tick();
    const pending = replica.write((d) => d.user.name.set('x'));
    crash(); // before the ack can arrive
    await expect(pending).rejects.toHaveProperty('name', 'WorkerCrashedError');
  });

  it('rejects a write issued during the crash window instead of dangling it', async () => {
    const { replica, crash } = wireCrashable();
    await tick();
    crash(); // dead port: a write posted now could never receive its echo
    await expect(
      replica.write((d) => d.user.name.set('y')),
    ).rejects.toHaveProperty('name', 'WorkerCrashedError');
  });

  it('rejects runTask during the crash window, then serves again after respawn', async () => {
    const { worker, crash } = wireCrashable();
    await tick();
    crash();
    await expect(worker.runTask('echo', 1)).rejects.toHaveProperty(
      'name',
      'WorkerCrashedError',
    );
    await waitFor(() => worker.connected());
    await expect(worker.runTask('echo', 2)).resolves.toBe(2);
  });

  it('worker.destroy() settles a pending write instead of dangling it', async () => {
    const { worker, replica } = wireCrashable();
    await tick();
    const pending = replica.write((d) => d.user.name.set('z'));
    worker.destroy(); // before the ack round trip completes
    await expect(pending).rejects.toHaveProperty('name', 'WorkerCrashedError');
  });

  it('replica.destroy() settles its own pending write', async () => {
    const { replica } = wireCrashable();
    await tick();
    const pending = replica.write((d) => d.user.name.set('w'));
    replica.destroy();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('terminates the old worker when it respawns (no orphaned thread)', async () => {
    const owned = store<Model>(initial(), createStoreContext());
    const host = createWorkerHost({ stores: { app: owned } });
    const injector = TestBed.inject(Injector);
    const terminated: number[] = [];
    const ports: CrashablePort[] = [];
    const spawn = () => {
      const { port1, port2 } = new MessageChannel();
      host.connect(port2 as unknown as WorkerPortLike);
      const p = crashablePort(port1 as unknown as WorkerPortLike);
      const idx = ports.length;
      p.terminate = () => terminated.push(idx); // record which worker got terminated
      ports.push(p);
      return p;
    };
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(spawn, { injector, restartDelay: () => 0 }),
    );
    await tick();
    ports[0].crash();
    await waitFor(() => terminated.includes(0) && ports.length > 1);

    expect(terminated).toContain(0); // the original worker was terminated on respawn
    expect(ports.length).toBeGreaterThan(1); // a fresh worker was spawned
    worker.destroy();
  });
});

describe('workerStore — convergence under randomized interleaving', () => {
  it('every replica and the owner end byte-identical (seeded)', async () => {
    for (const seed of [1, 7, 42, 123, 2024]) {
      const { owned, a, b } = wire2();
      await tick();

      const rand = lcg(seed);
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 12; i++) {
        const client = rand() < 0.5 ? a : b;
        const pick = Math.floor(rand() * 3);
        const val = Math.floor(rand() * 1000);
        writes.push(
          client.write((d) => {
            if (pick === 0) d.user.name.set('n' + val);
            else if (pick === 1) d.user.age.set(val);
            else d.tags.set(['t' + val]);
          }),
        );
      }
      await Promise.all(writes);
      await tick();

      expect(a.value()).toEqual(owned());
      expect(b.value()).toEqual(owned());
    }
  });
});
