import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it, vi } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import { PAUSED, workerResource } from './worker-resource';

type Item = { id: number; n: number };
const tasks = {
  double: (n: number) => n * 2,
  slow: (n: number) =>
    new Promise<number>((r) => setTimeout(() => r(n * 10), 5)),
  boom: (n: number) => {
    if (n < 0) throw new Error('bad ' + n);
    return n;
  },
  item: (n: number): Item => ({ id: 1, n: Math.sign(n) }),
  maybe: (n: number) => (n > 0 ? { id: n } : undefined),
};

function wire(): WorkerRef {
  const { port1, port2 } = new MessageChannel();
  createWorkerHost({ tasks, port: port2 });
  return connectWorker(() => port1 as unknown as WorkerPortLike, {
    injector: TestBed.inject(Injector),
  });
}

const settle = async () => {
  for (let i = 0; i < 12; i++) {
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r, 1));
  }
};

const inCtx = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);

describe('workerResource: call shapes', () => {
  it('works inside an injection context without an injector option', async () => {
    const worker = wire();
    const res = inCtx(() =>
      workerResource(() => 2, { worker, task: 'double' }),
    );
    await settle();
    expect(res.value()).toBe(4);
  });

  it('works outside an injection context with an explicit injector', async () => {
    const worker = wire();
    const injector = TestBed.inject(Injector);
    const res = workerResource(() => 3, { worker, task: 'double', injector });
    await settle();
    expect(res.value()).toBe(6);
  });

  it('never runs on the server', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const res = inCtx(() =>
      workerResource(() => 2, { worker, task: 'double' }),
    );
    await settle();
    res.reload();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(res.status()).toBe('idle');
  });
});

describe('workerResource: surface', () => {
  it('isLoading and hasValue follow the run', async () => {
    const worker = wire();
    const n = signal(1);
    const res = inCtx(() =>
      workerResource(() => n(), { worker, task: 'slow' }),
    );
    expect(res.status()).toBe('idle');
    expect(res.isLoading()).toBe(false);
    expect(res.hasValue()).toBe(false);
    TestBed.tick();
    expect(res.status()).toBe('loading');
    expect(res.isLoading()).toBe(true);
    expect(res.hasValue()).toBe(false);
    await settle();
    expect(res.isLoading()).toBe(false);
    n.set(2);
    TestBed.tick();
    expect(res.status()).toBe('reloading');
    expect(res.isLoading()).toBe(true);
    await settle();
    expect(res.isLoading()).toBe(false);
  });

  it('a later run clears the previous error, during loading and after resolve', async () => {
    const worker = wire();
    const n = signal(-1);
    const res = inCtx(() =>
      workerResource(() => n(), { worker, task: 'boom' }),
    );
    await settle();
    expect(res.status()).toBe('error');
    n.set(4);
    TestBed.tick();
    expect(res.error()).toBeUndefined();
    await settle();
    expect(res.status()).toBe('resolved');
    expect(res.error()).toBeUndefined();
  });

  it('retries the same input after an error once the pause lifts', async () => {
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const gate = signal<number | typeof PAUSED>(-7);
    const res = inCtx(() =>
      workerResource(() => gate(), { worker, task: 'boom' }),
    );
    await settle();
    expect(res.status()).toBe('error');
    gate.set(PAUSED);
    await settle();
    gate.set(-7);
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reload() does nothing while paused or disabled', async () => {
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const gate = signal<number | typeof PAUSED | undefined>(PAUSED);
    const res = inCtx(() =>
      workerResource(() => gate(), { worker, task: 'double' }),
    );
    await settle();
    res.reload();
    gate.set(undefined);
    await settle();
    res.reload();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(res.status()).toBe('idle');
  });
});

describe('workerResource: equal', () => {
  it('an equal result keeps the held reference and notifies nobody', async () => {
    const worker = wire();
    const n = signal(1);
    const res = inCtx(() =>
      workerResource<number, Item>(() => n(), {
        worker,
        task: 'item',
        equal: (a, b) => a.id === b.id && a.n === b.n,
      }),
    );
    await settle();
    const first = res.value();
    expect(first).toEqual({ id: 1, n: 1 });
    let reads = 0;
    const view = computed(() => {
      reads++;
      return res.value();
    });
    view();
    n.set(2);
    await settle();
    expect(res.value()).toBe(first);
    view();
    expect(reads).toBe(1);
  });

  it('a dereferencing equal is never called with undefined', async () => {
    const worker = wire();
    const n = signal(1);
    const res = inCtx(() =>
      workerResource<number, { id: number } | undefined>(() => n(), {
        worker,
        task: 'maybe',
        equal: (a, b) => a!.id === b!.id,
      }),
    );
    await settle();
    expect(res.value()).toEqual({ id: 1 });
    expect(res.status()).toBe('resolved');
    n.set(-1);
    await settle();
    expect(res.value()).toBeUndefined();
    expect(res.status()).toBe('resolved');
  });
});

describe('workerResource: cancellation reaches the wire', () => {
  it('abort() aborts the task signal', async () => {
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const res = inCtx(() => workerResource(() => 1, { worker, task: 'slow' }));
    TestBed.tick();
    res.abort();
    expect(spy.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });

  it('abort() right after a supersede still cancels the new run', async () => {
    const worker = wire();
    const n = signal(1);
    const res = inCtx(() =>
      workerResource(() => n(), { worker, task: 'slow' }),
    );
    TestBed.tick();
    n.set(9);
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r, 0));
    res.abort();
    expect(res.status()).toBe('local');
    await settle();
    expect(res.value()).not.toBe(90);
    expect(res.status()).toBe('local');
  });

  it('abort() after an error keeps the error status', async () => {
    const worker = wire();
    const res = inCtx(() => workerResource(() => -1, { worker, task: 'boom' }));
    await settle();
    res.abort();
    expect(res.status()).toBe('error');
  });

  it.each([
    ['mid-run', false],
    ['after settle', true],
  ])('destroy() %s stops the resource', async (_, settleFirst) => {
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const n = signal(1);
    const res = inCtx(() =>
      workerResource(() => n(), { worker, task: 'slow' }),
    );
    TestBed.tick();
    if (settleFirst) await settle();
    expect(() => res.destroy()).not.toThrow();
    if (!settleFirst) expect(spy.mock.calls[0][2]?.signal?.aborted).toBe(true);
    n.set(2);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('destroying the owning injector aborts the run', async () => {
    const worker = wire();
    const spy = vi.spyOn(worker, 'runTask');
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    workerResource(() => 1, { worker, task: 'slow', injector: child });
    TestBed.tick();
    child.destroy();
    expect(spy.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });
});
