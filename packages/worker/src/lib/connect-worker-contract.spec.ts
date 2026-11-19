import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it, vi } from 'vitest';
import { connectWorker } from './connect-worker';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

const never = (_: unknown, ctx: { signal: AbortSignal }) =>
  new Promise((res) =>
    ctx.signal.addEventListener('abort', () => res('stopped'), { once: true }),
  );

function wireConnect() {
  const host = createWorkerHost({ tasks: { never } });
  const { port1, port2 } = new MessageChannel();
  const disconnect = host.connect(port2 as unknown as WorkerPortLike);
  const injector = TestBed.inject(Injector);
  const ref = connectWorker(() => port1 as unknown as WorkerPortLike, {
    injector,
  });
  return { host, ref, disconnect };
}

describe('connectWorker: aborts started by the host', () => {
  it('a host-side disconnect rejects the in-flight runTask with an AbortError', async () => {
    const { ref, disconnect } = wireConnect();
    await tick();
    const run = ref.runTask('never', null);
    await tick();
    disconnect();
    await expect(run).rejects.toHaveProperty('name', 'AbortError');
    ref.destroy();
  });

  it('host dispose() rejects the in-flight runTask with an AbortError', async () => {
    const { host, ref } = wireConnect();
    await tick();
    const run = ref.runTask('never', null);
    await tick();
    host.dispose();
    await expect(run).rejects.toHaveProperty('name', 'AbortError');
    ref.destroy();
  });
});

type FakeWorker = WorkerPortLike & {
  onerror: ((e?: unknown) => void) | null;
  onmessageerror: ((e?: unknown) => void) | null;
  terminated: boolean;
  sent: { msg: { type?: string }; transfer?: Transferable[] }[];
  /** The worker script fails to start: nothing more arrives, and `error` fires. */
  fail(): void;
};

/** A Worker-shaped port over a real MessageChannel to a host that serves every spawn. */
function fakeWorkers(tasks: Record<string, (i: any, c: any) => any> = {}) {
  const host = createWorkerHost({ tasks });
  const spawned: FakeWorker[] = [];
  const spawn = (): WorkerPortLike => {
    const { port1, port2 } = new MessageChannel();
    host.connect(port2 as unknown as WorkerPortLike);
    const w: FakeWorker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminated: false,
      sent: [],
      postMessage: (msg, transfer) => {
        w.sent.push({ msg: msg as { type?: string }, transfer });
        port1.postMessage(msg, transfer ?? []);
      },
      terminate: () => {
        w.terminated = true;
        port1.close();
      },
      fail: () => {
        port1.onmessage = null;
        w.onerror?.(new Event('error'));
      },
    };
    port1.onmessage = (ev) => w.onmessage?.(ev);
    spawned.push(w);
    return w;
  };
  return { host, spawn, spawned };
}

const injector = () => TestBed.inject(Injector);

describe('connectWorker: port errors', () => {
  it('an error before ready is a startup failure: rejects pending tasks and respawns', async () => {
    const { spawn, spawned } = fakeWorkers({ never });
    const ref = connectWorker(spawn, {
      injector: injector(),
      restartDelay: () => 0,
    });
    const run = ref.runTask('never', null);
    spawned[0].fail();
    expect(ref.connected()).toBe(false);
    await expect(run).rejects.toHaveProperty('name', 'WorkerCrashedError');
    await expect(ref.runTask('never', null)).rejects.toHaveProperty(
      'name',
      'WorkerCrashedError',
    );
    await tick();
    expect(spawned).toHaveLength(2);
    expect(spawned[0].terminated).toBe(true);
    expect(ref.connected()).toBe(true);
    ref.destroy();
  });

  it('an error after ready goes to onError and keeps the connection', async () => {
    const { spawn, spawned } = fakeWorkers({ add: (x: number) => x + 1 });
    const seen: unknown[] = [];
    const ref = connectWorker(spawn, {
      injector: injector(),
      restartDelay: () => 0,
      onError: (e) => seen.push(e),
    });
    await tick();
    const event = new Event('error');
    spawned[0].onerror?.(event);
    await tick();
    expect(seen).toEqual([event]);
    expect(ref.connected()).toBe(true);
    expect(spawned).toHaveLength(1);
    await expect(ref.runTask('add', 1)).resolves.toBe(2);
    ref.destroy();
  });

  it('an error after ready without onError warns in dev mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { spawn, spawned } = fakeWorkers();
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    spawned[0].onerror?.(new Event('error'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ref.connected()).toBe(true);
    warn.mockRestore();
    ref.destroy();
  });

  it.each([
    ['before', false],
    ['after', true],
  ])(
    'a messageerror %s ready never restarts and is reported',
    async (_, ready) => {
      const { spawn, spawned } = fakeWorkers();
      const seen: unknown[] = [];
      const ref = connectWorker(spawn, {
        injector: injector(),
        restartDelay: () => 0,
        onError: (e) => seen.push(e),
      });
      if (ready) await tick();
      spawned[0].onmessageerror?.('lost');
      await tick();
      expect(seen).toEqual(['lost']);
      expect(spawned).toHaveLength(1);
      expect(ref.connected()).toBe(true);
      ref.destroy();
    },
  );

  it("restart: 'manual' does not respawn and says so", async () => {
    const { spawn, spawned } = fakeWorkers();
    const ref = connectWorker(spawn, {
      injector: injector(),
      restart: 'manual',
      restartDelay: () => 0,
    });
    spawned[0].fail();
    await tick();
    expect(spawned).toHaveLength(1);
    expect(ref.connected()).toBe(false);
    await expect(ref.runTask('x', null)).rejects.toThrow(
      'worker failed to start',
    );
    ref.destroy();
  });
});
