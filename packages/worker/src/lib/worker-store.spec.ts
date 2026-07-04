import { computed, Injector, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, opLog, store } from '@mmstack/primitives';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

type Model = { user: { name: string; age: number }; tags: string[] };
const initial = (): Model => ({ user: { name: 'ada', age: 36 }, tags: ['x'] });

function wire() {
  const owned = store<Model>(initial(), createStoreContext());
  const { port1, port2 } = new MessageChannel();
  const host = createWorkerHost({ stores: { app: owned }, port: port2 });
  const injector = TestBed.inject(Injector);
  const worker = TestBed.runInInjectionContext(() =>
    connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
  );
  const replica = TestBed.runInInjectionContext(() =>
    workerStore<Model>(worker, 'app', { injector }),
  );
  return { owned, host, worker, replica };
}

describe('workerStore — read-only replica', () => {
  it('hydrates from the snapshot and resolves', async () => {
    const { replica } = wire();
    expect(replica.status()).toBe('loading');
    expect(replica.hasValue()).toBe(false);

    await tick();
    expect(replica.status()).toBe('resolved');
    expect(replica.hasValue()).toBe(true);
    expect(replica.value()).toEqual(initial());
    expect(replica.store.user.name()).toBe('ada');
  });

  it('applies owner mutations to the replica', async () => {
    const { owned, replica } = wire();
    await tick();

    owned.user.name.set('grace');
    await tick();
    expect(replica.store.user.name()).toBe('grace');
    expect(replica.value()).toEqual({
      ...initial(),
      user: { name: 'grace', age: 36 },
    });
  });

  it('applies a multi-op batch as ONE notification wave', async () => {
    const { owned, replica } = wire();
    await tick();

    let recomputes = 0;
    const view = computed(() => {
      recomputes++;
      return `${replica.store.user.name()}:${replica.store.tags().length}`;
    });
    expect(view()).toBe('ada:1');

    owned.user.name.set('lin');
    owned.tags.set(['x', 'y']);
    await tick();

    expect(view()).toBe('lin:2');
    expect(recomputes).toBe(2);
  });

  it('holds the last value and never applies a stale (lower-version) batch', async () => {
    const { owned, replica } = wire();
    await tick();
    owned.user.age.set(40);
    await tick();
    expect(replica.store.user.age()).toBe(40);
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
  return { owned, host, a: mk(), b: mk() };
}

describe('workerStore — write() routed to the owner', () => {
  it('routes a write to the owner and reflects it in the replica once acked', async () => {
    const { owned, replica } = wire();
    await tick();
    await replica.write((draft) => draft.user.name.set('zoe'));
    expect(replica.store.user.name()).toBe('zoe');
    expect(owned.user.name()).toBe('zoe');
  });

  it('resolves immediately for a no-op write', async () => {
    const { replica } = wire();
    await tick();
    await expect(
      replica.write(() => {
        // noop
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a write issued before the replica has hydrated', async () => {
    const { replica } = wire(); // deliberately NOT awaiting hydration
    await expect(
      replica.write((d) => d.user.name.set('x')),
    ).rejects.toThrow('hydrated');
  });

  it('a write from one client converges on every replica (echo-free single-sequencer)', async () => {
    const { a, b } = wire2();
    await tick();
    await a.write((draft) => draft.tags.set(['a', 'b', 'c']));
    await tick();
    expect(a.store.tags()).toEqual(['a', 'b', 'c']);
    expect(b.store.tags()).toEqual(['a', 'b', 'c']);
  });

  it('interleaved writes from two clients converge to identical state', async () => {
    const { owned, a, b } = wire2();
    await tick();
    await Promise.all([
      a.write((draft) => draft.user.name.set('A')),
      b.write((draft) => draft.user.age.set(99)),
    ]);
    await tick();
    const expected = { user: { name: 'A', age: 99 }, tags: ['x'] };
    expect(a.value()).toEqual(expected);
    expect(b.value()).toEqual(expected);
    expect(owned()).toEqual(expected);
  });
});

describe('workerStore — optimistic + composable (op-log endpoint)', () => {
  it('applies a write optimistically — the local value reflects before the owner echoes', async () => {
    const { owned, replica } = wire();
    await tick();

    const p = replica.write((d) => d.user.name.set('grace'));
    expect(replica.store.user.name()).toBe('grace');

    await p;
    expect(replica.store.user.name()).toBe('grace');
    expect(owned.user.name()).toBe('grace');
  });

  it('a no-op recipe resolves without shipping', async () => {
    const { replica } = wire();
    await tick();
    await expect(
      replica.write((d) => d.user.name.set('ada')),
    ).resolves.toBeUndefined();
  });

  it('a composed opLog reader on the worker store sees local writes AND owner changes, no echo storm', async () => {
    const { owned, replica } = wire();
    await tick();

    const emits: unknown[] = [];
    let run = (): void => undefined;
    const reader = opLog(replica.store as unknown as WritableSignal<Model>, {
      driver: (r) => {
        run = r;
        return { destroy: () => undefined };
      },
    });
    reader.subscribe((b) => emits.push(b));
    run();

    await replica.write((d) => d.user.name.set('grace'));
    run();
    const afterLocal = emits.length;
    expect(afterLocal).toBeGreaterThan(0);

    owned.tags.set(['a', 'b']);
    await tick();
    run();
    expect(emits.length).toBeGreaterThan(afterLocal);
    expect(replica.store.tags()).toEqual(['a', 'b']);

    const settled = emits.length;
    run();
    expect(emits.length).toBe(settled);

    reader.destroy();
  });
});
