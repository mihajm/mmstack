import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  storeFrontierEquals,
  type WorkerEnvelope,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { droppingPort, manualLink } from '../testing/harness';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';
import { crashWorker } from '../testing/crash';

type Model = { user: { name: string; age: number } };
const initial = (): Model => ({ user: { name: 'ada', age: 36 } });

function linked() {
  const owned = store<Model>(initial(), createStoreContext());
  const host = createWorkerHost({ stores: { app: owned } });
  let link = manualLink();
  const links = [link];
  const spawn = () => {
    if (links.length > 1 || link.up.length || link.down.length) {
      link = manualLink();
      links.push(link);
    }
    host.connect(link.host);
    return link.client;
  };
  const injector = TestBed.inject(Injector);
  const worker = connectWorker(spawn, { injector, restartDelay: () => 0 });
  const replica = workerStore<Model>(worker, 'app', { injector });
  return { owned, host, worker, replica, link: () => link };
}

/** Deliver frames until one of `type` is next in the given direction (it is left queued). */
async function until(
  l: ReturnType<typeof manualLink>,
  dir: 'up' | 'down',
  type: WorkerEnvelope['type'],
) {
  for (let guard = 0; guard < 100; guard++) {
    const q = dir === 'up' ? l.up : l.down;
    if (q[0]?.type === type) return;
    if (l.up.length) l.deliver('up');
    else if (l.down.length) l.deliver('down');
    else throw new Error(`until: no ${type} ${dir}`);
    await l.task();
  }
}

describe('workerStore over a hand-driven link', () => {
  it('reads loading until the first checkpoint lands', async () => {
    const { replica, link } = linked();
    await until(link(), 'down', 'store:checkpoint');
    expect(replica.status()).toBe('loading');
    expect(replica.hasValue()).toBe(false);
    link().deliver('down');
    expect(replica.status()).toBe('resolved');
  });

  it('an echo acknowledges only its own write', async () => {
    const { replica, link } = linked();
    await link().pump();
    let first = false;
    let second = false;
    void replica.write((d) => d.user.name.set('a')).then(() => (first = true));
    void replica.write((d) => d.user.age.set(1)).then(() => (second = true));
    link().deliver('up');
    link().deliver('up');
    await link().task();
    link().deliver('down');
    await link().task();
    expect(first).toBe(true);
    expect(second).toBe(false);
    link().deliver('down');
    await link().task();
    expect(second).toBe(true);
  });

  it('an envelope the replica rejects moves neither the value nor the frontier', async () => {
    const { owned, host, replica, link } = linked();
    await link().pump();
    owned.user.age.set(50);
    host.flush();
    const frame = link().down.shift() as Extract<
      WorkerEnvelope,
      { type: 'store:sync' }
    >;
    const before = replica.applied();
    link().client.onmessage?.({
      data: { ...frame, env: { ...frame.env, proto: 999 } },
    });
    expect(replica.applied()).toEqual(before);
    expect(replica.value()?.user.age).toBe(36);
  });

  it('shows reloading through a re-hydrate after the connection drops', async () => {
    const { worker, replica, link } = linked();
    await link().pump();
    crashWorker(worker);
    await new Promise<void>((r) => setTimeout(r, 1));
    await until(link(), 'down', 'store:checkpoint');
    expect(replica.status()).toBe('reloading');
    expect(replica.value()).toEqual(initial());
    link().deliver('down');
    expect(replica.status()).toBe('resolved');
  });
});

describe('workerStore gap recovery', () => {
  function gapWorld() {
    const owned = store<Model>(initial(), createStoreContext());
    const { port1, port2 } = new MessageChannel();
    const host = createWorkerHost({ stores: { app: owned }, port: port2 });
    let dropped = 0;
    let held = false;
    const delivered: WorkerEnvelope[] = [];
    const sent: WorkerEnvelope[] = [];
    const inner = droppingPort(port1 as never, (msg) => {
      if (msg.type === 'store:sync' && msg.env.version === 2 && !dropped) {
        dropped++;
        return true;
      }
      if (held && msg.type === 'store:checkpoint') return true;
      delivered.push(msg);
      return false;
    });
    const port = {
      ...inner,
      postMessage: (m: unknown, t?: Transferable[]) => {
        sent.push(m as WorkerEnvelope);
        inner.postMessage(m, t);
      },
      set onmessage(cb: ((ev: any) => void) | null) {
        inner.onmessage = cb;
      },
      get onmessage() {
        return inner.onmessage;
      },
    };
    const injector = TestBed.inject(Injector);
    const worker = connectWorker(() => port, { injector });
    const replica = workerStore<Model>(worker, 'app', { injector });
    return {
      owned,
      host,
      replica,
      sent,
      delivered,
      dropped: () => dropped,
      hold: (v: boolean) => (held = v),
    };
  }
  const tick = async () => {
    for (let i = 0; i < 8; i++)
      await new Promise<void>((r) => setTimeout(r, 1));
  };

  it('holds the stale value as reloading until the fresh checkpoint', async () => {
    const w = gapWorld();
    await tick();
    w.owned.user.name.set('A');
    await tick();
    w.hold(true);
    w.owned.user.age.set(50);
    await tick();
    w.owned.user.name.set('B');
    await tick();
    expect(w.dropped()).toBe(1);
    expect(w.replica.status()).toBe('reloading');
    expect(w.replica.value()?.user.age).toBe(36);
  });

  it('after the resync the replica frontier equals the owner frontier', async () => {
    const w = gapWorld();
    await tick();
    w.owned.user.name.set('A');
    await tick();
    w.owned.user.age.set(50);
    await tick();
    w.owned.user.name.set('B');
    await tick();
    await tick();
    expect(w.dropped()).toBe(1);
    const subs = w.sent.filter((m) => m.type === 'store:subscribe');
    expect(subs).toHaveLength(2);
    expect(w.replica.value()).toEqual(w.owned());
    expect(
      storeFrontierEquals(w.host.frontiers['app'](), w.replica.applied()),
    ).toBe(true);
  });
});
