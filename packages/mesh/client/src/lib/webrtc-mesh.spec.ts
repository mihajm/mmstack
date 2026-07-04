import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives';
import { directTransport } from './transport';
import {
  webRtcMesh,
  type DataChannelLike,
  type PeerConnector,
} from './webrtc-mesh';

type State = { title: string; nested: { a: number; b: number } };
const initial = (): State => ({ title: 'init', nested: { a: 0, b: 0 } });

function fakeHub() {
  type Half = {
    channel: DataChannelLike;
    deliver(frame: string): void;
    fireOpen(): void;
    fireClose(): void;
    link(other: Half): void;
  };
  let parked: Half | null = null;

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

  const connector: PeerConnector = () => {
    const mine = makeHalf();
    if (parked) {
      const theirs = parked;
      parked = null;
      mine.link(theirs);
      theirs.link(mine);
      mine.fireOpen();
      theirs.fireOpen();
    } else {
      parked = mine;
    }
    return {
      channel: mine.channel,
      signal: () => undefined,
      close: () => mine.channel.close(),
    };
  };

  return { connector };
}

describe('webRtcMesh (P2P converging over linked channels)', () => {
  function peer(relay: Relay, hub: ReturnType<typeof fakeHub>, writer: string) {
    return TestBed.runInInjectionContext(() => {
      const s = store<State>(initial());
      const mesh = webRtcMesh(s, {
        room: 'p2p',
        writer,
        signaling: directTransport(relay, { writer }),
        connector: hub.connector,
      });
      return { s, mesh };
    });
  }

  const flush = () => TestBed.tick();

  it('two peers converge over data channels; the relay only signals', () => {
    const relay = createRelay();
    const hub = fakeHub();
    const a = peer(relay, hub, 'wa');
    const b = peer(relay, hub, 'wb');

    expect(a.mesh.status()).toBe('live');
    expect(b.mesh.status()).toBe('live');
    expect(a.mesh.peers().length).toBe(1);
    expect(b.mesh.peers().length).toBe(1);

    a.s.title.set('over-rtc');
    flush();
    expect(b.s().title).toBe('over-rtc');

    b.s.nested.b.set(2);
    a.s.nested.a.set(1);
    flush();
    expect(a.s()).toEqual(b.s());
    expect(a.s().nested).toEqual({ a: 1, b: 2 });

    expect(relay.room('p2p')!.seq).toBe(0);
  });

  it('a late joiner hydrates pairwise from the peer whose state covers it', () => {
    const relay = createRelay();
    const hub = fakeHub();
    const a = peer(relay, hub, 'wa');
    a.s.title.set('pre-existing');
    flush();

    const b = peer(relay, hub, 'wb');
    expect(b.s().title).toBe('pre-existing');
    b.s.title.set('and-back');
    flush();
    expect(a.s().title).toBe('and-back');
  });

  it('a dropped channel removes the peer and a re-link re-converges', () => {
    const relay = createRelay();
    const hub = fakeHub();
    const a = peer(relay, hub, 'wa');
    const b = peer(relay, hub, 'wb');
    expect(a.mesh.peers().length).toBe(1);

    b.mesh.close();
    expect(a.mesh.peers().length).toBe(0);

    a.s.title.set('while-b-gone');
    flush();

    const b2 = peer(relay, hub, 'wb');
    expect(a.mesh.peers().length).toBe(1);
    expect(b2.s().title).toBe('while-b-gone');
  });
});
