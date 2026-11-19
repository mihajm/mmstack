import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserWorker, CounterState } from '../testing/browser.worker';
import { connectWorker, type WorkerRef } from './connect-worker';
import { workerResource } from './worker-resource';
import { workerStore } from './worker-store';

// built apart from `new Worker(...)` on purpose: the builder rewrites the inline pattern to a
// bundled chunk the browser runner does not serve, while Vite serves this source directly
const workerUrl = new URL('../testing/browser.worker', import.meta.url);
const spawnReal = () => new Worker(workerUrl, { type: 'module' });

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('until: condition never met');
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
}

const refs: WorkerRef<any>[] = [];
const connect = (opt: Parameters<typeof connectWorker>[1] = {}) => {
  const ref = connectWorker<BrowserWorker>(spawnReal, {
    injector: TestBed.inject(Injector),
    ...opt,
  });
  refs.push(ref);
  return ref;
};

afterEach(() => {
  for (const r of refs.splice(0)) r.destroy();
});

describe('@mmstack/worker in a real Web Worker', () => {
  it('handshakes over the worker global scope the host binds by default', async () => {
    const worker = connect();
    await until(() => worker.connected());
    expect(worker.manifest()).toMatchObject({
      stores: ['counter'],
      published: ['stats'],
    });
  });

  it('routes a write to the worker-owned store and reflects it in the replica', async () => {
    const worker = connect();
    const counter = workerStore<CounterState>(worker, 'counter', {
      injector: TestBed.inject(Injector),
    });
    await until(() => counter.hasValue());
    expect(counter.value()?.value).toBe(0);
    for (const step of [1, 2]) {
      await counter.write((d) => {
        d.value.set(d.value() + 1);
        d.history.set([...d.history(), d.value()]);
      });
      expect(counter.value()?.value).toBe(step);
    }
  });

  it('mirrors the worker-side published derivation', async () => {
    const worker = connect();
    const injector = TestBed.inject(Injector);
    const counter = workerStore<CounterState>(worker, 'counter', { injector });
    const stats = workerStore<{ count: number; sum: number }>(worker, 'stats', {
      injector,
    });
    await until(() => counter.hasValue() && stats.hasValue());
    await counter.write((d) => d.history.set([1, 2]));
    await until(() => stats.value()?.count === 2);
    expect(stats.value()).toEqual({ count: 2, sum: 3 });
  });

  it('runs a heavy task off the main thread through workerResource', async () => {
    const worker = connect();
    const n = signal(35);
    const fib = workerResource(() => n(), {
      worker,
      task: 'fib',
      injector: TestBed.inject(Injector),
    });
    await until(() => fib.status() === 'resolved');
    expect(fib.value()).toBe(9227465);
  });

  it('moves a transfer()-marked task result back to the main thread', async () => {
    const worker = connect();
    await until(() => worker.connected());
    const result = (await worker.runTask('bytes', 64)) as { out: ArrayBuffer };
    expect(result.out.byteLength).toBe(64);
    expect(new Uint8Array(result.out)[0]).toBe(7);
  });

  it('a result the worker cannot send rejects instead of hanging', async () => {
    const worker = connect();
    await until(() => worker.connected());
    await expect(
      worker.runTask('unclonable', undefined),
    ).rejects.toBeInstanceOf(Error);
  });

  it('an uncaught error in a running worker is reported and keeps the connection', async () => {
    const errors: unknown[] = [];
    const worker = connect({ onError: (e) => errors.push(e) });
    const counter = workerStore<CounterState>(worker, 'counter', {
      injector: TestBed.inject(Injector),
    });
    await until(() => counter.hasValue());
    await counter.write((d) => d.value.set(41));
    await worker.runTask('throwLater', undefined);
    await until(() => errors.length > 0);
    expect(errors[0]).toBeInstanceOf(ErrorEvent);
    expect(worker.connected()).toBe(true);
    await counter.write((d) => d.value.set(d.value() + 1));
    expect(counter.value()?.value).toBe(42);
  });

  it('restart() terminates the worker and a fresh one comes back and answers', async () => {
    const worker = connect();
    const counter = workerStore<CounterState>(worker, 'counter', {
      injector: TestBed.inject(Injector),
    });
    await until(() => counter.hasValue());
    await counter.write((d) => d.value.set(5));
    const before = worker.manifest()?.hostId;

    worker.restart();
    expect(worker.connected()).toBe(false);
    await until(() => worker.connected() && counter.value()?.value === 0);
    expect(worker.manifest()?.hostId).not.toBe(before);
    await expect(worker.runTask('fib', 10)).resolves.toBe(55);
  });

  it('a worker script that fails to load takes the startup-failure path', async () => {
    let spawns = 0;
    const worker = connectWorker(
      () => {
        spawns++;
        return new Worker('data:text/javascript,throw new Error("boom")', {
          type: 'module',
        });
      },
      {
        injector: TestBed.inject(Injector),
        restart: 'manual',
      },
    );
    refs.push(worker);
    const run = worker.runTask('fib', 1);
    await expect(run).rejects.toHaveProperty('name', 'WorkerCrashedError');
    expect(worker.connected()).toBe(false);
    expect(spawns).toBe(1);
  });
});
