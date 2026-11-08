import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import { createWorkerHost, type WorkerPortLike } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

type Model = { user: { name: string; age: number } };

/** A task boundary: the microtasks the last delivery queued have run by the time it resolves. */
const task = () => new Promise<void>((r) => setTimeout(r));

type Frame = { readonly type?: string };

/**
 * A worker link whose delivery is in the spec's hands: each side's `postMessage` queues a cloned
 * frame, and only `deliver` moves one, so a frame can be made to land in a chosen task.
 */
function manualLink() {
  const up: Frame[] = [];
  const down: Frame[] = [];
  const client: WorkerPortLike = {
    onmessage: null,
    postMessage: (m) => void up.push(structuredClone(m) as Frame),
  };
  const host: WorkerPortLike = {
    onmessage: null,
    postMessage: (m) => void down.push(structuredClone(m) as Frame),
  };
  const deliver = (dir: 'up' | 'down'): boolean => {
    const data = (dir === 'up' ? up : down).shift();
    if (data === undefined) return false;
    (dir === 'up' ? host : client).onmessage?.({ data });
    return true;
  };
  const pump = async (): Promise<void> => {
    while (up.length > 0 || down.length > 0) {
      if (up.length > 0) {
        deliver('up');
        await task();
      }
      if (down.length > 0) {
        deliver('down');
        await task();
      }
    }
  };
  return { client, host, up, down, deliver, pump };
}

describe('workerStore — a checkpoint landing on an unflushed local write', () => {
  it('ships the write first and replays it over the checkpoint, so owner and replica agree', async () => {
    const owned = store<Model>(
      { user: { name: 'ada', age: 36 } },
      createStoreContext(),
    );
    const host = createWorkerHost({ stores: { app: owned } });
    const link = manualLink();
    host.connect(link.host);
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => link.client, { injector }),
    );
    const replica = TestBed.runInInjectionContext(() =>
      workerStore<Model>(worker, 'app', { injector }),
    );
    await link.pump(); // hello, ready, subscribe, first checkpoint
    expect(replica.value()).toEqual(owned());

    // the owner answers a re-subscribe (what a version gap triggers) with a checkpoint; it waits on
    // the link, every frame ahead of it delivered on its own task
    link.host.onmessage?.({
      data: {
        type: 'store:subscribe',
        store: 'app',
        clientId: worker.clientId,
      },
    });
    while (link.down.length > 0 && link.down[0].type !== 'store:checkpoint') {
      link.deliver('down');
      await task();
    }
    expect(link.down[0]?.type).toBe('store:checkpoint');

    // a local write whose emission is still on the microtask when the checkpoint lands in the SAME
    // task: the hydrate flushes it (so it ships to the owner) and must also replay it over the
    // checkpoint, or the owner applies a write the replica no longer shows
    replica.store.user.name.set('pending');
    link.deliver('down');
    expect(replica.value()?.user.name, 'replica keeps the write').toBe(
      'pending',
    );

    await link.pump();
    expect(owned().user.name, 'the owner applied it').toBe('pending');
    expect(replica.value(), 'owner ≡ replica').toEqual(owned());
    expect(replica.status()).toBe('resolved');
  });
});
