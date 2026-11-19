import { computed, signal, type ResourceStatus } from '@angular/core';
import { createStoreContext, opLog, store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  microtaskOpLogDriver,
  type WorkerEnvelope,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';

type Model = { count: number };
const appStore = () => store<Model>({ count: 0 }, createStoreContext());
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function syncPort() {
  const posted: WorkerEnvelope[] = [];
  const port: WorkerPortLike = {
    onmessage: null,
    postMessage: (m) => void posted.push(m as WorkerEnvelope),
  };
  const send = (data: WorkerEnvelope) => port.onmessage?.({ data });
  const ofType = <K extends WorkerEnvelope['type']>(type: K) =>
    posted.filter(
      (m): m is Extract<WorkerEnvelope, { type: K }> => m.type === type,
    );
  return { port, posted, send, ofType };
}

const sub = (store: string): WorkerEnvelope => ({
  type: 'store:subscribe',
  store,
  clientId: 'c1',
});

function neverTask() {
  const signals: AbortSignal[] = [];
  const never = (_: unknown, ctx: { signal: AbortSignal }) => {
    signals.push(ctx.signal);
    return new Promise((res) =>
      ctx.signal.addEventListener('abort', () => res('stopped'), {
        once: true,
      }),
    );
  };
  return { signals, never };
}

describe('host connect() disconnect handle', () => {
  it('stops fan-out to that port only, aborts its running tasks and answers them task:aborted', async () => {
    const app = appStore();
    const { signals, never } = neverTask();
    const host = createWorkerHost({ stores: { app }, tasks: { never } });
    const a = syncPort();
    const b = syncPort();
    const offA = host.connect(a.port);
    host.connect(b.port);
    a.send(sub('app'));
    b.send(sub('app'));
    a.send({ type: 'task:run', runId: 1, task: 'never', input: null });
    await flushMicrotasks();

    offA();
    expect(a.port.onmessage).toBeNull();
    expect(signals[0].aborted).toBe(true);
    await flushMicrotasks();
    expect(a.ofType('task:aborted')).toEqual([
      { type: 'task:aborted', runId: 1 },
    ]);

    app.count.set(1);
    host.flush();
    expect(a.ofType('store:sync')).toHaveLength(0);
    expect(b.ofType('store:sync')).toHaveLength(1);
  });
});

describe('host dispose()', () => {
  it('stops serving every port: no ready, no task run, no store fold or fan-out', async () => {
    const app = appStore();
    const { signals, never } = neverTask();
    const p = syncPort();
    const host = createWorkerHost({
      port: p.port,
      stores: { app },
      tasks: { never, echo: (x: number) => x },
    });
    p.send(sub('app'));
    p.send({ type: 'task:run', runId: 1, task: 'never', input: null });
    await flushMicrotasks();
    const frontier = host.frontiers['app']();

    host.dispose();
    expect(signals[0].aborted).toBe(true);
    expect(p.port.onmessage).toBeNull();
    await flushMicrotasks();
    expect(p.ofType('task:aborted')).toHaveLength(1);

    const before = p.posted.length;
    p.send({ type: 'hello', proto: 1, clientId: 'c1' });
    p.send({ type: 'task:run', runId: 2, task: 'echo', input: 1 });
    app.count.set(5);
    host.flush();
    await flushMicrotasks();
    expect(p.posted.length).toBe(before);
    expect(host.frontiers['app']()).toEqual(frontier);
  });

  it('releases a published status watch', async () => {
    const st = signal<ResourceStatus>('resolved');
    let evaluations = 0;
    const status = computed(() => {
      evaluations++;
      return st();
    });
    const pub = Object.assign(
      computed(() => ({ n: 1 })),
      { status },
    );
    const host = createWorkerHost({ published: { pub } });
    await flushMicrotasks();
    const settled = evaluations;
    host.dispose();
    st.set('reloading');
    await flushMicrotasks();
    expect(evaluations).toBe(settled);
  });
});

describe('host published status', () => {
  function publishedWith(status: ResourceStatus, error?: unknown) {
    const st = signal<ResourceStatus>('resolved');
    const err = signal<unknown>(undefined);
    const pub = Object.assign(
      computed(() => ({ n: 1 })),
      { status: st, error: err },
    );
    const p = syncPort();
    createWorkerHost({ port: p.port, published: { pub } });
    return {
      p,
      go: async () => {
        err.set(error);
        st.set(status);
        await flushMicrotasks();
      },
      st,
      err,
    };
  }

  it.each(['loading', 'reloading', 'error', 'idle'] as const)(
    "forwards '%s' as is",
    async (status) => {
      const { p, go } = publishedWith(status);
      p.send(sub('pub'));
      await go();
      expect(p.ofType('store:status').at(-1)?.status).toBe(status);
    },
  );

  it("maps 'local' to 'resolved'", async () => {
    const { p, go } = publishedWith('local');
    p.send(sub('pub'));
    await go();
    expect(p.ofType('store:status').at(-1)?.status).toBe('resolved');
  });

  it('an error status carries the source error, on change and on subscribe', async () => {
    const { p, go } = publishedWith('error', new RangeError('404'));
    p.send(sub('pub'));
    await go();
    const live = p.ofType('store:status').at(-1);
    expect(live?.status).toBe('error');
    expect(live?.error).toMatchObject({ name: 'RangeError', message: '404' });

    p.send(sub('pub'));
    const onSubscribe = p.ofType('store:status').at(-1);
    expect(onSubscribe?.error).toMatchObject({ message: '404' });
  });

  it('a non-error status carries no error', async () => {
    const { p, go } = publishedWith('reloading', new Error('stale'));
    p.send(sub('pub'));
    await go();
    expect(p.ofType('store:status').at(-1)?.error).toBeUndefined();
  });
});

describe('microtaskOpLogDriver', () => {
  it('destroy releases the watch on its source', async () => {
    const base = signal({ n: 0 });
    let evaluations = 0;
    const src = computed(() => {
      evaluations++;
      return base();
    });
    const log = opLog(src as never, { driver: microtaskOpLogDriver() });
    await flushMicrotasks();
    log.destroy();
    const settled = evaluations;
    base.set({ n: 1 });
    await flushMicrotasks();
    expect(evaluations).toBe(settled);
  });
});
