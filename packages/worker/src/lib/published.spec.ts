import { computed, Injector, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
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
});
