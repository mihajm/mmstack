import { computed, Injector, untracked } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStoreContext, store } from '@mmstack/primitives/core';
import {
  createWorkerHost,
  storeFrontierEquals,
  type StoreFrontier,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';
import { connectWorker } from './connect-worker';
import { workerStore } from './worker-store';

// Frontiers compare only within ONE owner generation. A replacement owner seeded from the VALUE
// (not the registers) starts a fresh per-origin history; the replica must drop the dead owner's
// origins when it hydrates from the new one, or no result of the new owner ever reads as current.

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 1));
};

type Room = { cells: { a: number; b: number } };
type Check = { total: number; of: StoreFrontier };

function makeHost(value: Room) {
  const room = store<Room>(value, createStoreContext());
  const host = createWorkerHost({
    stores: { room },
    published: {
      check: ({ frontiers }) =>
        computed(() => ({
          total: room().cells.a + room().cells.b,
          of: frontiers.room(),
        })),
    },
  });
  return { room, host };
}

describe('frontier generations', () => {
  it('a fresh owner: not current between the old owner’s death and the new checkpoint, current for the new owner’s first result', async () => {
    let current = makeHost({ cells: { a: 1, b: 0 } });
    // a crashable port: connectWorker wires `onerror` to its crash + auto-restart path
    let crash = (): void => undefined;
    const spawn = (): WorkerPortLike => {
      const { port1, port2 } = new MessageChannel();
      current.host.connect(port2 as unknown as WorkerPortLike);
      const port = {
        postMessage: (m: unknown) => port1.postMessage(m),
        set onmessage(fn: ((ev: MessageEvent) => void) | null) {
          port1.onmessage = fn;
        },
        get onmessage() {
          return port1.onmessage;
        },
        onerror: null as (() => void) | null,
        close: () => port1.close(),
      };
      crash = () => port.onerror?.();
      return port;
    };
    const injector = TestBed.inject(Injector);
    const worker = TestBed.runInInjectionContext(() =>
      connectWorker(spawn, {
        injector,
        restart: 'auto',
        restartDelay: () => 0,
      }),
    );
    const doc = TestBed.runInInjectionContext(() =>
      workerStore<Room>(worker, 'room', { injector }),
    );
    const check = TestBed.runInInjectionContext(() =>
      workerStore<Check>(worker, 'check', { injector }),
    );
    const isCurrent = computed(() => {
      const c = check.value();
      return !!c && storeFrontierEquals(c.of, doc.applied());
    });
    await tick();

    // generation A: the replica writes (its own origin R), A folds + echoes it, re-derives
    await doc.write((d) => d.cells.b.set(2));
    await tick();
    const hostA = current.host;
    expect(check.value()?.total).toBe(3);
    expect(check.value()?.of.instance).toBe(hostA.hostId);
    expect(Object.keys(doc.applied().applied)).toHaveLength(1); // R: A only folded the client write
    expect(Object.keys(hostA.frontiers.room().applied)).toEqual(
      Object.keys(doc.applied().applied),
    );
    expect(isCurrent()).toBe(true);

    // A dies; B is seeded from A's VALUE only
    const seed = structuredClone(untracked(current.room));
    hostA.dispose();
    current = makeHost(seed);
    crash();
    // between A's death and B's checkpoint: the held result is A's, nothing is comparable
    expect(check.value()?.of.instance).toBe(hostA.hostId);
    expect(doc.applied().instance).toBe('');
    expect(isCurrent()).toBe(false);

    await tick(); // respawn → ready → subscribe → B's checkpoints
    expect(doc.applied().instance).toBe(current.host.hostId);
    expect(check.value()?.of.instance).toBe(current.host.hostId);
    expect(check.value()?.total).toBe(3);
    expect(isCurrent()).toBe(true);

    // and the new generation keeps working: a write under B goes pending, then current again
    const acked = doc.write((d) => d.cells.a.set(10));
    expect(isCurrent()).toBe(false);
    await acked;
    await tick();
    expect(check.value()?.total).toBe(12);
    expect(isCurrent()).toBe(true);
  });
});
