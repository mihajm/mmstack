import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { compareHlc, createHlcClock } from './hlc';
import type { EmitContext } from './op-log';
import {
  OP_PROTO_VERSION,
  opSync,
  validateEnvelope,
  type OpEnvelope,
  type OpSyncOptions,
  type SyncOp,
} from './op-sync';

type S = { v: string; w?: string };

const remote = (
  ops: SyncOp[],
  opt: { origin?: string; version?: number; p?: number; proto?: number } = {},
): OpEnvelope => ({
  proto: opt.proto ?? OP_PROTO_VERSION,
  instance: 'g',
  origin: opt.origin ?? 'r',
  writer: 'wr',
  version: opt.version ?? 1,
  hlc: { p: opt.p ?? 10, l: 0 },
  policyVersion: 0,
  ops,
});
const setV = (next: unknown, path: (string | number)[] = ['v']): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites: [],
  epoch: 0,
});

function client(opt: Partial<OpSyncOptions> = {}, init: S = { v: 'init' }) {
  return TestBed.runInInjectionContext(() => {
    const s = signal<S>(init);
    const sync = opSync(s, { writer: 'w', origin: 'me', ...opt });
    const out: Array<{ env: OpEnvelope; ctx?: EmitContext }> = [];
    sync.subscribe((env, ctx) => out.push({ env, ctx }));
    return { s, sync, out, envs: () => out.map((o) => o.env) };
  });
}
const valuesAt = (envs: OpEnvelope[], path = 'v') =>
  envs.flatMap((e) =>
    e.ops
      .filter((o) => o.path.join('.') === path && o.kind === 'set')
      .map((o) => (o as { next: unknown }).next),
  );

describe('opSync — construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints a clean, non-empty origin even where crypto has no randomUUID', () => {
    vi.stubGlobal('crypto', {});
    const { sync } = TestBed.runInInjectionContext(() => ({
      sync: opSync(signal<S>({ v: 'x' }), { writer: 'w' }),
    }));
    expect(sync.origin.length).toBeGreaterThan(0);
    expect(
      validateEnvelope({ ...remote([setV(1)]), origin: sync.origin }),
    ).toBeNull();
    sync.destroy();
  });

  it.each([0, 0.5, 1 / 36, 0.123456789])(
    'the fallback origin is never empty, even when Math.random() returns %s',
    (r) => {
      vi.stubGlobal('crypto', {});
      const spy = vi.spyOn(Math, 'random').mockReturnValue(r);
      const { sync } = TestBed.runInInjectionContext(() => ({
        sync: opSync(signal<S>({ v: 'x' }), { writer: 'w' }),
      }));
      spy.mockRestore();
      expect(sync.origin.length).toBeGreaterThan(0);
      expect(
        validateEnvelope({ ...remote([setV(1)]), origin: sync.origin }),
      ).toBeNull();
      sync.destroy();
    },
  );

  it('runs outside an injection context when given an injector', () => {
    const injector = TestBed.inject(Injector);
    const s = signal<S>({ v: 'init' });
    const sync = opSync(s, { writer: 'w', injector });
    const out: OpEnvelope[] = [];
    sync.subscribe((e) => out.push(e));
    s.set({ v: 'x' });
    TestBed.tick();
    expect(valuesAt(out)).toEqual(['x']);
    sync.destroy();
  });

  it('stamps the configured policyVersion, 0 by default', () => {
    const a = client({ policyVersion: 3 });
    const b = client();
    a.s.set({ v: 'x' });
    a.sync.flush();
    b.s.set({ v: 'x' });
    b.sync.flush();
    expect(a.envs()[0].policyVersion).toBe(3);
    expect(b.envs()[0].policyVersion).toBe(0);
    a.sync.destroy();
    b.sync.destroy();
  });

  it('destroy() tears down a custom driver', () => {
    const destroy = vi.fn();
    const s = signal<S>({ v: 'init' });
    const sync = opSync(s, { writer: 'w', driver: () => ({ destroy }) });
    sync.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('opSync — deferred local envelopes drain on their own', () => {
  // a local write still pending when a remote envelope arrives is emitted inside receive(): it is
  // deferred, and must reach subscribers on the next tick without any explicit flush()
  const deferOne = (
    x: ReturnType<typeof client>,
    v: string,
    version: number,
  ) => {
    x.s.set({ ...x.s(), v });
    x.sync.receive(
      remote([setV('r' + version, ['w'])], { version, p: 10 + version }),
    );
  };

  it('delivers the deferred envelope after a tick, twice in a row', () => {
    const x = client();
    deferOne(x, 'one', 1);
    TestBed.tick();
    expect(valuesAt(x.envs())).toEqual(['one']);
    deferOne(x, 'two', 2);
    TestBed.tick();
    expect(valuesAt(x.envs())).toEqual(['one', 'two']);
    x.sync.destroy();
  });

  it('destroy() delivers a deferred envelope instead of dropping it', () => {
    const x = client();
    deferOne(x, 'one', 1);
    x.sync.destroy();
    expect(valuesAt(x.envs())).toEqual(['one']);
  });

  it('after destroy() nothing reaches a subscriber', () => {
    const x = client();
    x.sync.destroy();
    x.sync.seed();
    expect(x.envs()).toEqual([]);
  });
});

describe('opSync.receive — optional hooks and own origin', () => {
  it('ignores an own-origin envelope it did not mint', () => {
    const x = client();
    x.sync.receive(remote([setV('forged')], { origin: 'me', version: 1 }));
    expect(x.s()).toStrictEqual({ v: 'init' });
    x.sync.destroy();
  });

  it('a malformed envelope with no onReject is dropped without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const x = client();
    expect(() =>
      x.sync.receive({ ...remote([setV('bad')]), origin: '' }),
    ).not.toThrow();
    expect(x.s()).toStrictEqual({ v: 'init' });
    warn.mockRestore();
    x.sync.destroy();
  });

  it('reports exactly the missing range on a gap, never on contiguous delivery', () => {
    const gaps: Array<[string, number, number]> = [];
    const x = client({ onGap: (o, e, g) => gaps.push([o, e, g]) });
    for (const v of [1, 2, 4])
      x.sync.receive(remote([setV('v' + v)], { version: v, p: v }));
    expect(gaps).toEqual([['r', 3, 4]]);
    x.sync.destroy();
  });

  it('a gap with no onGap still applies the envelope', () => {
    const x = client();
    x.sync.receive(remote([setV('v1')], { version: 1, p: 1 }));
    expect(() =>
      x.sync.receive(remote([setV('v3')], { version: 3, p: 3 })),
    ).not.toThrow();
    expect(x.s().v).toBe('v3');
    expect(x.sync.watermark()['r']).toBe(3);
    x.sync.destroy();
  });
});

describe('opSync — scoped emission flushes earlier writes first', () => {
  it('emitOps stamps unbumped by default and bumped on request', () => {
    const x = client();
    x.sync.emitOps([{ kind: 'set', path: ['v'], next: 'a' }]);
    x.sync.emitOps([{ kind: 'set', path: ['v'], next: 'b' }], { bump: true });
    expect(x.envs().map((e) => e.ops[0].epoch)).toEqual([0, 1]);
    expect(x.s().v).toBe('b');
    x.sync.destroy();
  });

  it('override does not bump a write that was pending before it', () => {
    const x = client();
    x.s.set({ v: 'plain' });
    x.sync.override(() => x.s.set({ v: 'plain', w: 'bumped' }));
    const ops = x
      .envs()
      .flatMap((e) => e.ops.map((o) => [o.path.join('.'), o.epoch]));
    expect(ops).toEqual([
      ['v', 0],
      ['w', 1],
    ]);
    x.sync.destroy();
  });

  it('snapshot() includes a pending write in its registers and watermark', () => {
    const x = client();
    x.s.set({ v: 'pending' });
    const snap = x.sync.snapshot();
    expect(snap.wm['me']).toBe(1);
    expect(snap.registers.some((r) => r.path.join('.') === 'v')).toBe(true);
    x.sync.destroy();
  });

  it('hydrate() keeps a write that was pending when the checkpoint arrived', () => {
    const peer = client({ origin: 'peer' }, { v: 'init', w: 'p0' });
    peer.s.set({ v: 'init', w: 'peer' });
    const snap = peer.sync.snapshot();
    const x = client();
    x.s.set({ v: 'mine' });
    x.sync.hydrate(snap);
    expect(x.s()).toStrictEqual({ v: 'mine', w: 'peer' });
    expect(valuesAt(x.envs())).toEqual(['mine']);
    peer.sync.destroy();
    x.sync.destroy();
  });
});

describe('opSync.hydrate — the clock', () => {
  it('a local write right after hydrate stamps above every loaded sibling and watermark stamp', () => {
    const x = client({ clock: createHlcClock(() => 1) });
    x.sync.hydrate({
      root: { v: 'peer' },
      registers: [
        {
          path: ['v'],
          siblings: [
            {
              kind: 'set',
              value: 'peer',
              writer: 'wp',
              origin: 'p',
              hlc: { p: 1000, l: 3 },
              epoch: 0,
            },
          ],
          water: { q: { p: 2000, l: 1 } },
        },
      ],
      wm: { p: 1 },
    });
    x.s.set({ v: 'mine' });
    x.sync.flush();
    const stamp = x.envs().at(-1)!.hlc;
    expect(compareHlc(stamp, { p: 1000, l: 3 })).toBeGreaterThan(0);
    expect(compareHlc(stamp, { p: 2000, l: 1 })).toBeGreaterThan(0);
    x.sync.destroy();
  });
});

describe('opSync — read wrappers', () => {
  it('liveAt, liveUnder, appliedFrontier, settle and lastStamp read through to the register', () => {
    const x = client({ clock: createHlcClock(() => 1) });
    expect(x.sync.lastStamp()).toBeUndefined();
    x.sync.receive(remote([setV('r1')], { version: 1, p: 5 }));
    expect(x.sync.liveAt(['v']).map((s) => s.origin)).toEqual(['r']);
    expect(x.sync.liveUnder([]).map((r) => r.path)).toEqual([['v']]);
    expect(x.sync.appliedFrontier()['r']).toEqual({ p: 5, l: 0 });

    x.s.set({ v: 'mine' });
    x.sync.flush();
    const mine = x.envs()[0];
    expect(x.sync.lastStamp()).toEqual(mine.hlc);
    expect(compareHlc(mine.hlc, { p: 5, l: 0 })).toBeGreaterThan(0);

    const regs = () =>
      x.sync.snapshot().registers.find((r) => r.path.join('.') === 'v');
    expect(
      regs()
        ?.siblings.map((s) => s.origin)
        .sort(),
    ).toEqual(['me', 'r']);
    x.sync.settle({ r: { p: 5, l: 0 } });
    expect(regs()?.siblings.map((s) => s.origin)).toEqual(['me']);
    expect(x.s().v).toBe('mine');
    x.sync.destroy();
  });
});
