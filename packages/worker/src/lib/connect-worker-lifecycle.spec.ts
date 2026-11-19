import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createWorkerHost,
  transfer,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

type Sent = { msg: { type?: string; store?: string }; transfer?: unknown };
type Spawned = WorkerPortLike & {
  onerror: ((e?: unknown) => void) | null;
  terminated: boolean;
  sent: Sent[];
  fail(): void;
};

function workers(opts: Parameters<typeof createWorkerHost>[0] = {}) {
  const host = createWorkerHost(opts);
  const spawned: Spawned[] = [];
  const spawn = (): WorkerPortLike => {
    const { port1, port2 } = new MessageChannel();
    host.connect(port2 as unknown as WorkerPortLike);
    const w: Spawned = {
      onmessage: null,
      onerror: null,
      terminated: false,
      sent: [],
      postMessage: (msg, t) => {
        w.sent.push({ msg: msg as Sent['msg'], transfer: t });
        port1.postMessage(msg, t ?? []);
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
const sentOf = (w: Spawned, type: string) =>
  w.sent.filter((s) => s.msg.type === type);

describe('connectWorker on the server', () => {
  it('never spawns, stays disconnected, rejects tasks, and tears down cleanly', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const spawn = vi.fn(() => ({
      postMessage: () => undefined,
      onmessage: null,
    }));
    const ref = connectWorker(spawn, { injector: injector() });
    const replica = workerStore(ref, 'app', { injector: injector() });
    expect(spawn).not.toHaveBeenCalled();
    expect(ref.connected()).toBe(false);
    await expect(ref.runTask('x', null)).rejects.toHaveProperty(
      'name',
      'WorkerCrashedError',
    );
    expect(() => replica.destroy()).not.toThrow();
    expect(() => ref.destroy()).not.toThrow();
  });
});

describe('connectWorker destroy', () => {
  it('disconnects, terminates, rejects pending and later tasks with AbortError', async () => {
    const never = () => new Promise(() => undefined);
    const { spawn, spawned } = workers({ tasks: { never } });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const pending = ref.runTask('never', null);
    ref.destroy();
    expect(ref.connected()).toBe(false);
    expect(spawned[0].terminated).toBe(true);
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await expect(ref.runTask('never', null)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
  });

  it('destroying the owning injector tears down the same way', async () => {
    const never = () => new Promise(() => undefined);
    const { spawn, spawned } = workers({ tasks: { never } });
    const child = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const ref = connectWorker(spawn, { injector: child });
    await tick();
    const pending = ref.runTask('never', null);
    child.destroy();
    expect(spawned[0].terminated).toBe(true);
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('destroy inside the backoff window spawns nothing more', async () => {
    const { spawn, spawned } = workers();
    const ref = connectWorker(spawn, {
      injector: injector(),
      restartDelay: () => 20,
    });
    spawned[0].fail();
    ref.destroy();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(spawned).toHaveLength(1);
    expect(ref.connected()).toBe(false);
  });
});

describe('connectWorker restart backoff', () => {
  afterEach(() => vi.useRealTimers());

  it('waits 1 s, then 2 s, and starts over after a ready', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = workers();
    connectWorker(spawn, { injector: injector() });
    spawned[0].fail();
    await vi.advanceTimersByTimeAsync(999);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);

    spawned[1].fail();
    await vi.advanceTimersByTimeAsync(1999);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(3);
  });

  it('passes the attempt number, starting over after a ready and a restart', async () => {
    const delays: number[] = [];
    const { spawn: base, spawned } = workers();
    // the first two workers fail to start, and so does the one an explicit restart spawns
    const spawn = () => {
      const w = base();
      if (spawned.length <= 2 || spawned.length === 4)
        queueMicrotask(() => spawned.at(-1)?.fail());
      return w;
    };
    const ref = connectWorker(spawn, {
      injector: injector(),
      restartDelay: (n) => {
        delays.push(n);
        return 0;
      },
    });
    await tick();
    expect(spawned).toHaveLength(3);
    expect(ref.connected()).toBe(true);
    ref.restart();
    await tick();
    expect(spawned).toHaveLength(5);
    expect(delays).toEqual([0, 1, 0]);
    ref.destroy();
  });
});

describe('connectWorker runTask', () => {
  const tasks = {
    echo: (x: unknown) => x,
    len: (x: { buf: ArrayBuffer }) => x.buf.byteLength,
    never: (_: unknown, ctx: { signal: AbortSignal }) =>
      new Promise((res) =>
        ctx.signal.addEventListener('abort', () => res('stopped')),
      ),
  };

  it('a pre-aborted signal rejects without posting the run', async () => {
    const { spawn, spawned } = workers({ tasks });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const ac = new AbortController();
    ac.abort();
    await expect(
      ref.runTask('echo', 1, { signal: ac.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(sentOf(spawned[0], 'task:run')).toHaveLength(0);
    ref.destroy();
  });

  it('accepts options with only a transfer list', async () => {
    const { spawn } = workers({ tasks });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const buf = new ArrayBuffer(4);
    await expect(
      ref.runTask('len', { buf }, { transfer: [buf] }),
    ).resolves.toBe(4);
    ref.destroy();
  });

  it('moves a transfer()-marked input', async () => {
    const { spawn, spawned } = workers({ tasks });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const buf = new ArrayBuffer(8);
    const run = ref.runTask('len', transfer({ buf }, [buf]));
    expect(sentOf(spawned[0], 'task:run')[0].transfer).toEqual([buf]);
    expect(buf.byteLength).toBe(0);
    await expect(run).resolves.toBe(8);
    ref.destroy();
  });

  it('an abort reaches the worker handler', async () => {
    let seen: AbortSignal | undefined;
    const { spawn } = workers({
      tasks: {
        watch: (_: unknown, ctx: { signal: AbortSignal }) => {
          seen = ctx.signal;
          return new Promise(() => undefined);
        },
      },
    });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const ac = new AbortController();
    const run = ref.runTask('watch', null, { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(run).rejects.toHaveProperty('name', 'AbortError');
    await tick();
    expect(seen?.aborted).toBe(true);
    ref.destroy();
  });

  it('aborting after the run settled posts nothing', async () => {
    const { spawn, spawned } = workers({ tasks });
    const ref = connectWorker(spawn, { injector: injector() });
    await tick();
    const ac = new AbortController();
    await expect(ref.runTask('echo', 1, { signal: ac.signal })).resolves.toBe(
      1,
    );
    await expect(ref.runTask('nope', 1, { signal: ac.signal })).rejects.toThrow(
      'unknown task',
    );
    ac.abort();
    expect(sentOf(spawned[0], 'task:abort')).toHaveLength(0);
    ref.destroy();
  });

  it.each(['echo', 'nope'])(
    'an abort racing a finished run (%s) rejects with AbortError and nothing throws',
    async (task) => {
      const { spawn } = workers({ tasks });
      const ref = connectWorker(spawn, { injector: injector() });
      await tick();
      const ac = new AbortController();
      const run = ref.runTask(task, 1, { signal: ac.signal });
      ac.abort();
      await expect(run).rejects.toHaveProperty('name', 'AbortError');
      await tick();
      ref.destroy();
    },
  );
});
