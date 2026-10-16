import { computed, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  applyOps,
  compareHlc,
  createStoreContext,
  store,
  type OpEnvelope,
} from '@mmstack/primitives/core';
import {
  createWorkerHost,
  storeFrontierEquals,
  type StoreFrontier,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import type { WorkerEnvelope } from '@mmstack/worker/protocol';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

// "Same step": a computed reading a value and its frontier never sees the value carry an op the
// frontier does not, nor the frontier claim an op the value does not show. Probed synchronously right
// after each message handler returns (no microtask in between).

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

type Doc = { cells: { a: number } };

/** A port whose message handler is followed, in the same task, by `after(msg)`. */
function probed(
  port: MessagePort,
  after: (msg: WorkerEnvelope) => void,
): WorkerPortLike {
  let handler: ((ev: MessageEvent) => void) | null = null;
  return {
    postMessage: (m: unknown) => port.postMessage(m),
    get onmessage() {
      return handler;
    },
    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
      handler = fn;
      port.onmessage = fn
        ? (ev) => {
            fn(ev);
            after(ev.data as WorkerEnvelope);
          }
        : null;
    },
    close: () => port.close(),
  };
}

/** Writes carry strictly increasing values, so "value shows env" ⇔ "value ≥ env's value". */
const consistent = (
  envs: readonly { env: OpEnvelope; value: number }[],
  shown: number,
  frontier: StoreFrontier,
): string | null => {
  const f = frontier.applied;
  for (const { env, value } of envs) {
    const inValue = shown >= value;
    const inFrontier =
      !!f[env.origin] && compareHlc(f[env.origin], env.hlc) >= 0;
    if (inValue !== inFrontier)
      return `value ${shown} vs op carrying ${value}: inValue=${inValue} inFrontier=${inFrontier}`;
  }
  return null;
};

describe('frontier same step', () => {
  it('replica: computed([value, applied]) is consistent right after every received envelope', async () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const { port1, port2 } = new MessageChannel();
    const host = createWorkerHost({ stores: { room: owned }, port: port2 });
    const envs: { env: OpEnvelope; value: number }[] = [];
    const problems: string[] = [];
    let probes = 0;
    let pair: () => { v: number; f: StoreFrontier } = () => ({
      v: 0,
      f: { instance: '', applied: {} },
    });
    const port = probed(port1, (msg) => {
      if (msg.type !== 'store:sync') return;
      envs.push({
        env: msg.env,
        value: (msg.env.ops[0] as { next: number }).next,
      });
      const { v, f } = pair();
      probes++;
      const bad = consistent(envs, v, f);
      if (bad) problems.push(bad);
    });
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port, { injector }),
    );
    const ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(worker, 'room', { injector }),
    );
    const probe = computed(() => ({
      v: ref.value()?.cells.a ?? 0,
      f: ref.applied(),
    }));
    pair = probe;
    await tick();
    for (let k = 1; k <= 8; k++) {
      owned.cells.a.set(k);
      host.flush();
      probe(); // keep the computed live between messages
    }
    await tick();
    expect(probes).toBe(8);
    expect(problems).toEqual([]);
    expect(ref.value()?.cells.a).toBe(8);
  });

  it('replica: nothing is folded before the first checkpoint (the checkpoint behind it covers it)', async () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const { port1, port2 } = new MessageChannel();
    const host = createWorkerHost({ stores: { room: owned } });
    // host side: an owner write lands, unstamped, right before the subscribe is handled, so the host
    // posts that envelope BEFORE the checkpoint
    let hostHandler: ((ev: MessageEvent) => void) | null = null;
    port2.onmessage = (ev) => {
      if ((ev.data as WorkerEnvelope).type === 'store:subscribe')
        owned.cells.a.set(5);
      hostHandler?.(ev);
    };
    host.connect({
      postMessage: (m: unknown) => port2.postMessage(m),
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        hostHandler = fn;
      },
      get onmessage() {
        return hostHandler;
      },
    });
    const seen: { type: string; value: unknown; instance: string }[] = [];
    let ref: { value: () => unknown; applied: () => StoreFrontier } | null =
      null;
    const port = probed(port1, (msg) => {
      if (msg.type === 'store:sync' || msg.type === 'store:checkpoint')
        seen.push({
          type: msg.type,
          value: structuredClone(ref?.value()),
          instance: ref?.applied().instance ?? '',
        });
    });
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port, { injector }),
    );
    ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(worker, 'room', { injector }),
    );
    await tick();
    expect(seen.map((x) => x.type)).toEqual(['store:sync', 'store:checkpoint']);
    expect(seen[0].value).toBeUndefined(); // not folded onto the default value
    expect(seen[0].instance).toBe('');
    expect(seen[1].value).toEqual({ cells: { a: 5 } });
    expect(seen[1].instance).toBe(host.hostId);
  });

  it('replica: an own write() is in applied the moment write() returns', async () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ stores: { room: owned }, port: port2 });
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
    );
    const ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(worker, 'room', { injector }),
    );
    await tick();
    const before = ref.applied();
    const acked = ref.write((d) => d.cells.a.set(1));
    expect(ref.value()?.cells.a).toBe(1);
    expect(storeFrontierEquals(before, ref.applied())).toBe(false); // own origin advanced, same step
    await acked;
  });

  it('replica (characterisation): a direct store write is counted when stamped, at the next microtask', async () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const { port1, port2 } = new MessageChannel();
    createWorkerHost({ stores: { room: owned }, port: port2 });
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
    );
    const ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(worker, 'room', { injector }),
    );
    await tick();
    const before = ref.applied();
    ref.store.cells.a.set(9); // bypasses write(): optimistic now, stamped by the replica's driver
    expect(ref.value()?.cells.a).toBe(9);
    expect(ref.applied()).toBe(before); // the unstamped window: route writes through write()
    await Promise.resolve();
    await Promise.resolve();
    expect(storeFrontierEquals(before, ref.applied())).toBe(false);
  });

  it('host: computed([store, frontier]) is consistent right after every routed client write', async () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const { port1, port2 } = new MessageChannel();
    const host = createWorkerHost({ stores: { room: owned } });
    const probe = computed(() => ({
      v: owned().cells.a,
      f: host.frontiers.room(),
    }));
    const envs: { env: OpEnvelope; value: number }[] = [];
    const problems: string[] = [];
    let probes = 0;
    host.connect(
      probed(port2, (msg) => {
        if (msg.type !== 'store:sync') return;
        envs.push({
          env: msg.env,
          value: (msg.env.ops[0] as { next: number }).next,
        });
        const { v, f } = probe();
        probes++;
        const bad = consistent(envs, v, f);
        if (bad) problems.push(bad);
      }),
    );
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => port1 as unknown as WorkerPortLike, { injector }),
    );
    const ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(worker, 'room', { injector }),
    );
    await tick();
    probe();
    const writes: Promise<void>[] = [];
    for (let k = 1; k <= 8; k++)
      writes.push(ref.write((d) => d.cells.a.set(k)));
    await Promise.all(writes);
    expect(probes).toBe(8);
    expect(problems).toEqual([]);
    expect(owned().cells.a).toBe(8);
  });

  it('host: a published derivation never ships a value ahead of the frontier it carries', () => {
    const owned = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const host = createWorkerHost({
      stores: { room: owned },
      published: {
        view: ({ frontiers }) =>
          computed(() => ({ a: owned().cells.a, of: frontiers.room() })),
      },
    });
    const posted: WorkerEnvelope[] = [];
    const side = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => posted.push(m as WorkerEnvelope),
    };
    host.connect(side);
    owned.cells.a.set(5); // an owner write, NOT yet stamped
    side.onmessage?.({
      data: { type: 'store:subscribe', store: 'view', clientId: 'c' },
    });
    const cp = posted.find((m) => m.type === 'store:checkpoint');
    const root = (
      cp as { checkpoint: { root: { a: number; of: StoreFrontier } } }
    ).checkpoint.root;
    expect(root.a).toBe(5);
    expect(storeFrontierEquals(root.of, host.frontiers.room())).toBe(true);
    expect(Object.keys(root.of.applied)).toHaveLength(1); // the owner's own stamp for a = 5
  });

  it('host: a published emission describes exactly the owned-store state shipped before it (microtask path)', async () => {
    const meta = store({ x: 0 }, createStoreContext());
    const room = store<Doc>({ cells: { a: 0 } }, createStoreContext());
    const host = createWorkerHost({
      stores: { meta, room },
      published: {
        view: ({ frontiers }) =>
          computed(() => ({
            m: meta().x,
            a: room().cells.a,
            of: frontiers.room(),
          })),
      },
    });
    const posted: WorkerEnvelope[] = [];
    const side = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => posted.push(m as WorkerEnvelope),
    };
    host.connect(side);
    await tick(); // first watch runs: every subtree observes its source
    for (const store of ['room', 'view'])
      side.onmessage?.({
        data: { type: 'store:subscribe', store, clientId: 'c' },
      });

    // meta first: the view's watch is scheduled BEFORE room's, so it runs first in the microtask queue
    meta.x.set(1);
    room.cells.a.set(7);
    await tick();

    let roomRoot: unknown;
    let roomFrontier: Record<string, OpEnvelope['hlc']> = {};
    let viewRoot: { a: number; of: StoreFrontier } | undefined;
    let viewEmissions = 0;
    for (const m of posted) {
      if (m.type === 'store:checkpoint' && m.store === 'room')
        roomRoot = m.checkpoint.root;
      if (m.type === 'store:checkpoint' && m.store === 'view')
        viewRoot = m.checkpoint.root as typeof viewRoot;
      if (m.type !== 'store:sync') continue;
      if (m.store === 'room') {
        roomRoot = applyOps(roomRoot, m.env);
        roomFrontier = { ...roomFrontier, [m.env.origin]: m.env.hlc };
      } else {
        viewRoot = applyOps(viewRoot, m.env);
        viewEmissions++;
        expect(viewRoot?.a).toBe((roomRoot as Doc).cells.a);
        expect(viewRoot?.of.instance).toBe(host.hostId);
        expect(viewRoot?.of.applied).toEqual(roomFrontier);
      }
    }
    expect(viewEmissions).toBeGreaterThan(0);
    expect(viewRoot?.a).toBe(7);
  });
});
