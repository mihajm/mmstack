import { computed } from '@angular/core';
import { createStoreContext, store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  transfer,
  workerStoreContext,
  type WorkerEnvelope,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';

type Model = { count: number };
const appStore = () => store<Model>({ count: 0 }, createStoreContext());

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

/** A synchronous port: posts are recorded (cloned, as a real port would) with their transfer list. */
function syncPort(opts: { clone?: boolean } = {}) {
  const posted: WorkerEnvelope[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  const port: WorkerPortLike = {
    onmessage: null,
    postMessage: (m, t) => {
      posted.push((opts.clone ? structuredClone(m) : m) as WorkerEnvelope);
      transfers.push(t);
    },
  };
  const send = (data: WorkerEnvelope) => port.onmessage?.({ data });
  const ofType = <K extends WorkerEnvelope['type']>(type: K) =>
    posted.filter(
      (m): m is Extract<WorkerEnvelope, { type: K }> => m.type === type,
    );
  return { port, posted, transfers, send, ofType };
}

const subscribe = (store: string, subscriber?: string): WorkerEnvelope => ({
  type: 'store:subscribe',
  store,
  clientId: 'c1',
  ...(subscriber ? { subscriber } : {}),
});
const unsubscribe = (store: string, subscriber?: string): WorkerEnvelope => ({
  type: 'store:unsubscribe',
  store,
  clientId: 'c1',
  ...(subscriber ? { subscriber } : {}),
});

describe('host tasks', () => {
  it('a result that cannot be cloned answers task:error instead of hanging the caller', async () => {
    const p = syncPort({ clone: true });
    createWorkerHost({
      port: p.port,
      tasks: { fn: () => ({ format: () => 'x' }) },
    });
    p.send({ type: 'task:run', runId: 1, task: 'fn', input: null });
    await flushMicrotasks();
    expect(p.ofType('task:ok')).toHaveLength(0);
    const errs = p.ofType('task:error');
    expect(errs).toHaveLength(1);
    expect(errs[0].runId).toBe(1);
  });

  it('moves a transfer()-marked task result instead of cloning it', async () => {
    const p = syncPort();
    const buf = new ArrayBuffer(16);
    createWorkerHost({
      port: p.port,
      tasks: { out: () => transfer({ buf }, [buf]) },
    });
    p.send({ type: 'task:run', runId: 1, task: 'out', input: null });
    await flushMicrotasks();
    const at = p.posted.findIndex((m) => m.type === 'task:ok');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(p.transfers[at]).toEqual([buf]);
  });

  it('a client abort reaches the handler signal', async () => {
    const p = syncPort();
    let seen: AbortSignal | undefined;
    createWorkerHost({
      port: p.port,
      tasks: {
        never: (_: unknown, ctx: { signal: AbortSignal }) => {
          seen = ctx.signal;
          return new Promise(() => undefined);
        },
      },
    });
    p.send({ type: 'task:run', runId: 1, task: 'never', input: null });
    await flushMicrotasks();
    expect(seen?.aborted).toBe(false);
    p.send({ type: 'task:abort', runId: 1 });
    expect(seen?.aborted).toBe(true);
  });

  it('an abort racing a finished run is ignored, and disconnect leaves a finished run alone', async () => {
    const p = syncPort();
    let seen: AbortSignal | undefined;
    const host = createWorkerHost({
      tasks: {
        echo: (x: number, ctx: { signal: AbortSignal }) => {
          seen = ctx.signal;
          return x;
        },
      },
    });
    const disconnect = host.connect(p.port);
    p.send({ type: 'task:run', runId: 1, task: 'echo', input: 3 });
    await flushMicrotasks();
    expect(p.ofType('task:ok')).toEqual([
      { type: 'task:ok', runId: 1, value: 3 },
    ]);
    expect(() => p.send({ type: 'task:abort', runId: 1 })).not.toThrow();
    disconnect();
    expect(seen?.aborted).toBe(false);
  });
});

describe('host subscriptions', () => {
  it('a subscribe for an unknown store is ignored', () => {
    const p = syncPort();
    createWorkerHost({ port: p.port, stores: { app: appStore() } });
    expect(() => p.send(subscribe('nope'))).not.toThrow();
    expect(p.posted).toHaveLength(0);
  });

  it('one subscriber leaving does not cut off another subscriber of the same key on the same connection', () => {
    const app = appStore();
    const p = syncPort();
    const host = createWorkerHost({ port: p.port, stores: { app } });
    p.send(subscribe('app', 'r1'));
    p.send(subscribe('app', 'r2'));
    p.send(unsubscribe('app', 'r1'));
    app.count.set(1);
    host.flush();
    expect(p.ofType('store:sync')).toHaveLength(1);

    p.send(unsubscribe('app', 'r2'));
    app.count.set(2);
    host.flush();
    expect(p.ofType('store:sync')).toHaveLength(1);
  });

  it('a repeated subscribe from one subscriber needs one unsubscribe', () => {
    const app = appStore();
    const p = syncPort();
    const host = createWorkerHost({ port: p.port, stores: { app } });
    p.send(subscribe('app', 'r1'));
    p.send(subscribe('app', 'r1'));
    p.send(unsubscribe('app', 'r1'));
    app.count.set(1);
    host.flush();
    expect(p.ofType('store:sync')).toHaveLength(0);
  });

  it('a subscribe without a subscriber id is keyed by the client id', () => {
    const app = appStore();
    const p = syncPort();
    const host = createWorkerHost({ port: p.port, stores: { app } });
    p.send(subscribe('app'));
    p.send(unsubscribe('app'));
    app.count.set(1);
    host.flush();
    expect(p.ofType('store:sync')).toHaveLength(0);
  });
});

describe('host override', () => {
  it('is a no-op for an unknown or a published store', () => {
    const pub = computed(() => ({ n: 1 }));
    const host = createWorkerHost({
      stores: { app: appStore() },
      published: { pub },
    });
    let called = 0;
    expect(() => host.override('nope', () => called++)).not.toThrow();
    expect(() => host.override('pub', () => called++)).not.toThrow();
    expect(called).toBe(0);
  });
});

describe('host default port', () => {
  it('a host built without a port off-worker does not bind the global scope', () => {
    const g = globalThis as { onmessage?: unknown };
    const before = g.onmessage;
    createWorkerHost({ stores: { app: appStore() } });
    expect(g.onmessage).toBe(before);
  });
});

describe('workerStoreContext', () => {
  it('returns a usable context', () => {
    const ctx = workerStoreContext();
    expect(ctx).toBeDefined();
    const s = store({ a: 1 }, ctx);
    expect(s.a()).toBe(1);
  });
});
