import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createHlcClock } from './hlc';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  opSync,
  syncedFork,
  type OpEnvelope,
  type OpSyncCheckpoint,
  type SyncOp,
} from './op-sync';
import { store } from './store';

const envOf = (
  ops: SyncOp[],
  origin: string,
  p: number,
  version = 1,
): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: 'w-' + origin,
  version,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});

const setOp = (
  path: (string | number)[],
  next: unknown,
  epoch = 0,
  cites: SyncOp['cites'] = [],
): SyncOp => ({ kind: 'set', path, next, cites, epoch });

const epochAt = (e: OpEnvelope | undefined, path: string): number | undefined =>
  e?.ops.find((o) => o.path.join('.') === path)?.epoch;

describe('createConvergingApply — emission epoch floors', () => {
  it('a local bumped write raises the floor at its path; a remote one never does', () => {
    const conv = createConvergingApply();
    const [op] = conv.stamp([{ kind: 'set', path: ['v'], next: 1 }], {
      bump: true,
    });
    expect(op.epoch).toBe(1);
    conv.ingest(envOf([op], 'me', 1), { local: true });
    expect(conv.emissionFloors()).toEqual([{ path: ['v'], epoch: 1 }]);

    const other = createConvergingApply();
    other.ingest(envOf([setOp(['v'], 2, 4)], 'peer', 2));
    other.ingest(
      envOf(
        [{ kind: 'delete', path: ['w'], prev: 1, cites: [], epoch: 0 }],
        'peer',
        3,
      ),
    );
    expect(other.emissionFloors()).toEqual([]);
  });

  it('an unbumped local write at epoch 0 records no floor', () => {
    const conv = createConvergingApply();
    conv.ingest(envOf([setOp(['v'], 1)], 'me', 1), { local: true });
    expect(conv.emissionFloors()).toEqual([]);
  });

  it('a floor survives reset(): the next stamp at that path never emits below it', () => {
    const conv = createConvergingApply();
    const [op] = conv.stamp([{ kind: 'set', path: ['v'], next: 1 }], {
      bump: true,
    });
    conv.ingest(envOf([op], 'me', 1), { local: true });
    conv.reset();
    const [after] = conv.stamp([{ kind: 'set', path: ['v'], next: 2 }]);
    expect(after.epoch).toBe(1);
    expect(after.cites).toEqual([]);
  });

  it('restoreFloors raises floors, never lowers them, and the floors feed stamping', () => {
    const conv = createConvergingApply();
    conv.restoreFloors([{ path: ['v'], epoch: 3 }]);
    conv.restoreFloors([{ path: ['v'], epoch: 2 }]);
    expect(conv.emissionFloors()).toEqual([{ path: ['v'], epoch: 3 }]);
    expect(conv.stamp([{ kind: 'set', path: ['v'], next: 1 }])[0].epoch).toBe(
      3,
    );
    // the restored entries round-trip through emissionFloors into a fresh replica
    const fresh = createConvergingApply();
    fresh.restoreFloors(conv.emissionFloors());
    expect(fresh.emissionFloors()).toEqual([{ path: ['v'], epoch: 3 }]);
  });

  it('clearFloors drops every floor', () => {
    const conv = createConvergingApply();
    conv.restoreFloors([
      { path: ['v'], epoch: 3 },
      { path: ['a', 0], epoch: 1 },
    ]);
    conv.clearFloors();
    expect(conv.emissionFloors()).toEqual([]);
    expect(conv.stamp([{ kind: 'set', path: ['v'], next: 1 }])[0].epoch).toBe(
      0,
    );
  });

  it('load recovers a floor from this replica’s own retained sibling only', () => {
    const conv = createConvergingApply({ origin: 'me' });
    conv.load([
      {
        path: ['v'],
        siblings: [
          {
            kind: 'set',
            value: 1,
            writer: 'w',
            origin: 'me',
            hlc: { p: 1, l: 0 },
            epoch: 2,
          },
        ],
        water: {},
      },
      {
        path: ['u'],
        siblings: [
          {
            kind: 'set',
            value: 1,
            writer: 'w',
            origin: 'peer',
            hlc: { p: 2, l: 0 },
            epoch: 5,
          },
        ],
        water: {},
      },
    ]);
    expect(conv.emissionFloors()).toEqual([{ path: ['v'], epoch: 2 }]);
  });

  it('stamping adopts the highest epoch among the observed siblings, whatever their order', () => {
    const conv = createConvergingApply();
    conv.ingest(envOf([setOp(['v'], 'a', 3)], 'a', 1));
    conv.ingest(envOf([setOp(['v'], 'b', 1)], 'b', 2));
    const [op] = conv.stamp([{ kind: 'set', path: ['v'], next: 'c' }]);
    expect(op.epoch).toBe(3);
    expect(
      conv.stamp([{ kind: 'set', path: ['v'], next: 'c' }], { bump: true })[0]
        .epoch,
    ).toBe(4);
  });
});

describe('opSync — emission floors, restore and adopt', () => {
  function client(opt?: { instance?: string; origin?: string }) {
    return TestBed.runInInjectionContext(() => {
      const s = signal<{ v: string; w?: string }>({ v: 'init' });
      const sync = opSync(s, {
        writer: 'w',
        origin: opt?.origin ?? 'me',
        instance: opt?.instance,
        clock: createHlcClock(() => 100),
      });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      return { s, sync, out };
    });
  }

  it('override raises floors(); a write after a hydrate with no registers keeps the floored epoch', () => {
    const { s, sync, out } = client();
    sync.override(() => s.set({ v: 'bumped' }));
    expect(sync.floors()).toEqual([{ path: ['v'], epoch: 1 }]);

    sync.hydrate({ root: { v: 'peer' }, registers: [], wm: {} });
    s.set({ v: 'after' });
    sync.flush();
    expect(epochAt(out.at(-1), 'v')).toBe(1);
    sync.destroy();
  });

  it('snapshot() carries no floors, and hydrate never reads a peer checkpoint’s floors', () => {
    const { s, sync } = client();
    sync.override(() => s.set({ v: 'bumped' }));
    const snap = sync.snapshot();
    expect(Object.hasOwn(snap, 'floors')).toBe(false);

    const other = client({ origin: 'other' });
    // a checkpoint persisted before the field was removed still loads; its floors are ignored
    const legacy = {
      ...snap,
      floors: [{ path: ['w'], epoch: 7 }],
    } as OpSyncCheckpoint<{ v: string }>;
    other.sync.hydrate(legacy);
    expect(other.sync.floors()).toEqual([]);
    sync.destroy();
    other.sync.destroy();
  });

  it('restore(envs, highWater, floors) restores the floors, and the next write at the path emits at that epoch', () => {
    const { s, sync, out } = client();
    sync.restore([], undefined, [{ path: ['v'], epoch: 3 }]);
    expect(sync.floors()).toEqual([{ path: ['v'], epoch: 3 }]);
    s.set({ v: 'next' });
    sync.flush();
    expect(epochAt(out.at(-1), 'v')).toBe(3);
    sync.destroy();
  });

  it('restoring a bumped tail without floors still raises the floor from the tail itself', () => {
    const { sync } = client();
    sync.restore([envOf([setOp(['v'], 'x', 1)], 'me', 5)], 1);
    expect(sync.floors()).toEqual([{ path: ['v'], epoch: 1 }]);
    sync.destroy();
  });

  it.each([
    ['no generation yet', undefined],
    ['the empty generation', ''],
  ])(
    'adopt from %s keeps restored floors; re-adopting the same generation keeps them; a new one drops them',
    (_d, initial) => {
      const { s, sync, out } = client({ instance: initial });
      sync.restore([], undefined, [{ path: ['v'], epoch: 2 }]);
      s.set({ v: 'before' });
      sync.flush();
      expect(out.at(-1)?.instance).toBe('');

      sync.adopt('g1');
      expect(sync.floors()).toEqual([{ path: ['v'], epoch: 2 }]);
      sync.adopt('g1');
      expect(sync.floors()).toEqual([{ path: ['v'], epoch: 2 }]);
      s.set({ v: 'in-g1' });
      sync.flush();
      expect(out.at(-1)?.instance).toBe('g1');
      expect(epochAt(out.at(-1), 'v')).toBe(2);

      sync.adopt('g2');
      expect(sync.floors()).toEqual([]);
      s.set({ v: 'in-g2' });
      sync.flush();
      expect(out.at(-1)?.instance).toBe('g2');
      sync.destroy();
    },
  );

  it('adopt from a known generation to another drops floors, even with no write in between', () => {
    const { sync } = client({ instance: 'g0' });
    sync.restore([], undefined, [{ path: ['v'], epoch: 2 }]);
    sync.adopt('g1');
    expect(sync.floors()).toEqual([]);
    sync.destroy();
  });

  it('a fork commit over a remote bump raises this replica’s floor at the path', () => {
    TestBed.runInInjectionContext(() => {
      const sa = store<{ v: string }>({ v: 'init' });
      const a = opSync(sa, {
        writer: 'wa',
        origin: 'oa',
        clock: createHlcClock(() => 1),
      });
      a.receive(envOf([setOp(['v'], 'remote', 1)], 'ob', 5));
      const fk = syncedFork(a, sa);
      fk.store.v.set('fork');
      fk.commit();
      expect(a.floors()).toEqual([{ path: ['v'], epoch: 1 }]);
      a.destroy();
    });
  });
});
