import { createStoreContext, store } from '@mmstack/primitives';
import {
  createWorkerHost,
  PROTO_VERSION,
  workerStoreContext,
  type WorkerEnvelope,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { createTestMesh } from './testing/harness';

type Model = { user: { name: string }; count: number };
const initial = (): Model => ({ user: { name: 'ada' }, count: 0 });
const appStore = () => store<Model>(initial(), createStoreContext());

/**
 * The bulk of the protocol suite runs on the deterministic harness (controllable fake ports +
 * settle-until-quiescent). A thin real-`MessageChannel` block at the end guards actual async
 * delivery + structured-clone fidelity.
 */
describe('createWorkerHost — handshake + store mirror (deterministic harness)', () => {
  it('answers hello with ready, advertising stores and tasks', async () => {
    const mesh = createTestMesh({ stores: { app: appStore() }, tasks: { echo: (x) => x } });
    const c = mesh.addClient();

    c.hello();
    await mesh.settle();

    const ready = c.ofType('ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      proto: PROTO_VERSION,
      stores: ['app'],
      published: [],
      tasks: ['echo'],
    });
    expect(typeof ready[0].hostId).toBe('string');
  });

  it('sends a snapshot on subscribe, then streams op batches on host mutation', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();

    expect(c.ofType('store:snapshot')).toEqual([
      { type: 'store:snapshot', store: 'app', version: 0, value: initial() },
    ]);

    app.user.name.set('grace');
    await mesh.settle();

    const ops = c.ofType('store:ops');
    expect(ops).toHaveLength(1);
    expect(ops[0].batch).toMatchObject({
      origin: mesh.host.hostId,
      version: 1,
      ops: [{ kind: 'set', path: ['user', 'name'], next: 'grace', prev: 'ada' }],
    });
  });

  it('never fans out to a client that did not subscribe', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.hello();
    await mesh.settle();
    app.count.set(5);
    await mesh.settle();

    expect(c.ofType('store:ops')).toHaveLength(0);
  });

  it('stops fanning out after unsubscribe', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();
    c.send({ type: 'store:unsubscribe', store: 'app', clientId: c.id });
    await mesh.settle();
    app.count.set(9);
    await mesh.settle();

    expect(c.ofType('store:ops')).toHaveLength(0);
  });

  it('fans one mutation to every subscribed client at the same version (single sequencer)', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const a = mesh.addClient('a');
    const b = mesh.addClient('b');

    a.subscribe('app');
    b.subscribe('app');
    await mesh.settle();
    app.user.name.set('lin');
    await mesh.settle();

    expect(a.ofType('store:ops')[0]?.batch.version).toBe(1);
    expect(b.ofType('store:ops')[0]?.batch.version).toBe(1);
    expect(a.ofType('store:ops')).toHaveLength(1);
    expect(b.ofType('store:ops')).toHaveLength(1);
  });

  it('coalesces multiple mutations in one settle window into one batch', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();
    app.user.name.set('x');
    app.count.set(3);
    await mesh.settle();

    // one microtask emission window → one batch carrying both ops
    const ops = c.ofType('store:ops');
    expect(ops).toHaveLength(1);
    expect(ops[0].batch.ops).toHaveLength(2);
  });

  it('fault injection: dropping a subscribe means no snapshot is ever sent', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();
    mesh.setFault({ drop: ({ to, data }) => to === 'host' && data.type === 'store:subscribe' });

    c.subscribe('app');
    await mesh.settle();
    app.count.set(1);
    await mesh.settle();

    expect(c.ofType('store:snapshot')).toHaveLength(0);
    expect(c.ofType('store:ops')).toHaveLength(0);
  });

  it('workerStoreContext returns one shared context per worker (module singleton)', () => {
    expect(workerStoreContext()).toBe(workerStoreContext());
  });

  it('dev-guards a non-cloneable store value with a clear error', () => {
    const bad = store<{ fn: () => void }>({ fn: () => undefined }, createStoreContext());
    const port: WorkerPortLike = { postMessage: () => undefined, onmessage: null };
    createWorkerHost({ stores: { app: bad }, port });
    expect(() =>
      port.onmessage!({ data: { type: 'store:subscribe', store: 'app', clientId: 'c1' } }),
    ).toThrow('cannot be sent across the worker boundary');
  });
});

describe('WorkerHost.flush() — synchronous emission', () => {
  it('emits owned-store batches synchronously, before the microtask would', () => {
    const app = appStore();
    const posted: WorkerEnvelope[] = [];
    // a trivial synchronous stub port makes emission timing directly observable
    const port: WorkerPortLike = {
      postMessage: (m) => posted.push(m as WorkerEnvelope),
      onmessage: null,
    };
    const host = createWorkerHost({ stores: { app }, port });

    port.onmessage!({ data: { type: 'store:subscribe', store: 'app', clientId: 'c1' } });
    expect(posted.filter((m) => m.type === 'store:snapshot')).toHaveLength(1);

    app.count.set(7);
    expect(posted.filter((m) => m.type === 'store:ops')).toHaveLength(0); // microtask still pending

    host.flush();
    const ops = posted.filter((m) => m.type === 'store:ops');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      store: 'app',
      batch: { origin: host.hostId, version: 1, ops: [{ path: ['count'], next: 7 }] },
    });
  });
});

// ── real MessageChannel: async delivery + structured-clone fidelity ──────────
describe('createWorkerHost — real MessageChannel fidelity', () => {
  // a real MessageChannel round-trip can span several event-loop turns; drain a handful
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
  };
  const collect = (port: WorkerPortLike) => {
    const inbox: WorkerEnvelope[] = [];
    port.onmessage = (ev) => inbox.push(ev.data as WorkerEnvelope);
    return inbox;
  };

  it('handshakes and mirrors a mutation over a genuine port pair', async () => {
    const { port1, port2 } = new MessageChannel();
    const app = appStore();
    const host = createWorkerHost({ stores: { app }, port: port2 });
    const inbox = collect(port1);

    port1.postMessage({ type: 'store:subscribe', store: 'app', clientId: 'c1' });
    await tick();
    app.user.name.set('grace');
    await tick();

    const snapshot = inbox.find((m) => m.type === 'store:snapshot');
    const ops = inbox.find((m) => m.type === 'store:ops');
    expect(snapshot).toMatchObject({ value: { user: { name: 'ada' }, count: 0 } });
    expect(ops).toMatchObject({
      batch: { origin: host.hostId, ops: [{ path: ['user', 'name'], next: 'grace' }] },
    });
  });
});
