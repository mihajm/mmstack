import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { compareHlc, createHlcClock } from './hlc';
import type { EmitContext } from './op-log';
import {
  isConflicted,
  OP_PROTO_VERSION,
  opSync,
  preserve,
  syncedFork,
  type Conflicted,
  type OpEnvelope,
  type OpSync,
  type SyncOp,
} from './op-sync';
import { store } from './store';

type S = { v: string; w?: string };
const tail = (
  version: number,
  v: string,
  opt: { origin?: string; p?: number; proto?: number } = {},
): OpEnvelope => ({
  proto: opt.proto ?? OP_PROTO_VERSION,
  instance: 'g',
  origin: opt.origin ?? 'old',
  writer: 'w',
  version,
  hlc: { p: opt.p ?? version, l: 0 },
  policyVersion: 0,
  ops: [{ kind: 'set', path: ['v'], next: v, cites: [], epoch: 0 } as SyncOp],
});

function client(wall = 1) {
  return TestBed.runInInjectionContext(() => {
    const s = signal<S>({ v: 'init' });
    const sync = opSync(s, {
      writer: 'w',
      origin: 'me',
      clock: createHlcClock(() => wall),
    });
    const out: Array<{ env: OpEnvelope; ctx?: EmitContext }> = [];
    sync.subscribe((env, ctx) => out.push({ env, ctx }));
    return { s, sync, out };
  });
}
const writeAndStamp = (x: ReturnType<typeof client>, v: string) => {
  x.s.set({ v });
  x.sync.flush();
  return x.out.at(-1)!.env.hlc;
};

describe('opSync.restore — the boot seam', () => {
  it('an outbox envelope of another protocol is dropped without onReject, the rest still restores', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const x = client();
    expect(() =>
      x.sync.restore([tail(1, 'v4', { proto: 4 }), tail(2, 'current')]),
    ).not.toThrow();
    expect(x.s().v).toBe('current');
    warn.mockRestore();
    x.sync.destroy();
  });

  it('the restored clock high-water orders new writes after it, whatever the wall clock says', () => {
    const x = client(1);
    x.sync.restore([], undefined, undefined, { p: 1000, l: 0 });
    expect(
      compareHlc(writeAndStamp(x, 'next'), { p: 1000, l: 0 }),
    ).toBeGreaterThan(0);
    x.sync.destroy();
  });

  it('new writes are stamped after every restored envelope', () => {
    const x = client(1);
    x.sync.restore([tail(1, 'offline', { p: 1000 })]);
    expect(
      compareHlc(writeAndStamp(x, 'next'), { p: 1000, l: 0 }),
    ).toBeGreaterThan(0);
    x.sync.destroy();
  });

  it('without highWater the watermark tracks the highest restored version, and stays finite', () => {
    const x = client();
    x.sync.restore([tail(1, 'a'), tail(2, 'b'), tail(3, 'c')]);
    expect(x.sync.watermark()).toEqual({ old: 3 });
    x.sync.destroy();
  });

  it('a highWater with no tail adds no origin to the watermark', () => {
    const x = client();
    x.sync.restore([], 7);
    expect(x.sync.watermark()).toEqual({});
    x.sync.destroy();
  });

  it('hands each restored envelope to subscribers with the root it produced', () => {
    const x = client();
    x.sync.restore([tail(1, 'a'), tail(2, 'b')]);
    expect(x.out.map((o) => (o.ctx?.root as S | undefined)?.v)).toEqual([
      'a',
      'b',
    ]);
    x.sync.destroy();
  });
});

describe('syncedFork — frontier capture, commit and discard', () => {
  function rig() {
    return TestBed.runInInjectionContext(() => {
      const sa = store<S>({ v: 'init', w: 'w0' });
      const a = opSync(sa, {
        writer: 'wa',
        origin: 'oa',
        clock: createHlcClock(() => 1),
        policies: [{ path: 'v', merge: preserve }],
      });
      const out: OpEnvelope[] = [];
      a.subscribe((e) => out.push(e));
      return { sa, a, out };
    });
  }
  const remoteAt = (origin: string, p: number, v: string): OpEnvelope => ({
    ...tail(1, v, { origin, p }),
  });

  it('a base write pending when the fork is taken counts as observed: the commit supersedes it', () => {
    const x = rig();
    x.sa.v.set('pending');
    const fk = syncedFork(x.a, x.sa);
    fk.store.v.set('fork');
    fk.commit();
    expect(x.sa().v).toBe('fork');
    x.a.destroy();
  });

  it('a base write pending at commit time keeps its own supersession of what it saw', () => {
    const x = rig();
    const fk = syncedFork(x.a, x.sa);
    x.a.receive(remoteAt('ob', 5, 'mid'));
    x.sa.v.set('mine');
    fk.store.w.set('fork-w');
    fk.commit();
    expect(x.sa()).toStrictEqual({ v: 'mine', w: 'fork-w' });
    x.a.destroy();
  });

  it('two mid-flight origins at one preserve path both survive the commit', () => {
    const x = rig();
    const fk = syncedFork(x.a, x.sa);
    x.a.receive(remoteAt('ox', 5, 'x'));
    x.a.receive(remoteAt('oy', 6, 'y'));
    fk.store.v.set('fork');
    fk.commit();
    const v = x.sa().v as unknown as Conflicted<string>;
    expect(isConflicted(v)).toBe(true);
    expect([...v.siblings].sort()).toEqual(['fork', 'x', 'y']);
    x.a.destroy();
  });

  it('a fork opened before a hydrate never supersedes what the checkpoint brought', () => {
    const peer = TestBed.runInInjectionContext(() => {
      const s = signal<S>({ v: 'init', w: 'w0' });
      return {
        s,
        sync: opSync(s, {
          writer: 'wp',
          origin: 'op',
          clock: createHlcClock(() => 3),
        }) as OpSync<S>,
      };
    });
    peer.s.set({ v: 'peer', w: 'w0' });
    const snap = peer.sync.snapshot();
    const x = rig();
    const fk = syncedFork(x.a, x.sa);
    x.a.hydrate(snap);
    fk.store.v.set('fork');
    fk.commit();
    const v = x.sa().v as unknown as Conflicted<string>;
    expect(isConflicted(v)).toBe(true);
    expect([...v.siblings].sort()).toEqual(['fork', 'peer']);
    peer.sync.destroy();
    x.a.destroy();
  });

  it('discard() drops staged edits: the fork shows the base and a commit emits nothing', () => {
    const x = rig();
    const fk = syncedFork(x.a, x.sa);
    fk.store.v.set('staged');
    fk.discard();
    expect(fk.store()).toStrictEqual(x.sa());
    const before = x.out.length;
    fk.commit();
    x.a.flush();
    expect(x.out.length).toBe(before);
    expect(x.sa().v).toBe('init');
    x.a.destroy();
  });
});
