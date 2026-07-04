import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerResource } from './worker-resource';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

const add = (input: { a: number; b: number }) => input.a + input.b;
const boom = () => {
  throw new Error('task failed');
};
const never = (_: unknown, ctx: { signal: AbortSignal }) =>
  new Promise((res) => ctx.signal.addEventListener('abort', () => res('aborted'), { once: true }));

function wire(tasks: Record<string, (i: any, c: any) => any> = {}) {
  const { port1, port2 } = new MessageChannel();
  const host = createWorkerHost({ tasks, port: port2 });
  const ref = TestBed.runInInjectionContext(() =>
    connectWorker(() => port1 as unknown as WorkerPortLike),
  );
  return { host, ref };
}

describe('connectWorker ↔ createWorkerHost', () => {
  it('handshakes: connected flips true and the manifest is populated', async () => {
    const { ref } = wire({ add });
    expect(ref.connected()).toBe(false);
    await tick();
    expect(ref.connected()).toBe(true);
    expect(ref.manifest()?.tasks).toEqual(['add']);
    expect(typeof ref.manifest()?.hostId).toBe('string');
    ref.destroy();
  });

  it('runs a named task and resolves with the result', async () => {
    const { ref } = wire({ add });
    await tick();
    await expect(ref.runTask('add', { a: 2, b: 5 })).resolves.toBe(7);
    ref.destroy();
  });

  it('rejects with the deserialized error when a task throws', async () => {
    const { ref } = wire({ boom });
    await tick();
    await expect(ref.runTask('boom', null)).rejects.toThrow('task failed');
    ref.destroy();
  });

  it('rejects an unknown task', async () => {
    const { ref } = wire({ add });
    await tick();
    await expect(ref.runTask('nope', null)).rejects.toThrow('unknown task');
    ref.destroy();
  });

  it('aborts an in-flight task via its signal', async () => {
    const { ref } = wire({ never });
    await tick();
    const ac = new AbortController();
    const run = ref.runTask('never', null, { signal: ac.signal });
    ac.abort();
    await expect(run).rejects.toHaveProperty('name', 'AbortError');
    ref.destroy();
  });

  it('drives workerResource in named-task mode (CSP-safe, no eval)', async () => {
    const { ref } = wire({ add });
    await tick();
    const injector = TestBed.inject(Injector);
    const input = signal({ a: 3, b: 4 });
    const res = TestBed.runInInjectionContext(() =>
      workerResource(() => input(), { worker: ref, task: 'add', injector }),
    );
    for (let i = 0; i < 6; i++) {
      TestBed.tick();
      await new Promise<void>((r) => setTimeout(r, 1));
    }
    expect(res.value()).toBe(7);
    expect(res.status()).toBe('resolved');

    input.set({ a: 10, b: 1 });
    for (let i = 0; i < 6; i++) {
      TestBed.tick();
      await new Promise<void>((r) => setTimeout(r, 1));
    }
    expect(res.value()).toBe(11);
    ref.destroy();
  });
});
