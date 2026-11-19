import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import { type PAUSED, workerResource } from './worker-resource';

const slow = (n: number) =>
  new Promise<number>((r) => setTimeout(() => r(n * 10), 5));
const abortNamed = () => {
  throw Object.assign(new Error('timed out'), { name: 'AbortError' });
};

let worker: WorkerRef;

const settle = async () => {
  for (let i = 0; i < 12; i++) {
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r, 1));
  }
};

function make<TInput, TResult>(
  params: () => TInput | undefined | typeof PAUSED | void,
  opts: Omit<Parameters<typeof workerResource<TInput, TResult>>[1], 'worker'>,
) {
  return TestBed.runInInjectionContext(() =>
    workerResource<TInput, TResult>(params, { worker, ...opts }),
  );
}

describe('workerResource: keepPrevious', () => {
  beforeEach(() => {
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ tasks: { slow }, port: port2 });
    worker = connectWorker(() => port1 as unknown as WorkerPortLike, {
      injector: TestBed.inject(Injector),
    });
  });

  it('false: a new run clears the value and reads loading', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'slow', keepPrevious: false });
    await settle();
    expect(res.value()).toBe(10);

    n.set(2);
    TestBed.tick();
    expect(res.status()).toBe('loading');
    expect(res.value()).toBeUndefined();
    expect(res.hasValue()).toBe(false);

    await settle();
    expect(res.value()).toBe(20);
    expect(res.status()).toBe('resolved');
  });

  it('false with a defaultValue: a new run resets to the defaultValue', async () => {
    const n = signal(1);
    const res = make<number, number>(() => n(), {
      task: 'slow',
      keepPrevious: false,
      defaultValue: -1,
    });
    await settle();
    expect(res.value()).toBe(10);

    n.set(2);
    TestBed.tick();
    expect(res.status()).toBe('loading');
    expect(res.value()).toBe(-1);

    await settle();
    expect(res.value()).toBe(20);
  });

  it('true: a new run holds the value and reads reloading', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'slow', keepPrevious: true });
    await settle();
    n.set(2);
    TestBed.tick();
    expect(res.status()).toBe('reloading');
    expect(res.value()).toBe(10);
    expect(res.hasValue()).toBe(true);
  });
});

describe('workerResource: params returning undefined disables', () => {
  beforeEach(() => {
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ tasks: { slow }, port: port2 });
    worker = connectWorker(() => port1 as unknown as WorkerPortLike, {
      injector: TestBed.inject(Injector),
    });
  });

  it.each([true, false])(
    'a resolved resource goes idle and resets to defaultValue (keepPrevious %s)',
    async (keepPrevious) => {
      const n = signal<number | undefined>(1);
      const res = make<number, number>(() => n(), {
        task: 'slow',
        keepPrevious,
        defaultValue: -1,
      });
      await settle();
      expect(res.value()).toBe(10);

      n.set(undefined);
      await settle();
      expect(res.status()).toBe('idle');
      expect(res.value()).toBe(-1);
      expect(res.isLoading()).toBe(false);
    },
  );

  it('aborts the in-flight run, and its result never writes', async () => {
    const spy = vi.spyOn(worker, 'runTask');
    const n = signal<number | undefined>(1);
    const res = make<number, number>(() => n(), { task: 'slow' });
    TestBed.tick();
    expect(res.status()).toBe('loading');

    n.set(undefined);
    TestBed.tick();
    expect(res.status()).toBe('idle');
    expect(spy.mock.calls[0][2]?.signal?.aborted).toBe(true);
    await settle();
    expect(res.value()).toBeUndefined();
    expect(res.status()).toBe('idle');
  });

  it('enabling again with the same input runs again', async () => {
    const spy = vi.spyOn(worker, 'runTask');
    const n = signal<number | undefined>(3);
    const res = make<number, number>(() => n(), { task: 'slow' });
    await settle();
    n.set(undefined);
    await settle();
    n.set(3);
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.value()).toBe(30);
  });

  it('clears an error when disabled', async () => {
    const res = make<number, number>(() => undefined, { task: 'slow' });
    await settle();
    expect(res.error()).toBeUndefined();
    expect(res.status()).toBe('idle');
  });
});

describe('workerResource: aborts it did not start settle the status', () => {
  beforeEach(() => {
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ tasks: { slow, abortNamed }, port: port2 });
    worker = connectWorker(() => port1 as unknown as WorkerPortLike, {
      injector: TestBed.inject(Injector),
    });
  });

  it('worker.destroy() mid-run surfaces as error, not a stuck loading', async () => {
    const res = make(() => 1, { task: 'slow' });
    TestBed.tick();
    expect(res.isLoading()).toBe(true);
    worker.destroy();
    await settle();
    expect(res.isLoading()).toBe(false);
    expect(res.status()).toBe('error');
    expect(res.error()).toHaveProperty('name', 'AbortError');
  });

  it('a task error named AbortError surfaces as error', async () => {
    const res = make(() => 1, { task: 'abortNamed' });
    await settle();
    expect(res.status()).toBe('error');
    expect((res.error() as Error).message).toBe('timed out');
  });
});
