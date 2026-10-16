import { computed, Injector, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  storeFrontierEquals,
  type StoreFrontier,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

function connect(host: ReturnType<typeof createWorkerHost>) {
  const { port1, port2 } = new MessageChannel();
  host.connect(port2 as unknown as WorkerPortLike);
  const injector = TestBed.inject(Injector);
  return TestBed.runInInjectionContext(() =>
    connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
  );
}

describe('published subtrees (rung 3)', () => {
  it('mirrors a worker-side derivation to a read-only replica', async () => {
    type Data = { items: number[] };
    const data = store<Data>({ items: [1, 2, 3] }, createStoreContext());
    const total = computed(() => ({
      sum: data().items.reduce((a, b) => a + b, 0),
      count: data().items.length,
    }));
    const host = createWorkerHost({ stores: { data }, published: { total } });
    const injector = TestBed.inject(Injector);
    const worker = connect(host);
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<{ sum: number; count: number }>(worker, 'total', { injector }),
    );
    await tick();

    expect(worker.manifest()?.published).toEqual(['total']);
    expect(replica.value()).toEqual({ sum: 6, count: 3 });

    data.items.set([1, 2, 3, 4]);
    await tick();
    expect(replica.store.sum()).toBe(10);
    expect(replica.store.count()).toBe(4);
  });

  it('propagates a published computation status: pending holds the value', async () => {
    const backing = signal<{ n: number }>({ n: 1 });
    const st = signal<ResourceStatus>('resolved');
    const pub = Object.assign(computed(() => backing()), { status: st });

    const host = createWorkerHost({ published: { calc: pub } });
    const injector = TestBed.inject(Injector);
    const worker = connect(host);
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<{ n: number }>(worker, 'calc', { injector }),
    );
    await tick();
    expect(replica.status()).toBe('resolved');
    expect(replica.value()).toEqual({ n: 1 });

    st.set('reloading');
    await tick();
    expect(replica.status()).toBe('reloading');
    expect(replica.value()).toEqual({ n: 1 });

    backing.set({ n: 2 });
    st.set('resolved');
    await tick();
    expect(replica.value()).toEqual({ n: 2 });
    expect(replica.status()).toBe('resolved');
  });

  it('a replica subscribing MID-computation sees pending immediately (no missed transition)', async () => {
    const backing = signal<{ n: number }>({ n: 1 });
    const st = signal<ResourceStatus>('reloading');
    const pub = Object.assign(computed(() => backing()), { status: st });

    const host = createWorkerHost({ published: { calc: pub } });
    const injector = TestBed.inject(Injector);
    const worker = connect(host);
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<{ n: number }>(worker, 'calc', { injector }),
    );
    await tick();

    expect(replica.value()).toEqual({ n: 1 });
    expect(replica.status()).toBe('reloading');

    backing.set({ n: 2 });
    st.set('resolved');
    await tick();
    expect(replica.value()).toEqual({ n: 2 });
    expect(replica.status()).toBe('resolved');
  });

  it('rejects a write routed to a read-only published subtree', async () => {
    const backing = signal<{ n: number }>({ n: 0 });
    const pub = computed(() => backing());
    const host = createWorkerHost({ published: { calc: pub } });
    const injector = TestBed.inject(Injector);
    const worker = connect(host);
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<{ n: number }>(worker, 'calc', { injector }),
    );
    await tick();
    await expect(replica.write((d) => d.n.set(9))).rejects.toThrow('read-only');
  });

  it('a derivation carries the frontier it was computed against; a client compares it with its replica', async () => {
    type Room = { cells: { a: number; b: number } };
    type Check = { total: number; of: StoreFrontier };
    const room = store<Room>({ cells: { a: 1, b: 0 } }, createStoreContext());
    const host = createWorkerHost({
      stores: { room },
      published: {
        check: ({ frontiers }) =>
          computed(() => ({
            total: Object.values(room().cells).reduce((x, y) => x + y, 0),
            of: frontiers.room(),
          })),
      },
    });
    const injector = TestBed.inject(Injector);
    const worker = connect(host);
    const doc = TestBed.runInInjectionContext(() =>
      workerStore<Room>(worker, 'room', { injector }),
    );
    const check = TestBed.runInInjectionContext(() =>
      workerStore<Check>(worker, 'check', { injector }),
    );
    const checked = computed(() => {
      const c = check.value();
      return !!c && storeFrontierEquals(c.of, doc.applied());
    });
    await tick();
    expect(checked()).toBe(true);

    // an own write: the replica is ahead of the derivation until the owner folds it and re-derives
    const acked = doc.write((d) => d.cells.b.set(2));
    expect(checked()).toBe(false);
    await acked;
    await tick();
    expect(checked()).toBe(true);
    expect(check.value()?.total).toBe(3);

    // an owner write: pending on the client until both the op and the re-derivation arrive
    room.cells.a.set(10);
    await tick();
    expect(checked()).toBe(true);
    expect(check.value()?.total).toBe(12);
    const last = check.value();
    expect(!!last && storeFrontierEquals(last.of, host.frontiers.room())).toBe(
      true,
    );
  });
});
