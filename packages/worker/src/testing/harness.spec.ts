import {
  createStoreContext,
  OP_PROTO_VERSION,
  store,
} from '@mmstack/primitives/core';
import type { WorkerEnvelope, WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { crashablePort, createTestMesh } from './harness';

const appStore = () => store({ count: 0 }, createStoreContext());

describe('crashablePort', () => {
  it('after crash() nothing goes out and nothing comes in', () => {
    const outbound: unknown[] = [];
    const inner: WorkerPortLike = {
      onmessage: null,
      postMessage: (m) => void outbound.push(m),
    };
    const p = crashablePort(inner);
    const inbound: unknown[] = [];
    p.onmessage = (ev) => inbound.push(ev.data);
    let errors = 0;
    p.onerror = () => errors++;

    p.postMessage('a');
    inner.onmessage?.({ data: 'x' });
    p.crash();
    p.postMessage('b');
    inner.onmessage?.({ data: 'y' });

    expect(outbound).toEqual(['a']);
    expect(inbound).toEqual(['x']);
    expect(errors).toBe(1);
  });
});

describe('createTestMesh', () => {
  it('clones on send by default: a non-cloneable payload throws', () => {
    const mesh = createTestMesh({ stores: { app: appStore() } });
    const c = mesh.addClient();
    expect(() =>
      c.send({ type: 'hello', proto: 1, clientId: (() => 'x') as never }),
    ).toThrow();
  });

  it('a delivered message is a copy, not the sent object', async () => {
    const mesh = createTestMesh({ tasks: { echo: (x: unknown) => x } });
    const c = mesh.addClient();
    const input = { deep: { n: 1 } };
    c.send({ type: 'task:run', runId: 1, task: 'echo', input });
    await mesh.settle();
    const ok = c.ofType('task:ok')[0];
    expect(ok.value).toEqual(input);
    expect(ok.value).not.toBe(input);
  });

  it('a fault can target the client side, and only what it matches', async () => {
    const mesh = createTestMesh({ stores: { app: appStore() } });
    const c = mesh.addClient();
    let fired = 0;
    mesh.setFault({
      drop: ({ to, data }) => {
        const hit = to === 'client' && data.type === 'ready';
        if (hit) fired++;
        return hit;
      },
    });
    c.hello();
    c.subscribe('app');
    await mesh.settle();
    expect(fired).toBe(1);
    expect(c.ofType('ready')).toHaveLength(0);
    expect(c.ofType('store:checkpoint')).toHaveLength(1);
  });

  it('one settle() reaches quiescence through a relayed write', async () => {
    const app = appStore();
    const mesh = createTestMesh({ stores: { app } });
    const a = mesh.addClient('a');
    const b = mesh.addClient('b');
    a.subscribe('app');
    b.subscribe('app');
    await mesh.settle();
    a.send({
      type: 'store:sync',
      store: 'app',
      env: {
        proto: OP_PROTO_VERSION,
        instance: '',
        origin: 'client-a',
        writer: 'client-a',
        version: 1,
        hlc: { p: 1, l: 0 },
        policyVersion: 0,
        ops: [
          {
            kind: 'set',
            path: ['count'],
            next: 3,
            prev: 0,
            cites: [],
            epoch: 0,
          },
        ],
      },
    });
    await mesh.settle();
    expect(app().count).toBe(3);
    expect(
      b.ofType('store:sync').some((m) => m.env.origin === 'client-a'),
    ).toBe(true);
  });

  it('settle() throws on a message loop instead of hanging', async () => {
    const mesh = createTestMesh({});
    const c = mesh.addClient();
    const port = c.port;
    const record = port.onmessage;
    port.onmessage = (ev: { data: WorkerEnvelope }) => {
      record?.(ev);
      if (ev.data.type === 'ready') c.hello();
    };
    c.hello();
    await expect(mesh.settle()).rejects.toThrow();
  });
});
