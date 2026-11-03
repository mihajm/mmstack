import { createRelay, type RelaySocket } from './relay';
import { validateDirect } from './validate';
import {
  MESH_PROTO_VERSION,
  type ClientDirectMsg,
  type ClientMsg,
  type ServerMsg,
} from './wire';

function socket() {
  const sent: ServerMsg[] = [];
  const sock: RelaySocket & { sent: ServerMsg[] } = {
    sent,
    send: (m) => sent.push(m),
    close: () => undefined,
  };
  return sock;
}

function client(
  relay: ReturnType<typeof createRelay>,
  writer: string,
  origin: string,
) {
  const sock = socket();
  const conn = relay.connect(sock, { writer });
  const hello = (seq?: number) =>
    conn.receive({
      t: 'hello',
      room: 'r',
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      seq,
    });
  const direct = (to: string, data: unknown, v = 1) =>
    conn.receive({ t: 'direct', room: 'r', to, v, data });
  const directs = () => sock.sent.filter((m) => m.t === 'direct');
  return { sock, conn, hello, direct, directs, origin };
}

const room = (relay: ReturnType<typeof createRelay>) => {
  const a = client(relay, 'wa', 'oa');
  a.hello();
  const b = client(relay, 'wb', 'ob');
  b.hello();
  const c = client(relay, 'wc', 'oc');
  c.hello();
  return { a, b, c };
};

describe('validateDirect', () => {
  const ok: ClientDirectMsg = {
    t: 'direct',
    room: 'r',
    to: 'ob',
    v: 0,
    data: null,
  };

  it('accepts a well-formed frame, including v 0 and null data', () => {
    expect(validateDirect(ok)).toBeNull();
  });

  it('names what is wrong with a malformed frame', () => {
    const bad = (over: object) =>
      ({ ...ok, ...over }) as unknown as ClientDirectMsg;
    expect(validateDirect(null as unknown as ClientDirectMsg)).toBe('frame');
    expect(validateDirect(bad({ to: undefined }))).toBe('to');
    expect(validateDirect(bad({ to: '' }))).toBe('to');
    expect(validateDirect(bad({ to: 'o\nb' }))).toBe('to');
    expect(validateDirect(bad({ v: undefined }))).toBe('v');
    expect(validateDirect(bad({ v: -1 }))).toBe('v');
    expect(validateDirect(bad({ v: 1.5 }))).toBe('v');
    expect(validateDirect(bad({ v: '1' }))).toBe('v');
    expect(validateDirect(bad({ v: Number.MAX_SAFE_INTEGER + 1 }))).toBe('v');
    const noData = { t: 'direct', room: 'r', to: 'ob', v: 0 };
    expect(validateDirect(noData as unknown as ClientDirectMsg)).toBe('data');
  });

  it('refuses `data: undefined`, which JSON could not carry, so every transport agrees', () => {
    expect(validateDirect({ ...ok, data: undefined })).toBe('data');
    const wire = JSON.parse(
      JSON.stringify({ ...ok, data: undefined }),
    ) as ClientDirectMsg;
    expect(validateDirect(wire)).toBe('data');
  });
});

describe('relay: direct frames', () => {
  it('reaches the addressed member and only it, stamped with the sender origin', () => {
    const { a, b, c } = room(createRelay());
    a.direct('ob', { ask: 1 });
    expect(b.directs()).toEqual([
      { t: 'direct', room: 'r', from: 'oa', v: 1, data: { ask: 1 } },
    ]);
    expect(a.directs()).toEqual([]);
    expect(c.directs()).toEqual([]);
    // a direct is never mistaken for a signal by the relay
    expect(b.sock.sent.some((m) => m.t === 'signal')).toBe(false);
  });

  it('a sender cannot forge `from`: the relay stamps the connection origin', () => {
    const { a, b } = room(createRelay());
    a.conn.receive({
      t: 'direct',
      room: 'r',
      to: 'ob',
      v: 1,
      data: 1,
      from: 'oc',
    } as unknown as ClientMsg);
    expect(b.directs()).toEqual([
      { t: 'direct', room: 'r', from: 'oa', v: 1, data: 1 },
    ]);
  });

  it('a frame addressed to self comes back to the sender, as signal does', () => {
    const { a, b, c } = room(createRelay());
    a.direct('oa', 'me');
    expect(a.directs()).toEqual([
      { t: 'direct', room: 'r', from: 'oa', v: 1, data: 'me' },
    ]);
    expect(b.directs()).toEqual([]);
    expect(c.directs()).toEqual([]);
  });

  it('reaches no one when `to` is not a member, or has left', () => {
    const { a, b, c } = room(createRelay());
    a.direct('nobody', 1);
    b.conn.disconnect();
    a.direct('ob', 2);
    for (const x of [a, b, c]) expect(x.directs()).toEqual([]);
    // no reply of any kind: the relay answers a lost direct exactly as a lost signal (silence)
    const tail = a.sock.sent.slice(-1)[0];
    expect(tail).toMatchObject({ t: 'member', origin: 'ob', gone: true });
  });

  it('drops malformed frames without a reply', () => {
    const { a, b, c } = room(createRelay());
    const before = a.sock.sent.length;
    const send = (over: object) =>
      a.conn.receive({
        t: 'direct',
        room: 'r',
        to: 'ob',
        v: 1,
        data: 1,
        ...over,
      } as ClientMsg);
    send({ to: undefined });
    send({ v: undefined });
    send({ v: -1 });
    send({ v: 2.5 });
    send({ v: '1' });
    a.conn.receive({
      t: 'direct',
      room: 'r',
      to: 'ob',
      v: 1,
    } as unknown as ClientMsg);
    for (const x of [b, c]) expect(x.directs()).toEqual([]);
    expect(a.sock.sent.length).toBe(before);
  });

  it('drops an in-process frame whose data is undefined, as JSON would', () => {
    const { a, b } = room(createRelay());
    a.direct('ob', undefined);
    expect(b.directs()).toEqual([]);
  });

  it('carries nothing for a connection that never joined, as signal does', () => {
    const relay = createRelay();
    const { b } = room(relay);
    const stranger = client(relay, 'ws', 'os');
    stranger.direct('ob', 1);
    expect(b.directs()).toEqual([]);
  });

  it('keeps the sender order on one connection', () => {
    const { a, b } = room(createRelay());
    for (let i = 0; i < 5; i++) a.direct('ob', i);
    expect(b.directs().map((m) => (m as { data: number }).data)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('is never persisted: no commit, and a fresh or returning member sees none in its welcome', () => {
    let commits = 0;
    const relay = createRelay({ onCommit: () => void commits++ });
    const { a, b } = room(relay);
    a.conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: (
          b.sock.sent.find((m) => m.t === 'welcome') as { instance: string }
        ).instance,
        origin: 'oa',
        writer: 'wa',
        version: 1,
        hlc: { p: 1, l: 0 },
        policyVersion: 0,
        ops: [{ kind: 'set', path: [], next: { doc: 1 }, cites: [], epoch: 0 }],
      },
    });
    expect(commits).toBe(1);
    a.direct('ob', { marker: 'ephemeral-xyz' });
    expect(commits).toBe(1);

    const fresh = client(relay, 'wd', 'od');
    fresh.hello();
    b.conn.disconnect();
    const back = client(relay, 'wb', 'ob');
    back.hello(0);
    for (const x of [fresh, back]) {
      const welcome = x.sock.sent.find((m) => m.t === 'welcome');
      expect(welcome).toBeDefined();
      expect(JSON.stringify(welcome)).not.toContain('ephemeral-xyz');
      expect(x.directs()).toEqual([]);
    }
  });

  it('passes immediately while a durability promise holds the room, as signal does', () => {
    let release!: () => void;
    const relay = createRelay({
      onCommit: () =>
        new Promise<void>((res) => {
          release = res;
        }),
    });
    const { a, b } = room(relay);
    a.conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: (
          a.sock.sent.find((m) => m.t === 'welcome') as { instance: string }
        ).instance,
        origin: 'oa',
        writer: 'wa',
        version: 1,
        hlc: { p: 1, l: 0 },
        policyVersion: 0,
        ops: [{ kind: 'set', path: [], next: {}, cites: [], epoch: 0 }],
      },
    });
    a.direct('ob', 'now');
    expect(b.directs()).toHaveLength(1);
    expect(b.sock.sent.some((m) => m.t === 'env')).toBe(false); // still held
    release();
  });
});
