import {
  createStoreContext,
  OP_PROTO_VERSION,
  store,
  type OpEnvelope,
} from '@mmstack/primitives';
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

// a hand-built, well-formed client write envelope (the shape a replica's opSync would emit)
let clientClock = 1;
const clientWrite = (
  origin: string,
  ops: OpEnvelope['ops'],
): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  origin,
  writer: origin,
  version: 1,
  hlc: { p: clientClock++, l: 0 },
  policyVersion: 0,
  ops,
});

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

  it('sends a checkpoint on subscribe, then streams op envelopes on host mutation', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();

    const cps = c.ofType('store:checkpoint');
    expect(cps).toHaveLength(1);
    expect(cps[0].checkpoint.root).toEqual(initial());

    app.user.name.set('grace');
    await mesh.settle();

    const syncs = c.ofType('store:sync');
    expect(syncs).toHaveLength(1);
    expect(syncs[0].env.origin).toBe(`${mesh.host.hostId}:app`);
    expect(syncs[0].env.ops).toMatchObject([
      { kind: 'set', path: ['user', 'name'], next: 'grace', prev: 'ada' },
    ]);
  });

  it('never fans out to a client that did not subscribe', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.hello();
    await mesh.settle();
    app.count.set(5);
    await mesh.settle();

    expect(c.ofType('store:sync')).toHaveLength(0);
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

    expect(c.ofType('store:sync')).toHaveLength(0);
  });

  it('applies a routed write envelope, folds it into the owner, and relays it back (the echo = ack)', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();
    const env = clientWrite('client-x', [
      { kind: 'set', path: ['count'], next: 5, prev: 0, cites: [], epoch: 0 },
    ]);
    c.send({ type: 'store:sync', store: 'app', env });
    await mesh.settle();

    expect(app().count).toBe(5); // folded into the owner store
    // the host relayed the client envelope back to the subscriber (its own echo = acknowledgement)
    const echoed = c.ofType('store:sync').filter((m) => m.env.origin === 'client-x');
    expect(echoed.length).toBeGreaterThanOrEqual(1);
    expect(echoed[0].env.ops).toMatchObject([{ kind: 'set', path: ['count'], next: 5 }]);
  });

  it('host.override() wins the merge against a concurrent replica write, even at a lower HLC (epoch authority)', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();

    // the owner makes an AUTHORITATIVE correction (epoch-bumped) to user.name
    mesh.host.override('app', () => app.user.name.set('from-owner'));
    await mesh.settle();
    expect(app().user.name).toBe('from-owner');

    // a CONCURRENT replica write to the same field arrives late (it never observed the override, so
    // it is epoch 0) carrying a FAR-FUTURE hlc — under plain LWW it would win on the later stamp
    const env: OpEnvelope = {
      ...clientWrite('client-z', [
        { kind: 'set', path: ['user', 'name'], next: 'from-replica', prev: 'ada', cites: [], epoch: 0 },
        { kind: 'set', path: ['count'], next: 42, prev: 0, cites: [], epoch: 0 }, // uncontended field
      ]),
      hlc: { p: 9_999_999_999_999, l: 0 },
    };
    c.send({ type: 'store:sync', store: 'app', env });
    await mesh.settle();

    // epoch is outermost in the fold: the owner's epoch-1 correction beats the epoch-0 write despite
    // its later HLC. This is owner authority riding the epoch, with no request/veto shim.
    expect(app().user.name).toBe('from-owner');
    // proof the envelope WAS ingested (not silently dropped): its uncontended field landed
    expect(app().count).toBe(42);
  });

  it('ignores a routed write to an unknown store (writes never route to a non-owned store)', async () => {
    const mesh = createTestMesh({ stores: { app: appStore() } });
    const c = mesh.addClient();

    c.hello();
    await mesh.settle();
    c.send({
      type: 'store:sync',
      store: 'nope',
      env: clientWrite('client-y', [
        { kind: 'set', path: ['x'], next: 1, cites: [], epoch: 0 },
      ]),
    });
    await mesh.settle();

    expect(c.ofType('store:sync')).toHaveLength(0); // ignored, nothing fanned out
  });

  it('fans one mutation to every subscribed client at the same origin+version', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const a = mesh.addClient('a');
    const b = mesh.addClient('b');

    a.subscribe('app');
    b.subscribe('app');
    await mesh.settle();
    app.user.name.set('lin');
    await mesh.settle();

    const ea = a.ofType('store:sync');
    const eb = b.ofType('store:sync');
    expect(ea).toHaveLength(1);
    expect(eb).toHaveLength(1);
    expect(ea[0].env.origin).toBe(eb[0].env.origin);
    expect(ea[0].env.version).toBe(eb[0].env.version);
  });

  it('coalesces multiple mutations in one settle window into one envelope', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();

    c.subscribe('app');
    await mesh.settle();
    app.user.name.set('x');
    app.count.set(3);
    await mesh.settle();

    const syncs = c.ofType('store:sync');
    expect(syncs).toHaveLength(1);
    expect(syncs[0].env.ops).toHaveLength(2);
  });

  it('fault injection: dropping a subscribe means no checkpoint is ever sent', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const c = mesh.addClient();
    mesh.setFault({ drop: ({ to, data }) => to === 'host' && data.type === 'store:subscribe' });

    c.subscribe('app');
    await mesh.settle();
    app.count.set(1);
    await mesh.settle();

    expect(c.ofType('store:checkpoint')).toHaveLength(0);
    expect(c.ofType('store:sync')).toHaveLength(0);
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
  it('emits owned-store envelopes synchronously, before the microtask would', () => {
    const app = appStore();
    const posted: WorkerEnvelope[] = [];
    const port: WorkerPortLike = {
      postMessage: (m) => posted.push(m as WorkerEnvelope),
      onmessage: null,
    };
    const host = createWorkerHost({ stores: { app }, port });

    port.onmessage!({ data: { type: 'store:subscribe', store: 'app', clientId: 'c1' } });
    expect(posted.filter((m) => m.type === 'store:checkpoint')).toHaveLength(1);

    app.count.set(7);
    expect(posted.filter((m) => m.type === 'store:sync')).toHaveLength(0);

    host.flush();
    const syncs = posted.filter((m) => m.type === 'store:sync');
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({
      store: 'app',
      env: { origin: `${host.hostId}:app`, ops: [{ path: ['count'], next: 7 }] },
    });
  });
});

describe('createWorkerHost — real MessageChannel fidelity', () => {
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

    const checkpoint = inbox.find((m) => m.type === 'store:checkpoint');
    const synced = inbox.find((m) => m.type === 'store:sync');
    expect(checkpoint).toMatchObject({ checkpoint: { root: { user: { name: 'ada' }, count: 0 } } });
    expect(synced).toMatchObject({
      env: { origin: `${host.hostId}:app`, ops: [{ path: ['user', 'name'], next: 'grace' }] },
    });
  });
});
