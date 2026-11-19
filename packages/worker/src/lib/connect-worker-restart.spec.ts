import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it, vi } from 'vitest';
import { connectWorker, type ConnectWorkerOptions } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

type Model = { n: number };
type Spawned = WorkerPortLike & {
  onerror: ((e?: unknown) => void) | null;
  terminated: boolean;
  fail(): void;
};

/** Every spawn gets a fresh owner host, as a real respawned worker does. */
function world(opt: Omit<ConnectWorkerOptions, 'injector'> = {}) {
  const owners: ReturnType<typeof store<Model>>[] = [];
  const spawned: Spawned[] = [];
  const never = () => new Promise(() => undefined);
  const spawn = (): WorkerPortLike => {
    const owned = store<Model>(
      { n: owners.length * 100 },
      createStoreContext(),
    );
    owners.push(owned);
    const host = createWorkerHost({
      stores: { app: owned },
      tasks: { never, echo: (x: number) => x },
    });
    const { port1, port2 } = new MessageChannel();
    host.connect(port2 as unknown as WorkerPortLike);
    const w: Spawned = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage: (m, t) => port1.postMessage(m, t ?? []),
      terminate: () => {
        w.terminated = true;
        port1.close();
      },
      fail: () => {
        port1.onmessage = null;
        w.onerror?.(new Event('error'));
      },
    };
    port1.onmessage = (ev) => w.onmessage?.(ev);
    spawned.push(w);
    return w;
  };
  const injector = TestBed.inject(Injector);
  const ref = connectWorker(spawn, { injector, restartDelay: () => 0, ...opt });
  return { ref, spawned, owners, injector };
}

describe('WorkerRef.restart()', () => {
  it('from inside onError: respawns, and the replica re-hydrates from the new owner', async () => {
    let restartFromHandler = (): void => undefined;
    const w = world({ onError: () => restartFromHandler() });
    restartFromHandler = () => w.ref.restart();
    const replica = workerStore<Model>(w.ref, 'app', { injector: w.injector });
    await tick();
    expect(replica.value()).toEqual({ n: 0 });

    w.spawned[0].onerror?.(new Event('error'));
    expect(w.ref.connected()).toBe(false);
    expect(w.spawned).toHaveLength(2);
    await tick();
    expect(w.ref.connected()).toBe(true);
    expect(replica.value()).toEqual({ n: 100 });
    expect(replica.status()).toBe('resolved');
    await expect(w.ref.runTask('echo', 3)).resolves.toBe(3);
    w.ref.destroy();
  });

  it('rejects pending tasks with WorkerCrashedError and closes the old worker', async () => {
    const w = world();
    await tick();
    const pending = w.ref.runTask('never', null);
    w.ref.restart();
    await expect(pending).rejects.toHaveProperty('name', 'WorkerCrashedError');
    expect(w.spawned[0].terminated).toBe(true);
    expect(w.spawned).toHaveLength(2);
    w.ref.destroy();
  });

  it('respawns at once, with no backoff delay', async () => {
    const restartDelay = vi.fn(() => 60_000);
    const w = world({ restartDelay });
    await tick();
    w.ref.restart();
    expect(w.spawned).toHaveLength(2);
    expect(restartDelay).not.toHaveBeenCalled();
    await tick();
    expect(w.ref.connected()).toBe(true);
    w.ref.destroy();
  });

  it('is a no-op while a respawn is pending', async () => {
    const w = world();
    await tick();
    w.ref.restart();
    w.ref.restart();
    expect(w.spawned).toHaveLength(2);
    await tick();
    expect(w.ref.connected()).toBe(true);

    const slow = world({ restartDelay: () => 20 });
    slow.spawned[0].fail();
    slow.ref.restart();
    expect(slow.spawned).toHaveLength(1);
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(slow.spawned).toHaveLength(2);
    w.ref.destroy();
    slow.ref.destroy();
  });

  it('is a no-op while an automatic respawn is spawned but not yet ready', () => {
    vi.useFakeTimers();
    try {
      const w = world({ restartDelay: () => 20 });
      w.spawned[0].fail();
      vi.advanceTimersByTime(20);
      expect(w.spawned).toHaveLength(2);
      w.ref.restart();
      expect(w.spawned).toHaveLength(2);
      w.ref.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op after destroy()', async () => {
    const w = world();
    await tick();
    w.ref.destroy();
    w.ref.restart();
    await tick();
    expect(w.spawned).toHaveLength(1);
    expect(w.ref.connected()).toBe(false);
  });

  it("respawns under restart: 'manual', after a startup failure and after ready", async () => {
    const w = world({ restart: 'manual' });
    w.spawned[0].fail();
    await tick();
    expect(w.spawned).toHaveLength(1);
    w.ref.restart();
    await tick();
    expect(w.spawned).toHaveLength(2);
    expect(w.ref.connected()).toBe(true);

    w.ref.restart();
    await tick();
    expect(w.spawned).toHaveLength(3);
    expect(w.spawned[1].terminated).toBe(true);
    expect(w.ref.connected()).toBe(true);
    w.ref.destroy();
  });
});
