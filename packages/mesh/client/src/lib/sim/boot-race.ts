import { TestBed } from '@angular/core/testing';
import { createRelay } from '@mmstack/mesh-protocol';
import { persist, type AsyncStore } from '@mmstack/primitives';
import { meshSync } from '../mesh-sync';
import { directTransport } from '../transport';
import { prng } from './prng';
import { BASE_TIME, installRng, simStore, type SimDoc } from './model';

const DOC_KEY = 'sim-doc';

/** An in-memory {@link AsyncStore} standing in for disk (IndexedDB). Reads resolve on a microtask. */
function fakeDisk(seed?: SimDoc): AsyncStore & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  if (seed) data.set(DOC_KEY, seed);
  return {
    data,
    get: (k) => Promise.resolve(data.get(k)),
    set: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    del: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export type BootRaceResult = {
  /** The rebooted peer's root after both sources settle. */
  readonly bootRoot: SimDoc;
  /** Another live peer's root — reveals whether stale disk poisoned the whole room. */
  readonly roomRoot: SimDoc;
  /** The stale offline snapshot that was on disk. */
  readonly diskSnapshot: SimDoc;
  /** The room state the relay held at boot. */
  readonly roomState: SimDoc;
};

/**
 * The boot-race capstone (op-substrate-unification "Client-wiring finding"): a rebooting peer
 * attaches BOTH `persist(disk)` and `meshSync(relay)` to one store, with disk holding stale offline
 * edits and the relay holding the room's live (diverged) state. `persist`'s boot-window guard
 * ("explicit write wins over stale disk") turns the outcome into an unarbitrated race decided by
 * attach order + timing — NOT a merge. This runner reproduces both losing orderings deterministically
 * so the assertions LOCK IN the current (broken) behavior as the spec for branching-state.
 */
export async function runBootRace(opt: {
  readonly attachOrder: 'persist-first' | 'mesh-first';
}): Promise<BootRaceResult> {
  TestBed.resetTestingModule(); // isolate from prior scenarios (no leaked timers/injector state)
  const restoreRng = installRng(prng(1));
  const origNow = Date.now;
  Date.now = () => BASE_TIME;
  try {
    const relay = createRelay();

    // a live peer establishes the room's current state
    const room = TestBed.runInInjectionContext(() => {
      const s = simStore();
      const mesh = meshSync(s, { room: 'sim', writer: 'room', transport: directTransport(relay, { writer: 'room' }) });
      return { s, mesh };
    });
    TestBed.tick();
    room.s.labels.x.set('from-room');
    room.s.counters.a.set(7);
    TestBed.tick();
    const roomState = structuredClone(room.s());

    // disk holds a STALE snapshot from an offline session (never reached the relay)
    const diskSnapshot: SimDoc = { counters: { a: 42, b: 0, c: 0 }, labels: { x: 'offline-edit', y: '' } };
    const disk = fakeDisk(diskSnapshot);

    // the reboot: one store, two hydration sources, racing
    const boot = TestBed.runInInjectionContext(() => {
      const s = simStore();
      const attachMesh = () =>
        meshSync(s, { room: 'sim', writer: 'boot', transport: directTransport(relay, { writer: 'boot' }) });
      const attachPersist = () => persist(s, { key: DOC_KEY, store: disk });
      const mesh = opt.attachOrder === 'persist-first' ? (attachPersist(), attachMesh()) : attachMesh();
      if (opt.attachOrder === 'mesh-first') attachPersist();
      return { s, mesh };
    });

    TestBed.tick();
    await flush(); // let persist's async disk read resolve against the boot-window guard
    TestBed.tick();
    await flush();
    TestBed.tick();

    const result: BootRaceResult = {
      bootRoot: structuredClone(boot.s()),
      roomRoot: structuredClone(room.s()),
      diskSnapshot: structuredClone(diskSnapshot),
      roomState,
    };
    boot.mesh.close();
    room.mesh.close();
    return result;
  } finally {
    Date.now = origNow;
    restoreRng();
  }
}
