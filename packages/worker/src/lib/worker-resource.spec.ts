import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectTransitionScope, provideTransitionScope } from '@mmstack/primitives';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import { PAUSED, workerResource } from './worker-resource';

// tasks the worker host exposes
const double = (n: number) => n * 2;
const slow = (n: number) => new Promise<number>((r) => setTimeout(() => r(n * 10), 5));
const boom = (n: number) => {
  throw new Error('bad ' + n);
};

let worker: WorkerRef;

function wireWorker(): WorkerRef {
  const { port1, port2 } = new MessageChannel();
  createWorkerHost({ tasks: { double, slow, boom }, port: port2 });
  const injector = TestBed.inject(Injector);
  return TestBed.runInInjectionContext(() =>
    connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
  );
}

/** Interleave effect flushes with short waits so the run's round-trip (and slow's timer) complete. */
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
    workerResource<TInput, TResult>(params, {
      worker,
      injector: TestBed.inject(Injector),
      ...opts,
    }),
  );
}

describe('workerResource (named-task)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    worker = wireWorker();
  });

  it('resolves a value: idle → loading → resolved', async () => {
    const res = make(() => 21, { task: 'double' });
    expect(res.status()).toBe('idle');

    TestBed.tick();
    expect(res.status()).toBe('loading');

    await settle();
    expect(res.value()).toBe(42);
    expect(res.status()).toBe('resolved');
    expect(res.hasValue()).toBe(true);
  });

  it('re-runs reactively when the input changes', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'double' });
    await settle();
    expect(res.value()).toBe(2);

    n.set(5);
    await settle();
    expect(res.value()).toBe(10);
  });

  it('holds the previous value through a re-run (keepPrevious default)', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'slow' });
    await settle();
    expect(res.value()).toBe(10);

    n.set(2);
    TestBed.tick();
    expect(res.status()).toBe('reloading');
    expect(res.value()).toBe(10); // held while the next run is in flight

    await settle();
    expect(res.value()).toBe(20);
  });

  it('is idle and never runs while params returns undefined', async () => {
    const spy = vi.spyOn(worker, 'runTask');
    const res = make(() => undefined, { task: 'double' });
    await settle();
    expect(res.status()).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('PAUSED holds; a resume to the SAME input does not re-run', async () => {
    const spy = vi.spyOn(worker, 'runTask');
    const gate = signal<number | typeof PAUSED>(3);
    const res = make(() => gate(), { task: 'double' });
    await settle();
    expect(res.value()).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);

    gate.set(PAUSED);
    await settle();
    gate.set(3); // same input as before the pause
    await settle();
    expect(spy).toHaveBeenCalledTimes(1); // no re-run
  });

  it('surfaces a thrown task error as status error', async () => {
    const res = make(() => 7, { task: 'boom' });
    await settle();
    expect(res.status()).toBe('error');
    expect((res.error() as Error).message).toBe('bad 7');
    expect(res.value()).toBeUndefined();
  });

  it('abort() keeps the value and sets status local', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'slow' });
    await settle();
    expect(res.value()).toBe(10);

    n.set(2);
    TestBed.tick(); // in flight (reloading)
    res.abort();
    expect(res.status()).toBe('local');
    await settle();
    expect(res.value()).toBe(10); // aborted run's result discarded
  });

  it('abort() after the run settled is a no-op (a scope abort must not disturb a resolved value)', async () => {
    const res = make(() => 3, { task: 'double' });
    await settle();
    expect(res.status()).toBe('resolved');

    res.abort(); // nothing in flight
    expect(res.status()).toBe('resolved'); // NOT flipped to 'local'
    expect(res.value()).toBe(6);
  });

  it('reload() forces a re-run with the current input', async () => {
    const spy = vi.spyOn(worker, 'runTask');
    const res = make(() => 4, { task: 'double' });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);

    res.reload();
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.value()).toBe(8);
  });

  it('latest-wins: a superseding input discards the stale run', async () => {
    const n = signal(1);
    const res = make(() => n(), { task: 'slow' });
    TestBed.tick(); // dispatch run for 1
    n.set(9);
    await settle(); // supersede → run for 9 wins
    expect(res.value()).toBe(90); // 9*10, not 1*10
  });

  it("register: 'indicator' drives the transition scope pending flag", async () => {
    const scope = TestBed.runInInjectionContext(() => injectTransitionScope());
    const res = make(() => 5, { task: 'slow', register: 'indicator' });
    TestBed.tick();
    expect(scope.pending()).toBe(true); // in flight

    await settle();
    expect(scope.pending()).toBe(false);
    expect(res.value()).toBe(50);
  });
});
