import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  type ClientMsg,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import { store } from '@mmstack/primitives/core';
import { meshSync, type MeshSyncOptions } from './mesh-sync';
import { directTransport, type MeshTransportFactory } from './transport';
import { installFakeLocks } from './testing/fake-locks';

const peer = (
  transport: MeshTransportFactory,
  options: Partial<MeshSyncOptions> = {},
) =>
  TestBed.runInInjectionContext(() =>
    meshSync(store({ title: 'initial' }), {
      room: 'm',
      writer: 'w',
      transport,
      ...options,
    }),
  );

async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    TestBed.tick();
  }
}

function wire() {
  let receive!: (msg: ServerMsg) => void;
  let disconnect!: () => void;
  const sent: ClientMsg[] = [];
  const transport: MeshTransportFactory = () => ({
    send: (msg) => {
      sent.push(msg);
    },
    onMessage: (cb) => {
      receive = cb;
      return () => undefined;
    },
    onClose: (cb) => {
      disconnect = cb;
      return () => undefined;
    },
    close: () => undefined,
  });
  return {
    transport,
    sent,
    receive: (msg: ServerMsg) => receive(msg),
    disconnect: () => disconnect(),
  };
}

const welcome = (members: string[]): ServerMsg => ({
  t: 'welcome',
  room: 'm',
  instance: 'i',
  mode: 'delta',
  seq: 0,
  envs: [],
  peers: [],
  members,
  schemaVersion: 0,
});

describe('meshSync identity and membership', () => {
  it('keeps origin null until hello and publishes the origin actually sent', async () => {
    const socket = wire();
    let ready!: () => void;
    const mesh = peer(socket.transport, {
      whenReady: () =>
        new Promise<void>((r) => {
          ready = r;
        }),
    });
    expect(mesh.origin()).toBeNull();
    expect(mesh.members()).toEqual([]);
    await settle();
    ready();
    await settle();
    const hello = socket.sent.find((msg) => msg.t === 'hello');
    expect(hello?.origin).toBe(mesh.origin());
    expect(mesh.origin()).toEqual(expect.any(String));
    mesh.close();
  });

  it('tracks quiet members independently of presence and removes departed members', async () => {
    const relay = createRelay();
    const connect = directTransport(relay, { writer: 'w' });
    const a = peer(connect);
    await settle();
    const b = peer(connect);
    await settle();
    expect(a.members()).toEqual([b.origin()]);
    expect(b.members()).toEqual([a.origin()]);
    expect(a.peers()).toEqual([]);
    expect(b.peers()).toEqual([]);
    b.close();
    await settle();
    expect(a.members()).toEqual([]);
    expect(b.members()).toEqual([]);
    a.close();
  });

  it('clears membership on disconnect and replaces it on reconnect without changing origin', async () => {
    vi.useFakeTimers();
    try {
      const socket = wire();
      const mesh = peer(socket.transport);
      const origin = mesh.origin();
      socket.receive(welcome(['a', 'b']));
      socket.receive({ t: 'member', room: 'm', origin: 'a' });
      expect(mesh.members()).toEqual(['a', 'b']);
      socket.disconnect();
      expect(mesh.members()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mesh.origin()).toBe(origin);
      socket.receive(welcome(['c']));
      expect(mesh.members()).toEqual(['c']);
      socket.receive({ t: 'reject', room: 'm', reason: 'proto' });
      expect(mesh.members()).toEqual([]);
      mesh.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the new boot origin after an outbox handoff, never the persisted origin', async () => {
    const locks = installFakeLocks();
    try {
      let saved: unknown = { origin: 'old', version: 0, envs: [] };
      const outbox = {
        key: 'members',
        store: {
          get: () => saved,
          set: (_key: string, value: unknown) => {
            saved = value;
          },
          del: () => {
            saved = undefined;
          },
        },
      };
      const relay = createRelay();
      const connect = directTransport(relay, { writer: 'w' });
      const a = peer(connect, { outbox });
      expect(a.origin()).toBeNull();
      await settle();
      expect(a.origin()).not.toBe('old');
      const b = peer(connect, { outbox });
      await settle();
      expect(b.origin()).toBeNull();
      expect(b.members()).toEqual([]);
      a.close();
      await settle();
      expect(b.origin()).toEqual(expect.any(String));
      expect(b.origin()).not.toBe(a.origin());
      expect((saved as { origin: string }).origin).toBe(b.origin());
      b.close();
    } finally {
      locks.restore();
    }
  });
});

describe('meshSync shared signaling', () => {
  it('replays early offers once, isolates listeners, and sends on the current socket without another hello', async () => {
    vi.useFakeTimers();
    try {
      const first = wire();
      const second = wire();
      let connections = 0;
      const mesh = peer(() =>
        (++connections === 1 ? first : second).transport(),
      );
      first.receive(welcome(['a']));
      const offer: ServerMsg = {
        t: 'signal',
        room: 'm',
        from: 'a',
        data: 'offer',
      };
      first.receive(offer);
      const seen: ServerMsg[] = [];
      const unsubBad = mesh.signaling.onMessage(() => {
        throw new Error('broken link');
      });
      const unsub = mesh.signaling.onMessage((msg) => seen.push(msg));
      expect(seen).toEqual([]); // early offers belong to the first listener only
      expect(mesh.signaling.members()).toEqual(['a']);
      first.receive(offer);
      expect(seen).toEqual([offer]);
      const answer = {
        t: 'signal' as const,
        room: 'm',
        to: 'a',
        data: 'answer',
      };
      mesh.signaling.send(answer);
      expect(first.sent.at(-1)).toEqual(answer);
      first.disconnect();
      expect(mesh.signaling.members()).toBeUndefined();
      // a socket drop retires no links: the next welcome says who is still there
      expect(seen.at(-1)).toEqual(offer);
      await vi.advanceTimersByTimeAsync(1000);
      second.receive(welcome(['b']));
      mesh.signaling.send({ ...answer, to: 'b' });
      expect(second.sent.at(-1)).toEqual({ ...answer, to: 'b' });
      expect(first.sent.filter((msg) => msg.t === 'hello')).toHaveLength(1);
      expect(second.sent.filter((msg) => msg.t === 'hello')).toHaveLength(1);
      // A retired socket cannot change membership or feed stale signaling to links.
      first.receive(welcome(['stale']));
      expect(mesh.members()).toEqual(['b']);
      mesh.close();
      // the session's end is what retires the links riding on its port
      expect(seen.at(-1)).toEqual({
        t: 'member',
        room: 'm',
        origin: 'b',
        gone: true,
      });
      const before = second.sent.length;
      mesh.signaling.send(answer);
      expect(second.sent).toHaveLength(before);
      unsub();
      unsubBad();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires links from the last roster when the session ends while disconnected', async () => {
    vi.useFakeTimers();
    try {
      const socket = wire();
      const mesh = peer(socket.transport);
      socket.receive(welcome(['a', 'b']));
      socket.receive({ t: 'member', room: 'm', origin: 'a', gone: true });
      const seen: ServerMsg[] = [];
      const unsub = mesh.signaling.onMessage((msg) => seen.push(msg));
      socket.disconnect();
      expect(mesh.members()).toEqual([]);
      expect(seen).toEqual([]); // the drop itself retires nothing
      mesh.close(); // ends before any reconnect welcome
      expect(seen).toEqual([
        { t: 'member', room: 'm', origin: 'b', gone: true },
      ]);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers bounded early offers, drops departed peers and rejects cross-room traffic', () => {
    const socket = wire();
    const mesh = peer(socket.transport);
    socket.receive(welcome(['a', 'b']));
    socket.receive({ t: 'signal', room: 'other', from: 'a', data: 'foreign' });
    socket.receive({ t: 'signal', room: 'm', from: 'a', data: 'departed' });
    socket.receive({ t: 'member', room: 'm', origin: 'a', gone: true });
    for (let i = 0; i < 300; i++) {
      socket.receive({ t: 'signal', room: 'm', from: 'b', data: i });
    }
    const seen: ServerMsg[] = [];
    const unsub = mesh.signaling.onMessage((msg) => seen.push(msg));
    expect(seen).toHaveLength(256);
    expect(seen[0]).toEqual({ t: 'signal', room: 'm', from: 'b', data: 0 });
    const before = socket.sent.length;
    mesh.signaling.send({
      t: 'signal',
      room: 'other',
      to: 'b',
      data: 'wrong room',
    });
    expect(socket.sent).toHaveLength(before);
    unsub();
    mesh.close();
  });

  it('clears early offers when a fresh welcome replaces membership', () => {
    const socket = wire();
    const mesh = peer(socket.transport);
    socket.receive(welcome(['a']));
    socket.receive({ t: 'signal', room: 'm', from: 'a', data: 'stale offer' });
    socket.receive(welcome(['b']));
    const seen: ServerMsg[] = [];
    const unsub = mesh.signaling.onMessage((msg) => seen.push(msg));
    expect(seen).toEqual([]);
    expect(mesh.signaling.members()).toEqual(['b']);
    unsub();
    mesh.close();
  });
});
