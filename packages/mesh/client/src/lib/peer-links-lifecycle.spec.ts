/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  type ClientMsg,
  type IceServer,
  type Relay,
  type RelayOptions,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meshSync } from './mesh-sync';
import {
  peerLinks,
  type DataChannelLike,
  type PeerConnector,
  type PeerLinks,
  type PeerLinksOptions,
} from './peer-links';
import { prng, type Prng } from './sim/prng';
import { pairHub } from './testing/pair-hub';
import { directTransport, type MeshTransport } from './transport';

// The real `peerLinks` over a real relay and the pair hub, with fake timers. Link state is read
// only from the surface: `members()` (listed), `peers()` (open), `stalled()`, and the hub's
// count of live connectors per pair (a peer exists). With these, for a listed origin:
// open = in peers; linking = one live connector, not in peers; waiting = no connector.

const ROOM = 'recovery';
const ORIGINS = ['a', 'b', 'c'] as const;

type Hub = ReturnType<typeof pairHub>;

function room(
  opt: {
    relay?: RelayOptions;
    random?: () => number;
    links?: Partial<PeerLinksOptions>;
  } = {},
) {
  const relay: Relay = createRelay(opt.relay);
  const hub: Hub = pairHub();
  const nodes = new Map<string, PeerLinks>();
  const transports = new Map<string, MeshTransport>();
  const sent = new Map<string, ClientMsg[]>();
  const join = (origin: string, extra: Partial<PeerLinksOptions> = {}) => {
    const links = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: ROOM,
        origin,
        signaling: () => {
          const t = directTransport(relay, { writer: origin })();
          transports.set(origin, t);
          return {
            ...t,
            send: (msg: ClientMsg) => {
              if (!sent.has(origin)) sent.set(origin, []);
              sent.get(origin)!.push(msg);
              t.send(msg);
            },
          };
        },
        connector: hub.connectorFor(origin),
        ...(opt.random ? { random: opt.random } : {}),
        ...opt.links,
        ...extra,
      }),
    );
    nodes.set(origin, links);
    return links;
  };
  const leave = (origin: string) => {
    nodes.get(origin)?.close();
    nodes.delete(origin);
  };
  /** The relay connection drops; the links reconnect after their own delay. */
  const drop = (origin: string) => transports.get(origin)?.close();
  const close = () => {
    for (const origin of [...nodes.keys()]) leave(origin);
  };
  return { relay, hub, nodes, transports, sent, join, leave, drop, close };
}

type Room = ReturnType<typeof room>;

/** I1 and I2 read from the surface; throws naming the broken rule. */
const seen = { open: 0, linking: 0, waiting: 0, stalledLinking: 0 };

function checkSurface(w: Room): void {
  for (const [x, links] of w.nodes) {
    const listed = new Set(links.members());
    const open = new Set(links.peers());
    const stalled = new Set(links.stalled());
    for (const o of ORIGINS) {
      if (o === x) continue;
      const live = w.hub.live(x, o);
      if (listed.has(o)) {
        if (open.has(o)) seen.open++;
        else if (live === 1) {
          seen.linking++;
          if (stalled.has(o)) seen.stalledLinking++;
        } else if (live === 0) seen.waiting++;
        if (live > 1) throw new Error(`I1: ${x} holds ${live} links to ${o}`);
        if (open.has(o) && live !== 1)
          throw new Error(`I1: ${x} reports ${o} open without a link`);
        if (open.has(o) && stalled.has(o))
          throw new Error(`I1/D6: ${x} reports ${o} open and stalled`);
        if (live === 0 && !stalled.has(o))
          throw new Error(
            `I1: ${x} holds no link to ${o} yet does not report it stalled`,
          );
      } else if (live || open.has(o) || stalled.has(o)) {
        throw new Error(`I2: ${x} keeps state for unlisted ${o}`);
      }
    }
  }
}

/** L1: with the hub healthy and every timer drained, every member pair is open. */
function checkSettled(w: Room): void {
  vi.runAllTimers();
  const present = [...w.nodes.keys()];
  for (const [x, links] of w.nodes) {
    const others = present.filter((o) => o !== x).sort();
    if ([...links.members()].sort().join() !== others.join())
      throw new Error(
        `L1: ${x} lists ${links.members()} but ${others} are present`,
      );
    if ([...links.peers()].sort().join() !== others.join())
      throw new Error(`L1: ${x} has open ${links.peers()} of ${others}`);
    if (links.stalled().length)
      throw new Error(`L1: ${x} still reports ${links.stalled()} stalled`);
    for (const o of others)
      if (w.hub.live(x, o) !== 1)
        throw new Error(`L1: ${x} holds ${w.hub.live(x, o)} links to ${o}`);
  }
}

type Ev =
  | { t: 'join'; o: string }
  | { t: 'leave'; o: string }
  | { t: 'fail'; x: string; y: string; side: 'local' | 'remote' | 'both' }
  | { t: 'refuse'; x: string; y: string; n: number }
  | { t: 'drop'; o: string }
  | { t: 'wait'; ms: number };

function nextEv(r: Prng, w: Room): Ev {
  const o = r.pick(ORIGINS);
  const y = r.pick(ORIGINS.filter((p) => p !== o));
  const roll = r.int(100);
  if (roll < 10) return w.nodes.has(o) ? { t: 'leave', o } : { t: 'join', o };
  if (roll < 18 && !w.nodes.has(o)) return { t: 'join', o };
  if (roll < 38)
    return {
      t: 'fail',
      x: o,
      y,
      side: r.pick(['local', 'remote', 'both'] as const),
    };
  if (roll < 48) return { t: 'refuse', x: o, y, n: 1 + r.int(3) };
  if (roll < 55) return { t: 'drop', o };
  return { t: 'wait', ms: r.int(20_000) };
}

function applyEv(w: Room, e: Ev): void {
  switch (e.t) {
    case 'join':
      if (!w.nodes.has(e.o)) w.join(e.o);
      return;
    case 'leave':
      return w.leave(e.o);
    case 'fail':
      return w.hub.fail(e.x, e.y, e.side);
    case 'refuse':
      return w.hub.refuse(e.x, e.y, e.n);
    case 'drop':
      return w.drop(e.o);
    case 'wait':
      vi.advanceTimersByTime(e.ms);
      return;
  }
}

const SEEDS = 200;
const STEPS = 60;

/** Runs one seed through the generator, checking the surface after every step. */
function runSeed(seed: number): void {
  const r = prng(seed);
  const w = room({ random: r.float });
  try {
    for (const o of ORIGINS) w.join(o);
    for (let i = 0; i < STEPS; i++) {
      const e = nextEv(r, w);
      applyEv(w, e);
      try {
        checkSurface(w);
      } catch (err) {
        throw new Error(
          `seed ${seed} step ${i} ${JSON.stringify(e)}: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
    for (const x of ORIGINS)
      for (const y of ORIGINS) if (x !== y) w.hub.refuse(x, y, 0);
    try {
      checkSettled(w);
    } catch (err) {
      throw new Error(
        `seed ${seed} after settling: ${(err as Error).message}`,
        { cause: err },
      );
    }
  } finally {
    w.close();
  }
}

describe('peerLinks recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it(`I1, I2 after every step and L1 after settling, across ${SEEDS} seeds x ${STEPS} steps`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed);
    // the surface went through every state, including a rebuild still linking after a loss
    expect(seen.open).toBeGreaterThan(0);
    expect(seen.linking).toBeGreaterThan(0);
    expect(seen.waiting).toBeGreaterThan(0);
    expect(seen.stalledLinking).toBeGreaterThan(0);
  });

  it('L2: a pair refused four times opens on the fifth build and is stalled until then', () => {
    const w = room({ random: prng(3).float });
    w.hub.refuse('a', 'b', 4);
    const a = w.join('a');
    const b = w.join('b');
    expect(a.stalled()).toEqual([]); // a first attempt is not stalled
    vi.advanceTimersByTime(15_000);
    expect(a.stalled()).toEqual(['b']);
    expect(b.stalled()).toEqual(['a']);
    for (let i = 0; i < 50 && !a.peers().length; i++) {
      expect(a.stalled()).toEqual(['b']);
      expect(b.stalled()).toEqual(['a']);
      vi.advanceTimersToNextTimer();
    }
    expect(a.peers()).toEqual(['b']);
    expect(b.peers()).toEqual(['a']);
    expect(a.stalled()).toEqual([]);
    expect(b.stalled()).toEqual([]);
    vi.runAllTimers();
    expect(w.hub.builds('a', 'b')).toBe(5);
    expect(w.hub.builds('b', 'a')).toBe(5);
    w.close();
  });

  it('C1: a loss only the polite side sees is repaired by one addressed rebuild on the other side', () => {
    const w = room({ random: prng(5).float });
    const a = w.join('a');
    const b = w.join('b'); // 'b' > 'a', so b is the polite side
    const got: string[] = [];
    a.onMessage((o, f) => got.push(`${o}:${f}`));
    w.hub.fail('b', 'a', 'local');
    expect(b.peers()).toEqual([]);
    expect(b.stalled()).toEqual(['a']);
    expect(a.peers()).toEqual(['b']); // a heard nothing
    vi.runAllTimers();
    expect(w.hub.builds('b', 'a')).toBe(2);
    expect(w.hub.builds('a', 'b')).toBe(2); // exactly one replacement, in answer to b's announce
    expect(a.peers()).toEqual(['b']);
    expect(b.peers()).toEqual(['a']);
    expect([w.hub.live('a', 'b'), w.hub.live('b', 'a')]).toEqual([1, 1]);
    b.send('a', 'after');
    expect(got).toEqual(['b:after']);
    w.close();
  });

  it('C2: a loss both sides see rebuilds one instance on each side, no announce ping-pong', () => {
    const w = room({ random: prng(9).float });
    const a = w.join('a');
    const b = w.join('b');
    w.hub.fail('a', 'b', 'both');
    expect(a.stalled()).toEqual(['b']);
    expect(b.stalled()).toEqual(['a']);
    vi.runAllTimers();
    expect(w.hub.builds('a', 'b')).toBe(2);
    expect(w.hub.builds('b', 'a')).toBe(2);
    expect(a.peers()).toEqual(['b']);
    expect(b.peers()).toEqual(['a']);
    const signals = (o: string) =>
      (w.sent.get(o) ?? []).filter((m) => m.t === 'signal').length;
    // one announce per build; the answering side's is addressed, so nothing rebuilds again
    expect(signals('a') + signals('b')).toBe(4);
    w.close();
  });

  it('C3: the relay reporting the origin gone before the retry cancels it', () => {
    const w = room({ random: prng(11).float });
    const a = w.join('a');
    w.join('b');
    w.hub.fail('a', 'b', 'local');
    expect(vi.getTimerCount()).toBe(1);
    w.leave('b');
    expect(a.members()).toEqual([]);
    expect(a.stalled()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(w.hub.builds('a', 'b')).toBe(1);
    w.close();
  });

  it('C4: a re-welcome before the retry builds exactly once, at the welcome', () => {
    const w = room({
      random: prng(13).float,
      links: { retry: { minMs: 5000 } },
    });
    const a = w.join('a');
    const b = w.join('b');
    w.hub.fail('a', 'b', 'local');
    expect(a.stalled()).toEqual(['b']);
    w.drop('a'); // b hears a gone and drops its end; a reconnects in 1000 ms
    expect(b.members()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(a.status()).toBe('live');
    expect(w.hub.builds('a', 'b')).toBe(2);
    expect(a.peers()).toEqual(['b']);
    expect(b.peers()).toEqual(['a']);
    vi.runAllTimers();
    expect(w.hub.builds('a', 'b')).toBe(2);
    expect(w.hub.builds('b', 'a')).toBe(2);
    w.close();
  });

  it('C5: a link that opens at 14 999 ms is not dropped at 15 000 ms; one at 15 001 ms is', () => {
    const relay = createRelay();
    /** A connector whose channel opens `ms` after it is built; nothing else happens. */
    const late =
      (ms: number, built: { n: number }): PeerConnector =>
      () => {
        built.n++;
        const openCbs = new Set<() => void>();
        let open = false;
        setTimeout(() => {
          open = true;
          for (const cb of [...openCbs]) cb();
        }, ms);
        const channel: DataChannelLike = {
          send: () => undefined,
          onMessage: () => () => undefined,
          onOpen: (cb) => {
            if (open) cb();
            openCbs.add(cb);
            return () => openCbs.delete(cb);
          },
          onClose: () => () => undefined,
          close: () => undefined,
        };
        return { channel, signal: () => undefined, close: () => undefined };
      };
    const make = (origin: string, connector: PeerConnector) =>
      TestBed.runInInjectionContext(() =>
        peerLinks({
          room: ROOM,
          origin,
          signaling: directTransport(relay, { writer: origin }),
          connector,
          random: () => 0.5,
        }),
      );
    const onTime = { n: 0 };
    const a = make('a', late(14_999, onTime));
    make('b', late(14_999, { n: 0 }));
    vi.advanceTimersByTime(14_999);
    expect(a.peers()).toEqual(['b']);
    vi.advanceTimersByTime(60_000);
    expect(a.peers()).toEqual(['b']);
    expect(a.stalled()).toEqual([]);
    expect(onTime.n).toBe(1);

    const tooLate = { n: 0 };
    const c = make('c', late(15_001, tooLate));
    vi.advanceTimersByTime(15_000);
    expect(c.peers()).toEqual([]);
    expect(c.stalled().length).toBeGreaterThan(0);
    vi.advanceTimersByTime(1);
    expect(c.peers()).toEqual([]); // the dropped link's late open is ignored
  });

  it('C5, takeover: a new instance that never opens is lost at the open timeout', () => {
    const w = room({ random: prng(17).float });
    const a = w.join('a');
    w.join('b');
    w.hub.refuse('a', 'b', 1);
    w.hub.fail('b', 'a', 'local');
    vi.advanceTimersToNextTimer(); // b rebuilds; a replaces its end in answer
    expect(w.hub.builds('a', 'b')).toBe(2);
    expect(a.peers()).toEqual([]);
    vi.advanceTimersByTime(14_999);
    expect(w.hub.live('a', 'b')).toBe(1);
    vi.advanceTimersByTime(1);
    expect(w.hub.live('a', 'b')).toBe(0);
    expect(a.stalled()).toEqual(['b']);
    vi.runAllTimers();
    expect(a.peers()).toEqual(['b']);
    w.close();
  });

  it('C6: a signal from the remote instance before the failure is dropped after the rebuild', () => {
    const w = room({ random: prng(19).float });
    const received: unknown[][] = [];
    const tap: PeerConnector = (o) => {
      const made = w.hub.connectorFor('a')(o);
      const got: unknown[] = [];
      received.push(got);
      return { ...made, signal: (data) => got.push(data) };
    };
    const a = w.join('a', { connector: tap });
    w.join('b');
    const signalsOf = (origin: string) =>
      (w.sent.get(origin) ?? []).filter((m) => m.t === 'signal');
    type Signal = Extract<ClientMsg, { t: 'signal' }>;
    const instanceOfA = () =>
      ((signalsOf('a').at(-1) as Signal).data as { link: string }).link;
    // b's announce, addressed to a's current instance as b would once it is bound
    const addressed = (): Signal => {
      const announce = signalsOf('b').at(-1) as Signal;
      return {
        ...announce,
        data: { ...(announce.data as object), to: instanceOfA() },
      };
    };
    const old = addressed();
    expect((old.data as { to?: string }).to).toBe(instanceOfA());
    w.hub.fail('a', 'b', 'both');
    vi.runAllTimers();
    expect(received).toHaveLength(2);
    expect(a.peers()).toEqual(['b']);
    const builds = w.hub.builds('a', 'b');
    const replay = (msg: ClientMsg, probe: string) =>
      msg.t === 'signal' &&
      w.transports.get('b')!.send({
        ...msg,
        data: { ...(msg.data as object), probe },
      });
    replay(old, 'stale');
    expect(received.flat()).not.toContainEqual({ probe: 'stale' });
    expect(w.hub.builds('a', 'b')).toBe(builds);
    expect(a.peers()).toEqual(['b']);
    // the same replay from the current instance is delivered: the drop is the addressing
    const fresh = addressed();
    expect(fresh).not.toEqual(old);
    replay(fresh, 'fresh');
    expect(received[1]).toContainEqual({ probe: 'fresh' });
    expect(w.hub.builds('a', 'b')).toBe(builds);
    w.close();
  });

  it('C7: after an open, a later loss retries from minMs again', () => {
    // random 0.5 makes every delay three quarters of its base: 750, 1500, 3000, ...
    const w = room({ random: () => 0.5 });
    const a = w.join('a');
    w.join('b');
    const builds = () => w.hub.builds('a', 'b');
    w.hub.refuse('a', 'b', 1);
    w.hub.fail('a', 'b', 'both');
    vi.advanceTimersByTime(749);
    expect(builds()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(builds()).toBe(2); // refused: never opens
    vi.advanceTimersByTime(15_000); // open timeout: the second loss
    vi.advanceTimersByTime(1499);
    expect(builds()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(builds()).toBe(3);
    expect(a.peers()).toEqual(['b']);
    w.hub.fail('a', 'b', 'both');
    vi.advanceTimersByTime(749);
    expect(builds()).toBe(3);
    vi.advanceTimersByTime(1);
    expect(builds()).toBe(4);
    expect(a.peers()).toEqual(['b']);
    w.close();
  });

  it('C8: close() with a retry pending builds nothing and calls nothing afterwards', () => {
    const w = room({ random: prng(23).float });
    const a = w.join('a');
    w.join('b');
    w.hub.fail('a', 'b', 'local');
    expect(a.stalled()).toEqual(['b']);
    const opened = vi.fn();
    const closed = vi.fn();
    a.onOpen(opened);
    a.onClose(closed);
    a.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(w.hub.builds('a', 'b')).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(a.stalled()).toEqual([]);
    w.close();
  });

  it('storm bound: refused forever, each side builds at most 21 times in 300 000 ms after the fifth', () => {
    const w = room({ random: prng(29).float });
    w.hub.refuse('a', 'b', 1e9);
    w.join('a');
    w.join('b');
    for (let i = 0; i < 100 && w.hub.builds('a', 'b') < 5; i++)
      vi.advanceTimersToNextTimer();
    const fifth = [w.hub.builds('a', 'b'), w.hub.builds('b', 'a')];
    expect(fifth[0]).toBe(5);
    vi.advanceTimersByTime(300_000);
    const inWindow = [
      w.hub.builds('a', 'b') - fifth[0] + 1,
      w.hub.builds('b', 'a') - fifth[1] + 1,
    ];
    for (const n of inWindow) {
      expect(n).toBeLessThanOrEqual(21);
      expect(n).toBeGreaterThan(5); // and it never gives up
    }
    w.close();
  });

  it('ICE: relay-issued servers reach every build after the welcome; absent means undefined', () => {
    const ice: IceServer[] = [
      { urls: ['turn:relay.example'], username: 'u', credential: 'c' },
    ];
    for (const issued of [ice, undefined]) {
      const w = room({
        random: prng(31).float,
        ...(issued ? { relay: { iceServers: issued } } : {}),
      });
      const seen: { ice: unknown; has: boolean }[] = [];
      const spy =
        (local: string): PeerConnector =>
        (o) => (
          seen.push({ ice: o.iceServers, has: 'iceServers' in o }),
          w.hub.connectorFor(local)(o)
        );
      w.join('a', { connector: spy('a') });
      w.join('b', { connector: spy('b') });
      w.hub.fail('a', 'b', 'both');
      vi.runAllTimers();
      expect(seen).toHaveLength(4);
      // a's announce reaches b before b's own welcome; b holds it and builds only from the
      // welcome, so even the joiner's first link carries the relay's servers
      for (const x of seen) {
        expect(x.ice).toEqual(issued);
        expect(x.has).toBe(issued !== undefined);
      }
      w.close();
    }
  });

  it('ICE over a port: meshSync hands the welcome servers to links that attach later', async () => {
    const ice: IceServer[] = [{ urls: 'stun:relay.example' }];
    for (const issued of [ice, undefined]) {
      const relay = createRelay(issued ? { iceServers: issued } : {});
      const hub = pairHub();
      TestBed.runInInjectionContext(() =>
        peerLinks({
          room: ROOM,
          origin: 'a',
          signaling: directTransport(relay, { writer: 'a' }),
          connector: hub.connectorFor('a'),
        }),
      );
      const mesh = TestBed.runInInjectionContext(() =>
        meshSync(store({ n: 0 }), {
          room: ROOM,
          writer: 'b',
          transport: directTransport(relay, { writer: 'b' }),
        }),
      );
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
        TestBed.tick();
      }
      const origin = mesh.origin()!;
      expect(mesh.members()).toEqual(['a']);
      expect(mesh.signaling.iceServers?.()).toEqual(issued);
      const seen: unknown[] = [];
      const b = TestBed.runInInjectionContext(() =>
        peerLinks({
          room: ROOM,
          origin,
          signaling: mesh.signaling,
          connector: (o) => (
            seen.push(o.iceServers),
            hub.connectorFor(origin)(o)
          ),
        }),
      );
      expect(b.peers()).toEqual(['a']);
      expect(seen).toEqual([issued]);
      b.close();
      mesh.close();
    }
  });

  // Rider: no link before the welcome of the connection it signals over (I8)

  /** A transport the test feeds by hand, standing in for a relay connection. */
  function handTransport() {
    const cbs = new Set<(msg: ServerMsg) => void>();
    const closeCbs = new Set<() => void>();
    const sent: ClientMsg[] = [];
    let made = 0;
    const factory = () => {
      made++;
      const t: MeshTransport = {
        send: (msg) => void sent.push(msg),
        onMessage: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => undefined,
      };
      return t;
    };
    return {
      factory,
      sent,
      connections: () => made,
      deliver: (msg: ServerMsg) => {
        for (const cb of [...cbs]) cb(msg);
      },
      drop: () => {
        cbs.clear();
        for (const cb of [...closeCbs]) cb();
        closeCbs.clear();
      },
    };
  }

  /** A connector whose channels never open; records every build and every signal it got. */
  function recordingConnector() {
    const builds: { remote: string; ice: unknown; signals: unknown[] }[] = [];
    const idle: DataChannelLike = {
      send: () => undefined,
      onMessage: () => () => undefined,
      onOpen: () => () => undefined,
      onClose: () => () => undefined,
      close: () => undefined,
    };
    const connector: PeerConnector = (o) => {
      const entry = {
        remote: o.remote,
        ice: o.iceServers,
        signals: [] as unknown[],
      };
      builds.push(entry);
      return {
        channel: idle,
        signal: (data) => void entry.signals.push(data),
        close: () => undefined,
      };
    };
    return { builds, connector };
  }

  const welcome = (members: string[], ice?: IceServer[]): ServerMsg => ({
    t: 'welcome',
    room: ROOM,
    seq: 0,
    instance: 'i',
    schemaVersion: 0,
    peers: [],
    members,
    mode: 'up-to-date',
    ...(ice ? { ice } : {}),
  });
  const signalFrom = (from: string, data: unknown): ServerMsg => ({
    t: 'signal',
    room: ROOM,
    from,
    data,
  });
  const member = (origin: string, gone?: boolean): ServerMsg => ({
    t: 'member',
    room: ROOM,
    origin,
    ...(gone ? { gone: true } : {}),
  });

  function byHand() {
    const wire = handTransport();
    const rec = recordingConnector();
    const links = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: ROOM,
        origin: 'me',
        signaling: wire.factory,
        connector: rec.connector,
      }),
    );
    return { wire, rec, links };
  }

  const record = (l: PeerLinks): string[] => {
    const got: string[] = [];
    l.onMessage((origin, frame, channel) =>
      got.push(`${origin}:${channel}:${frame}`),
    );
    return got;
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => (resolve = res));
    return { promise, resolve };
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      vi.advanceTimersByTime(20);
      TestBed.tick();
    }
  };

  it('I8: a joiner whose welcome waits behind a commit builds nothing until it lands, then with its servers', async () => {
    const gate = deferred();
    let calls = 0;
    const relay = createRelay({
      onCommit: () => gate.promise,
      iceServers: () => [{ urls: `stun:${++calls}.example` }],
    });
    const hub = pairHub();
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    const mesh = TestBed.runInInjectionContext(() =>
      meshSync(s, {
        room: ROOM,
        writer: 'a',
        transport: directTransport(relay, { writer: 'a' }),
      }),
    );
    await settle();
    const origin = mesh.origin()!;
    const a = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: ROOM,
        origin,
        signaling: mesh.signaling,
        connector: hub.connectorFor(origin),
      }),
    );
    expect(a.status()).toBe('live');
    s.n.set(1);
    await settle();
    // a's write is in flight behind the gate; b's welcome must wait for it
    const seen: unknown[] = [];
    const b = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: ROOM,
        origin: 'b',
        signaling: directTransport(relay, { writer: 'b' }),
        connector: (o) => (seen.push(o.iceServers), hub.connectorFor('b')(o)),
      }),
    );
    expect(a.members()).toEqual(['b']);
    expect(hub.builds(origin, 'b')).toBe(1);
    expect(b.status()).toBe('connecting');
    expect(seen).toEqual([]);
    expect(hub.builds('b', origin)).toBe(0);
    const got = record(b);
    gate.resolve();
    await settle();
    expect(b.status()).toBe('live');
    expect(seen).toEqual([[{ urls: 'stun:2.example' }]]);
    expect(b.peers()).toEqual([origin]);
    expect(a.peers()).toEqual(['b']);
    a.send('b', 'after the welcome');
    expect(got).toEqual([`${origin}:mmstack-mesh:after the welcome`]);
    b.close();
    a.close();
    mesh.close();
  });

  it('holds signals until the welcome and replays them in order; a leave discards its sender', () => {
    const { wire, rec, links } = byHand();
    wire.deliver(signalFrom('x', { link: 'X1' }));
    wire.deliver(signalFrom('x', { link: 'X1', to: undefined, n: 1 }));
    wire.deliver(signalFrom('y', { link: 'Y1' }));
    wire.deliver(signalFrom('y', { link: 'Y1', n: 2 }));
    wire.deliver(member('y', true));
    expect(rec.builds).toEqual([]);
    expect(links.status()).toBe('connecting');
    wire.deliver(welcome(['x', 'y']));
    expect(links.status()).toBe('live');
    expect(rec.builds.map((b) => b.remote)).toEqual(['x', 'y']);
    expect(rec.builds[0].signals).toEqual([{ n: 1 }]);
    expect(rec.builds[1].signals).toEqual([]);
    links.close();
  });

  it('holds at most 256 signals; the rest are dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { wire, rec, links } = byHand();
    for (let i = 0; i < 300; i++)
      wire.deliver(signalFrom('x', { link: 'X1', n: i }));
    wire.deliver(welcome(['x']));
    expect(rec.builds).toHaveLength(1);
    expect(rec.builds[0].signals).toHaveLength(256);
    expect(rec.builds[0].signals[0]).toEqual({ n: 0 });
    expect(rec.builds[0].signals[255]).toEqual({ n: 255 });
    expect(warn).toHaveBeenCalledTimes(1);
    links.close();
    warn.mockRestore();
  });

  it('close() during the hold builds nothing afterwards', () => {
    const { wire, rec, links } = byHand();
    wire.deliver(signalFrom('x', { link: 'X1' }));
    links.close();
    wire.deliver(welcome(['x']));
    expect(rec.builds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a join before the welcome builds nothing; the welcome links the origin once', () => {
    const { wire, rec, links } = byHand();
    wire.deliver(member('x'));
    expect(rec.builds).toEqual([]);
    expect(links.members()).toEqual([]);
    wire.deliver(welcome(['x']));
    expect(rec.builds.map((b) => b.remote)).toEqual(['x']);
    expect(links.members()).toEqual(['x']);
    links.close();
  });

  it('after the welcome, a signal from an origin the relay does not list is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { wire, rec, links } = byHand();
    wire.deliver(welcome(['x']));
    wire.deliver(signalFrom('z', { link: 'Z1' }));
    wire.deliver(signalFrom('z', { link: 'Z1', n: 1 }));
    expect(rec.builds.map((b) => b.remote)).toEqual(['x']);
    expect(links.stalled()).toEqual([]);
    expect(links.members()).toEqual(['x']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("'z'");
    vi.advanceTimersByTime(60_000);
    expect(rec.builds.filter((b) => b.remote === 'z')).toEqual([]);
    links.close();
    warn.mockRestore();
  });

  it('after a reconnect, a signal before the new welcome is held and the build carries the new servers', () => {
    const { wire, rec, links } = byHand();
    wire.deliver(welcome(['x'], [{ urls: 'stun:one' }]));
    wire.deliver(signalFrom('x', { link: 'X1' }));
    expect(rec.builds).toHaveLength(1);
    expect(rec.builds[0].ice).toEqual([{ urls: 'stun:one' }]);
    wire.drop();
    expect(links.status()).toBe('connecting');
    vi.advanceTimersByTime(1000);
    expect(wire.connections()).toBe(2);
    // x's end restarted while this side was away: a new instance announces before the welcome
    wire.deliver(signalFrom('x', { link: 'X2' }));
    expect(rec.builds).toHaveLength(1);
    wire.deliver(welcome(['x'], [{ urls: 'stun:two' }]));
    expect(rec.builds).toHaveLength(2);
    expect(rec.builds[1].remote).toBe('x');
    expect(rec.builds[1].ice).toEqual([{ urls: 'stun:two' }]);
    links.close();
  });
});
