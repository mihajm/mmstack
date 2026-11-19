import { computed, Injector, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

function connect(host: ReturnType<typeof createWorkerHost>) {
  const { port1, port2 } = new MessageChannel();
  host.connect(port2 as unknown as WorkerPortLike);
  const injector = TestBed.inject(Injector);
  return TestBed.runInInjectionContext(() =>
    connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
  );
}

function published() {
  const st = signal<ResourceStatus>('resolved');
  const err = signal<unknown>(undefined);
  const backing = signal({ n: 1 });
  const pub = Object.assign(
    computed(() => backing()),
    { status: st, error: err },
  );
  const host = createWorkerHost({ published: { calc: pub } });
  const worker = connect(host);
  const replica = TestBed.runInInjectionContext(() =>
    workerStore<{ n: number }>(worker, 'calc'),
  );
  return { st, err, backing, replica };
}

describe('workerStore: replicas sharing one connection', () => {
  it('destroying one replica keeps every other replica of the key live', async () => {
    type Model = { count: number };
    const owned = store<Model>({ count: 0 }, createStoreContext());
    const host = createWorkerHost({ stores: { app: owned } });
    const worker = connect(host);
    const a = TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app'),
    );
    const b = TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app'),
    );
    await tick();
    expect(b.value()).toEqual({ count: 0 });

    a.destroy();
    await tick();
    owned.count.set(5);
    await tick();
    expect(b.value()).toEqual({ count: 5 });

    await expect(
      Promise.race([
        b.write((d) => d.count.set(9)).then(() => 'acked'),
        tick()
          .then(() => tick())
          .then(() => 'hung'),
      ]),
    ).resolves.toBe('acked');
    expect(owned().count).toBe(9);
  });
});

describe('workerStore: published status', () => {
  it("'idle' after 'reloading' settles the replica", async () => {
    const { st, replica } = published();
    await tick();
    st.set('reloading');
    await tick();
    expect(replica.status()).toBe('reloading');

    st.set('idle');
    await tick();
    expect(replica.status()).toBe('resolved');
    expect(replica.isLoading()).toBe(false);
  });

  it('an error carries the worker-side error into replica.error()', async () => {
    const { st, err, replica } = published();
    await tick();
    err.set(new RangeError('404'));
    st.set('error');
    await tick();
    expect(replica.status()).toBe('error');
    const e = replica.error() as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RangeError');
    expect(e.message).toBe('404');
  });

  it('an error without a source error still reads as an Error', async () => {
    const { st, replica } = published();
    await tick();
    st.set('error');
    await tick();
    expect(replica.status()).toBe('error');
    expect(replica.error()).toBeInstanceOf(Error);
  });

  it("'loading' after hydration reads as reloading with the value held", async () => {
    const { st, replica } = published();
    await tick();
    st.set('loading');
    await tick();
    expect(replica.status()).toBe('reloading');
    expect(replica.isLoading()).toBe(true);
    expect(replica.value()).toEqual({ n: 1 });
  });

  it('recovery from an error clears the error', async () => {
    const { st, err, replica } = published();
    await tick();
    err.set(new Error('x'));
    st.set('error');
    await tick();
    st.set('reloading');
    await tick();
    expect(replica.error()).toBeUndefined();
    expect(replica.status()).toBe('reloading');

    st.set('error');
    await tick();
    st.set('resolved');
    await tick();
    expect(replica.error()).toBeUndefined();
    expect(replica.status()).toBe('resolved');
  });
});
