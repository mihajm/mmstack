/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  MESH_DIRECT_VERSION,
  MESH_PROTO_VERSION,
  type ClientMsg,
  type PrincipalCtx,
  type Relay,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives/core';
import { describe, expect, it, vi } from 'vitest';
import { agentSeat } from './agent-seat';
import { meshSync } from './mesh-sync';
import {
  peerLinks,
  type DataChannelLike,
  type PeerConnector,
} from './peer-links';
import type { MeshDirect } from './session';
import { directTransport, type MeshTransportFactory } from './transport';

const ROOM = 'direct-room';

/** A real relay transport that records what the client sends, so origins and frames are readable. */
function recorded(relay: Relay, ctx: PrincipalCtx) {
  const inner = directTransport(relay, ctx);
  const sent: ClientMsg[] = [];
  const factory: MeshTransportFactory = () => {
    const t = inner();
    return { ...t, send: (m) => (sent.push(m), t.send(m)) };
  };
  const origin = (): string => {
    const hello = [...sent].reverse().find((m) => m.t === 'hello');
    if (!hello || hello.t !== 'hello') throw new Error('no hello yet');
    return hello.origin;
  };
  return { factory, sent, origin };
}

function seat(relay: Relay, writer: string) {
  const rec = recorded(relay, { writer, kind: 'agent' });
  const s = agentSeat({ n: 0 }, { room: ROOM, writer, transport: rec.factory });
  const got: MeshDirect[] = [];
  const unsub = s.direct((m) => got.push(m));
  return { s, rec, got, unsub, origin: rec.origin };
}

/** A transport with no relay behind it: the spec decides every inbound frame and its timing. */
function scripted() {
  const sent: ClientMsg[] = [];
  let deliver: (m: ServerMsg) => void = () => undefined;
  let closeCb: (code: number, reason: string) => void = () => undefined;
  let opened = 0;
  const factory: MeshTransportFactory = () => {
    opened++;
    const cbs = new Set<(m: ServerMsg) => void>();
    deliver = (m) => {
      for (const cb of [...cbs]) cb(m);
    };
    return {
      send: (m) => sent.push(m),
      onMessage: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
      onClose: (cb) => ((closeCb = cb), () => undefined),
      close: () => undefined,
    };
  };
  const welcome = (members: string[] = ['ox']): ServerMsg => ({
    t: 'welcome',
    room: ROOM,
    seq: 1,
    instance: 'i1',
    schemaVersion: 0,
    peers: [],
    members,
    mode: 'snapshot',
    registers: [
      {
        path: [],
        siblings: [
          {
            kind: 'set',
            value: { n: 0 },
            writer: 'w',
            origin: 'ox',
            hlc: { p: 1, l: 0 },
            epoch: 0,
          },
        ],
        water: {},
      },
    ],
    wm: { ox: 1 },
    index: 0,
    reason: 'genesis',
    policy: 'discard',
    extent: {},
    preCutMax: {},
    firstStamps: {},
    receipts: {},
    ranges: {},
    settled: {},
  });
  const direct = (from: string, data: unknown): ServerMsg => ({
    t: 'direct',
    room: ROOM,
    from,
    v: MESH_DIRECT_VERSION,
    data,
  });
  return {
    factory,
    sent,
    deliver: (m: ServerMsg) => deliver(m),
    drop: () => closeCb(1000, ''),
    opened: () => opened,
    welcome,
    direct,
  };
}

describe('agentSeat: direct frames', () => {
  it('a seat reaches one other seat, and only it, with the relay-stamped origin', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');
    const c = seat(relay, 'agent-c');
    a.s.send(b.origin(), { ask: 'list' });
    expect(b.got).toEqual([
      { from: a.origin(), v: MESH_DIRECT_VERSION, data: { ask: 'list' } },
    ]);
    expect(a.got).toEqual([]);
    expect(c.got).toEqual([]);
    for (const x of [a, b, c]) x.s.close();
  });

  it('send emits the client frame on the seat room, stamped with the direct version', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    a.s.send('ob', 7);
    expect(a.rec.sent.filter((m) => m.t === 'direct')).toEqual([
      { t: 'direct', room: ROOM, to: 'ob', v: MESH_DIRECT_VERSION, data: 7 },
    ]);
    a.s.close();
  });

  it('the unsubscribe stops delivery to that listener only', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');
    const other: MeshDirect[] = [];
    b.s.direct((m) => other.push(m));
    b.unsub();
    a.s.send(b.origin(), 1);
    expect(b.got).toEqual([]);
    expect(other).toHaveLength(1);
    a.s.close();
    b.s.close();
  });

  it('a throwing listener does not starve the others or break the seat', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');
    b.s.direct(() => {
      throw new Error('consumer bug');
    });
    const after: unknown[] = [];
    b.s.direct((m) => after.push(m.data));
    a.s.send(b.origin(), 'x');
    expect(after).toEqual(['x']);
    expect(b.got).toHaveLength(1);
    expect(b.s.status()).toBe('live');
    a.s.close();
    b.s.close();
  });

  it('keeps sender order between two frames', () => {
    const relay = createRelay();
    const a = seat(relay, 'agent-a');
    const b = seat(relay, 'agent-b');
    a.s.send(b.origin(), 1);
    a.s.send(b.origin(), 2);
    expect(b.got.map((m) => m.data)).toEqual([1, 2]);
    a.s.close();
    b.s.close();
  });

  it('holds a frame that arrives before the welcome and hands it over right after', () => {
    const t = scripted();
    const statusAtDelivery: string[] = [];
    const s = agentSeat(
      { n: 0 },
      { room: ROOM, writer: 'w', transport: t.factory },
    );
    s.direct((m) => statusAtDelivery.push(`${s.status()}:${String(m.data)}`));
    t.deliver(t.direct('ox', 'early'));
    expect(statusAtDelivery).toEqual([]);
    t.deliver(t.welcome());
    t.deliver(t.direct('ox', 'late'));
    expect(statusAtDelivery).toEqual(['live:early', 'live:late']);
    s.close();
  });

  it('a leave before the welcome discards what that origin sent; others stay held', () => {
    const t = scripted();
    const s = agentSeat(
      { n: 0 },
      { room: ROOM, writer: 'w', transport: t.factory },
    );
    const got: unknown[] = [];
    s.direct((m) => got.push(m.data));
    t.deliver(t.direct('ox', 'gone-sender'));
    t.deliver(t.direct('oy', 'stays'));
    t.deliver({ t: 'member', room: ROOM, origin: 'ox', gone: true });
    t.deliver(t.welcome(['oy']));
    expect(got).toEqual(['stays']);
    s.close();
  });

  it('a dropped connection discards frames held for its welcome', () => {
    vi.useFakeTimers();
    try {
      const t = scripted();
      const s = agentSeat(
        { n: 0 },
        { room: ROOM, writer: 'w', transport: t.factory },
      );
      const got: unknown[] = [];
      s.direct((m) => got.push(m.data));
      t.deliver(t.direct('ox', 'old-connection'));
      t.drop();
      vi.advanceTimersByTime(1000);
      expect(t.opened()).toBe(2);
      t.deliver(t.welcome());
      expect(got).toEqual([]);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a foreign frame version before any listener, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = scripted();
      const s = agentSeat(
        { n: 0 },
        { room: ROOM, writer: 'w', transport: t.factory },
      );
      const got: unknown[] = [];
      s.direct((m) => got.push(m.data));
      const foreign = (v: unknown): ServerMsg =>
        ({
          t: 'direct',
          room: ROOM,
          from: 'ox',
          v,
          data: 'payload',
        }) as unknown as ServerMsg;
      t.deliver(foreign(2)); // before the welcome: never held either
      t.deliver(t.welcome());
      t.deliver(foreign(2));
      t.deliver(foreign(-1));
      t.deliver(foreign('1'));
      expect(got).toEqual([]);
      const versionWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('version'),
      );
      expect(versionWarnings).toHaveLength(1);
      t.deliver(t.direct('ox', 'ok'));
      expect(got).toEqual(['ok']);
      s.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('holds at most 256 frames before the welcome, keeping the first, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = scripted();
      const s = agentSeat(
        { n: 0 },
        { room: ROOM, writer: 'w', transport: t.factory },
      );
      const got: unknown[] = [];
      s.direct((m) => got.push(m.data));
      for (let i = 1; i <= 300; i++) t.deliver(t.direct('ox', i));
      expect(got).toEqual([]);
      t.deliver(t.welcome());
      expect(got).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
      const boundWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('before the welcome'),
      );
      expect(boundWarnings).toHaveLength(1);
      s.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('nothing is sent or delivered after close', () => {
    const t = scripted();
    const s = agentSeat(
      { n: 0 },
      { room: ROOM, writer: 'w', transport: t.factory },
    );
    const got: unknown[] = [];
    s.direct((m) => got.push(m.data));
    t.deliver(t.welcome());
    s.close();
    s.send('ox', 1);
    t.deliver(t.direct('ox', 'after'));
    expect(t.sent.some((m) => m.t === 'direct')).toBe(false);
    expect(got).toEqual([]);
  });
});

describe('meshSync: direct frames', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      TestBed.tick();
    }
  };

  it('a browser store and a seat exchange frames; peer links never see them', async () => {
    const relay = createRelay();
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    const mesh = TestBed.runInInjectionContext(() =>
      meshSync(s, {
        room: ROOM,
        writer: 'tab',
        transport: directTransport(relay, { writer: 'tab' }),
      }),
    );
    await settle();
    expect(mesh.status()).toBe('live');

    // the signaling port and a real negotiator over it, with a connector that counts everything
    const portSeen: ServerMsg[] = [];
    mesh.signaling.onMessage((m) => portSeen.push(m));
    const builds: string[] = [];
    const fedToConnector: unknown[] = [];
    const connector: PeerConnector = (o) => {
      builds.push(o.remote);
      const channel: DataChannelLike = {
        send: () => undefined,
        close: () => undefined,
        onOpen: () => () => undefined,
        onClose: () => () => undefined,
        onMessage: () => () => undefined,
      };
      return {
        channel,
        signal: (d) => fedToConnector.push(d),
        close: () => undefined,
      };
    };
    const links = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: ROOM,
        origin: mesh.origin()!,
        signaling: mesh.signaling,
        connector,
      }),
    );

    // a raw relay member so the negotiator has nothing to build before the frame arrives
    const raw: ServerMsg[] = [];
    const conn = relay.connect(
      { send: (m) => raw.push(m) },
      { writer: 'seat' },
    );
    conn.receive({
      t: 'hello',
      room: ROOM,
      origin: 'seat-o',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });
    await settle();
    const buildsBefore = builds.length;
    const fedBefore = fedToConnector.length;

    const got: MeshDirect[] = [];
    const unsub = mesh.direct((m) => got.push(m));
    // a payload with no `link`: on `signal` this exact shape starts a build toward the sender
    conn.receive({
      t: 'direct',
      room: ROOM,
      to: mesh.origin()!,
      v: MESH_DIRECT_VERSION,
      data: { ask: 1 },
    });
    await settle();
    expect(got).toEqual([
      { from: 'seat-o', v: MESH_DIRECT_VERSION, data: { ask: 1 } },
    ]);
    expect(portSeen.some((m) => m.t === 'direct')).toBe(false);
    expect(builds.length).toBe(buildsBefore);
    expect(fedToConnector.length).toBe(fedBefore);

    // send emits on the store's room and reaches the seat
    mesh.send('seat-o', 'answer');
    expect(raw.filter((m) => m.t === 'direct')).toEqual([
      {
        t: 'direct',
        room: ROOM,
        from: mesh.origin(),
        v: MESH_DIRECT_VERSION,
        data: 'answer',
      },
    ]);

    unsub();
    conn.receive({
      t: 'direct',
      room: ROOM,
      to: mesh.origin()!,
      v: MESH_DIRECT_VERSION,
      data: 2,
    });
    expect(got).toHaveLength(1);

    // control: the same payload on `signal` does reach the negotiator, so the spies above are wired
    conn.receive({
      t: 'signal',
      room: ROOM,
      to: mesh.origin()!,
      data: { ask: 1 },
    });
    await settle();
    expect(portSeen.some((m) => m.t === 'signal')).toBe(true);
    expect(fedToConnector.length).toBeGreaterThan(fedBefore);

    links.close();
    mesh.close();
    conn.disconnect();
  });

  it('send before any session exists is dropped, not thrown', () => {
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    const mesh = TestBed.runInInjectionContext(() =>
      meshSync(s, {
        room: ROOM,
        writer: 'tab',
        transport: directTransport(createRelay(), { writer: 'tab' }),
        whenReady: () => new Promise<void>(() => undefined),
      }),
    );
    expect(() => mesh.send('x', 1)).not.toThrow();
    mesh.close();
  });
});
