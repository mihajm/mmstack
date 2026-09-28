/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  MESH_PROTO_VERSION,
  type Relay,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  defaultPeerChannels,
  peerLinks,
  type DataChannelLike,
  type PeerConnector,
  type PeerLinks,
  type PeerLinksOptions,
} from './peer-links';
import { directTransport } from './transport';

/**
 * An in-memory channel hub for peer links, derived from the `fakeHub()` in
 * `webrtc-mesh.spec.ts`: it pairs the two ends of a link by (local, remote) origin rather than
 * by call order, so rooms with more than two peers link correctly, and it gives every link one
 * half per requested channel label.
 */
function pairHub() {
  type Half = {
    channel: DataChannelLike;
    deliver(frame: string): void;
    fireOpen(): void;
    fireClose(): void;
    link(other: Half): void;
  };
  const parked = new Map<string, Record<string, Half>>();

  const makeHalf = (): Half => {
    const messageCbs = new Set<(f: string) => void>();
    const openCbs = new Set<() => void>();
    const closeCbs = new Set<() => void>();
    const buffered: string[] = [];
    const inbound: string[] = [];
    let remote: Half | null = null;
    let open = false;
    const half: Half = {
      channel: {
        send: (frame) => {
          if (open && remote) remote.deliver(frame);
          else buffered.push(frame);
        },
        onMessage: (cb) => {
          for (const frame of inbound.splice(0)) cb(frame);
          messageCbs.add(cb);
          return () => messageCbs.delete(cb);
        },
        onOpen: (cb) => {
          if (open) cb();
          openCbs.add(cb);
          return () => openCbs.delete(cb);
        },
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => {
          if (!open) return;
          open = false;
          remote?.fireClose();
          half.fireClose();
        },
      },
      deliver: (frame) => {
        if (messageCbs.size === 0) inbound.push(frame);
        else for (const cb of [...messageCbs]) cb(frame);
      },
      fireOpen: () => {
        open = true;
        const frames = buffered.splice(0);
        for (const cb of [...openCbs]) cb();
        for (const frame of frames) remote?.deliver(frame);
      },
      fireClose: () => {
        open = false;
        for (const cb of [...closeCbs]) cb();
      },
      link: (other) => {
        remote = other;
      },
    };
    return half;
  };

  const connectorFor =
    (local: string): PeerConnector =>
    ({ remote, channels }) => {
      const key = `${local}|${remote}`;
      const mine: Record<string, Half> = {};
      for (const c of channels) mine[c.label] = makeHalf();
      const theirs = parked.get(`${remote}|${local}`);
      if (theirs) {
        parked.delete(`${remote}|${local}`);
        for (const c of channels) {
          mine[c.label].link(theirs[c.label]);
          theirs[c.label].link(mine[c.label]);
        }
        for (const c of channels) mine[c.label].fireOpen();
        for (const c of channels) theirs[c.label].fireOpen();
      } else {
        parked.set(key, mine);
      }
      const byLabel: Record<string, DataChannelLike> = {};
      for (const c of channels) byLabel[c.label] = mine[c.label].channel;
      return {
        channel: byLabel[channels[0].label],
        channels: byLabel,
        signal: () => undefined,
        close: () => {
          if (parked.get(key) === mine) parked.delete(key);
          for (const half of Object.values(mine)) half.channel.close();
        },
      };
    };

  return { connectorFor };
}

const lossy = { label: 'lossy', ordered: false, maxRetransmits: 0 } as const;

describe('peerLinks', () => {
  function links(
    relay: Relay,
    hub: ReturnType<typeof pairHub>,
    origin: string,
    extra: Partial<PeerLinksOptions> = {},
  ): PeerLinks {
    return TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'links',
        origin,
        signaling: directTransport(relay, { writer: origin }),
        connector: hub.connectorFor(origin),
        ...extra,
      }),
    );
  }

  function record(l: PeerLinks) {
    const got: string[] = [];
    l.onMessage((origin, frame, channel) =>
      got.push(`${origin}:${channel}:${frame}`),
    );
    return got;
  }

  it('links every pair in the room and carries frames both ways', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const b = links(relay, hub, 'b');
    const c = links(relay, hub, 'c');
    const [ga, gb, gc] = [record(a), record(b), record(c)];

    expect(a.status()).toBe('live');
    expect([...a.peers()].sort()).toEqual(['b', 'c']);
    expect([...b.peers()].sort()).toEqual(['a', 'c']);
    expect([...c.peers()].sort()).toEqual(['a', 'b']);

    a.send('b', 'to-b');
    c.broadcast('from-c');
    expect(ga).toEqual(['c:mmstack-mesh:from-c']);
    expect(gb).toEqual(['a:mmstack-mesh:to-b', 'c:mmstack-mesh:from-c']);
    expect(gc).toEqual([]);
    expect(relay.room('links')!.seq).toBe(0);
  });

  it('asks the connector for the default channel when none are given', () => {
    const relay = createRelay();
    const hub = pairHub();
    const seen: unknown[] = [];
    const spy: PeerConnector = (o) => (
      seen.push(o.channels),
      hub.connectorFor('a')(o)
    );
    const a = links(relay, hub, 'a', { connector: spy });
    links(relay, hub, 'b');
    expect(a.channels).toEqual(['mmstack-mesh']);
    expect(seen).toEqual([defaultPeerChannels]);
  });

  it('keeps labelled channels apart and opens a peer only when all are open', () => {
    const relay = createRelay();
    const hub = pairHub();
    const channels = [{ label: 'main' }, lossy];
    const a = links(relay, hub, 'a', { channels });
    const b = links(relay, hub, 'b', { channels });
    const gb = record(b);
    const opened: string[] = [];
    b.onOpen((origin, channel) => opened.push(`${origin}:${channel}`));

    expect(opened).toEqual(['a:main', 'a:lossy']);
    expect(b.peers()).toEqual(['a']);
    a.broadcast('m1');
    a.broadcast('l1', 'lossy');
    a.send('b', 'l2', 'lossy');
    a.send('b', 'nowhere', 'unknown-label');
    expect(gb).toEqual(['a:main:m1', 'a:lossy:l1', 'a:lossy:l2']);
  });

  it('never opens a peer whose connector lacks a requested channel', () => {
    const relay = createRelay();
    const hub = pairHub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const single: (local: string) => PeerConnector = (local) => (o) => {
      const { channel, signal, close } = hub.connectorFor(local)({
        ...o,
        channels: [o.channels[0]],
      });
      return { channel, signal, close };
    };
    const channels = [{ label: 'main' }, lossy];
    const a = links(relay, hub, 'a', { channels, connector: single('a') });
    links(relay, hub, 'b', { channels, connector: single('b') });
    expect(a.peers()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops a link when the relay reports its origin gone', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const b = links(relay, hub, 'b');
    const closed: string[] = [];
    a.onClose((origin) => closed.push(origin));
    expect(a.peers()).toEqual(['b']);
    expect(a.members()).toEqual(['b']);
    expect(b.members()).toEqual(['a']);

    b.close();
    expect(closed).toEqual(['b']);
    expect(a.peers()).toEqual([]);
    expect(a.members()).toEqual([]);
    expect(b.members()).toEqual([]);

    const b2 = links(relay, hub, 'b');
    expect(a.peers()).toEqual(['b']);
    expect(b2.peers()).toEqual(['a']);
  });

  it('with autoConnect off, nothing happens until connect(); onOpen replays open links', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const b = links(relay, hub, 'b', { autoConnect: false });
    expect(b.status()).toBe('connecting');
    expect(a.peers()).toEqual([]);

    const early = record(b);
    a.onOpen((origin) => a.send(origin, 'hi'));
    b.connect();
    b.connect();
    expect(b.status()).toBe('live');
    expect(early).toEqual(['a:mmstack-mesh:hi']);

    const late: string[] = [];
    b.onOpen((origin, channel) => late.push(`${origin}:${channel}`));
    expect(late).toEqual(['a:mmstack-mesh']);
  });

  it('rides on a connection someone else owns without a second hello', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');

    // the owner joins as 'b' and hands the links a port over the same connection
    const owner = directTransport(relay, { writer: 'b' })();
    const inbound = new Set<(msg: ServerMsg) => void>();
    owner.onMessage((msg) => {
      for (const cb of [...inbound]) cb(msg);
    });
    const b = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'links',
        origin: 'b',
        signaling: {
          members: () => undefined,
          send: (msg) => owner.send(msg),
          onMessage: (cb) => (inbound.add(cb), () => inbound.delete(cb)),
        },
        connector: hub.connectorFor('b'),
      }),
    );
    owner.send({
      t: 'hello',
      room: 'links',
      origin: 'b',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });

    expect(b.status()).toBe('live');
    expect(b.peers()).toEqual(['a']);
    expect(a.peers()).toEqual(['b']);
    expect(relay.room('links')!.members).toBe(2);

    // closing the links leaves the owner's connection alone
    b.close();
    expect(inbound.size).toBe(0);
  });

  it('attaches after the owner was welcomed and negotiates with existing members', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const owner = directTransport(relay, { writer: 'b' })();
    let members: readonly string[] | undefined;
    owner.onMessage((msg) => {
      if (msg.t === 'welcome') members = msg.members;
      else if (msg.t === 'member' && members) {
        members = msg.gone
          ? members.filter((o) => o !== msg.origin)
          : [...new Set([...members, msg.origin])];
      }
    });
    owner.send({
      t: 'hello',
      room: 'links',
      origin: 'b',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });
    expect(members).toEqual(['a']);
    const sent = vi.fn(owner.send);
    const b = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'links',
        origin: 'b',
        signaling: {
          members: () => members,
          send: sent,
          onMessage: owner.onMessage,
        },
        connector: hub.connectorFor('b'),
      }),
    );
    expect(b.status()).toBe('live');
    expect(b.members()).toEqual(['a']);
    expect(b.peers()).toEqual(['a']);
    expect(a.peers()).toEqual(['b']);
    const got = record(b);
    a.send('b', 'already-joined');
    expect(got).toEqual(['a:mmstack-mesh:already-joined']);
    // the links signal over the owner's connection but never say hello on it
    expect(sent).toHaveBeenCalled();
    expect(sent.mock.calls.every(([msg]) => msg.t === 'signal')).toBe(true);
    b.close();
    expect(relay.room('links')!.members).toBe(2);
    owner.close();
  });

  it('replays membership and delivers leave and rejoin synchronously', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const first = links(relay, hub, 'b');
    const snapshots: (readonly string[])[] = [];
    const unsub = a.onMembers((members) => snapshots.push(members));
    first.close();
    const second = links(relay, hub, 'b');
    expect(snapshots).toEqual([['b'], [], ['b']]);
    unsub();
    second.close();
    expect(snapshots).toEqual([['b'], [], ['b']]);
    a.close();
    const afterEnd: (readonly string[])[] = [];
    a.onMembers((members) => afterEnd.push(members));
    expect(afterEnd).toEqual([[]]);
  });

  it('a second seat with the same origin replaces the link; the old seat is cut off', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const b1 = links(relay, hub, 'b');
    const ga = record(a);
    const closed: string[] = [];
    a.onClose((origin) => closed.push(origin));
    expect(a.peers()).toEqual(['b']);

    // the relay hands the seat to b2 and reports it as a plain join; a knows the link
    // instance it holds is not the one that now signals
    const b2 = links(relay, hub, 'b');
    expect(closed).toEqual(['b']);
    expect(a.peers()).toEqual(['b']);
    expect(b2.peers()).toEqual(['a']);
    expect(b1.peers()).toEqual([]);
    b2.send('a', 'from-b2');
    b1.send('a', 'from-b1');
    a.send('b', 'to-b');
    expect(ga).toEqual(['b:mmstack-mesh:from-b2']);
    b1.close();
    b2.close();
  });

  it('a frame of a replaced link is never delivered to the new one', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = links(relay, hub, 'a');
    const raw: DataChannelLike[] = [];
    const tapping: PeerConnector = (o) => {
      const made = hub.connectorFor('b')(o);
      raw.push(made.channel);
      return made;
    };
    const b1 = links(relay, hub, 'b', { connector: tapping });
    const ga = record(a);
    const b2 = links(relay, hub, 'b', { connector: tapping });
    expect(a.peers()).toEqual(['b']);
    // the first seat's channel object still exists, but its link was closed and its
    // callbacks unsubscribed on both sides; sending on it reaches nothing at a
    raw[0].send('ghost');
    b2.send('a', 'live');
    expect(ga).toEqual(['b:mmstack-mesh:live']);
    b1.close();
    b2.close();
  });

  it('stamps signal payloads with instance and address and strips both for the connector', () => {
    const relay = createRelay();
    const hub = pairHub();
    const sent: unknown[] = [];
    const received: unknown[] = [];
    const spyTransport = (writer: string) => () => {
      const t = directTransport(relay, { writer })();
      return {
        ...t,
        send: (msg: Parameters<typeof t.send>[0]) => {
          if (msg.t === 'signal') sent.push(msg.data);
          t.send(msg);
        },
      };
    };
    const talking =
      (local: string): PeerConnector =>
      (o) => {
        const made = hub.connectorFor(local)(o);
        o.sendSignal({ description: `offer-from-${local}` });
        return { ...made, signal: (data) => received.push(data) };
      };
    links(relay, hub, 'a', {
      signaling: spyTransport('a'),
      connector: talking('a'),
    });
    links(relay, hub, 'b', {
      signaling: spyTransport('b'),
      connector: talking('b'),
    });
    const ids = sent.map((d) => (d as { link: string }).link);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(2);
    // a announces unaddressed (it built the link from the join); b answers in the same
    // turn, built for a's instance, so everything b sends and a's buffered early offer,
    // flushed after b's answer bound the remote, are addressed
    const [fromA] = ids;
    const fromB = ids.find((id) => id !== fromA);
    expect(sent).toEqual([
      { link: fromA },
      { link: fromB, to: fromA },
      { link: fromB, to: fromA, description: 'offer-from-b' },
      { link: fromA, to: fromB, description: 'offer-from-a' },
    ]);
    expect(received).toHaveLength(2);
    expect(received).toContainEqual({ description: 'offer-from-a' });
    expect(received).toContainEqual({ description: 'offer-from-b' });
  });

  it('a relay reject ends the links', () => {
    const relay = createRelay();
    const hub = pairHub();
    const ended = vi.fn();
    const a = links(relay, hub, 'a', { policyVersion: 0 });
    const b = links(relay, hub, 'b', { policyVersion: 7, autoConnect: false });
    b.onEnd(ended);
    b.connect();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(b.status()).toBe('connecting');
    expect(a.peers()).toEqual([]);
  });
});
