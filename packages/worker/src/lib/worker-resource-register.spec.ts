import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives/core';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { beforeEach, describe, expect, it } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import { workerResource } from './worker-resource';

const slow = (n: number) =>
  new Promise<number>((r) => setTimeout(() => r(n * 10), 5));

let worker: WorkerRef;

const settle = async () => {
  for (let i = 0; i < 12; i++) {
    TestBed.tick();
    await new Promise<void>((r) => setTimeout(r, 1));
  }
};

describe('workerResource: register', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ tasks: { slow }, port: port2 });
    worker = connectWorker(() => port1 as unknown as WorkerPortLike, {
      injector: TestBed.inject(Injector),
    });
  });

  const scope = () =>
    TestBed.runInInjectionContext(() => injectTransitionScope());
  const make = (register?: 'indicator' | 'suspend', injector?: Injector) =>
    TestBed.runInInjectionContext(() =>
      workerResource(() => 1, { worker, task: 'slow', register, injector }),
    );

  it('without register it stays out of the scope', () => {
    const s = scope();
    make();
    TestBed.tick();
    expect(s.pending()).toBe(false);
    expect(s.resources()).toHaveLength(0);
  });

  it("'indicator' drives pending but never suspends", async () => {
    const s = scope();
    make('indicator');
    TestBed.tick();
    expect(s.pending()).toBe(true);
    expect(s.suspended('value')).toBe(false);
    await settle();
    expect(s.pending()).toBe(false);
  });

  it("'suspend' gates first paint until the first value", async () => {
    const s = scope();
    make('suspend');
    TestBed.tick();
    expect(s.suspended('value')).toBe(true);
    await settle();
    expect(s.suspended('value')).toBe(false);
  });

  it('destroy() mid-run leaves the scope and stops the run', async () => {
    const s = scope();
    const res = make('indicator');
    TestBed.tick();
    expect(s.pending()).toBe(true);
    res.destroy();
    expect(s.resources()).not.toContain(res);
    expect(s.pending()).toBe(false);
  });

  it('destroying the owning injector mid-run leaves the scope', async () => {
    const s = scope();
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const res = make('indicator', child);
    TestBed.tick();
    expect(s.pending()).toBe(true);
    child.destroy();
    expect(s.resources()).not.toContain(res);
    expect(s.pending()).toBe(false);
  });
});
