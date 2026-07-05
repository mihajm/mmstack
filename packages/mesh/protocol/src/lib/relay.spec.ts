import { pathPrefixAcl, type PrincipalCtx } from './policy';
import { createRelay, type RelaySocket } from './relay';
import {
  MESH_PROTO_VERSION,
  type OpEnvelope,
  type SeqEnvelope,
  type ServerMsg,
  type StoreOp,
} from './wire';

function socket() {
  const sent: ServerMsg[] = [];
  const sock: RelaySocket & { sent: ServerMsg[]; closed: boolean } = {
    sent,
    closed: false,
    send: (m) => sent.push(m),
    close: () => {
      sock.closed = true;
    },
  };
  return sock;
}

function client(
  relay: ReturnType<typeof createRelay>,
  writer: string,
  origin: string,
  ctx?: Partial<PrincipalCtx>,
) {
  const sock = socket();
  const conn = relay.connect(sock, { writer, ...ctx });
  let version = 0;
  let p = 0;
  const hello = (seq?: number) =>
    conn.receive({
      t: 'hello',
      room: 'r',
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      seq,
    });
  const env = (ops: StoreOp[], over?: Partial<OpEnvelope>) =>
    conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        origin,
        writer,
        version: ++version,
        hlc: { p: ++p, l: 0 },
        policyVersion: 0,
        ops,
        ...over,
      },
    });
  return { sock, conn, hello, env };
}

const set = (path: (string | number)[], next: unknown): StoreOp => ({
  kind: 'set',
  path,
  next,
});

const last = (sock: ReturnType<typeof socket>) => sock.sent[sock.sent.length - 1];

describe('createRelay', () => {
  it('answers up-to-date on a fresh room; a later joiner gets the seeded snapshot', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');

    a.hello();
    expect(last(a.sock)).toMatchObject({ t: 'welcome', mode: 'up-to-date', seq: 0 });

    a.env([set([], { todos: ['x'] })]);
    a.env([set(['title'], 'hi')]);

    const b = client(relay, 'wb', 'ob');
    b.hello();
    expect(last(b.sock)).toMatchObject({
      t: 'welcome',
      mode: 'snapshot',
      seq: 2,
      root: { todos: ['x'], title: 'hi' },
    });
  });

  it('assigns monotonic seq and echoes to EVERY member including the sender (the ack)', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.env([set(['x'], 1)]);
    a.env([set(['x'], 2)]);

    const seqsAtA = a.sock.sent.filter((m) => m.t === 'env').map((m) => m.env.seq);
    const seqsAtB = b.sock.sent.filter((m) => m.t === 'env').map((m) => m.env.seq);
    expect(seqsAtA).toEqual([1, 2]);
    expect(seqsAtB).toEqual([1, 2]);
  });

  it('answers delta to a reconnecting client with a covered watermark', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set(['v'], 1)]);
    a.env([set(['v'], 2)]);

    const b = client(relay, 'wb', 'ob');
    b.hello(1);
    const welcome = last(b.sock);
    expect(welcome).toMatchObject({ t: 'welcome', mode: 'delta', seq: 3 });
    expect(
      (welcome as { envs: { seq: number }[] }).envs.map((e) => e.seq),
    ).toEqual([2, 3]);
  });

  it('falls back to snapshot when the journal no longer covers the watermark, folding deletes', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { keep: 1, drop: 2 })]);
    a.env([{ kind: 'delete', path: ['drop'], prev: 2 }]);
    a.env([set(['keep'], 10)]);
    a.env([set(['keep'], 11)]);

    const b = client(relay, 'wb', 'ob');
    b.hello(1);
    expect(last(b.sock)).toMatchObject({
      t: 'welcome',
      mode: 'snapshot',
      seq: 4,
      root: { keep: 11 },
    });
  });

  it('rejects a proto mismatch and a policy-version mismatch at hello', () => {
    const relay = createRelay({ policyVersion: 3 });
    const sock = socket();
    const conn = relay.connect(sock, { writer: 'w' });

    conn.receive({ t: 'hello', room: 'r', origin: 'o', proto: 99, policyVersion: 3 });
    expect(last(sock)).toMatchObject({ t: 'reject', reason: 'proto', expected: MESH_PROTO_VERSION });

    conn.receive({ t: 'hello', room: 'r', origin: 'o', proto: MESH_PROTO_VERSION, policyVersion: 0 });
    expect(last(sock)).toMatchObject({ t: 'reject', reason: 'policy-version', expected: 3 });
  });

  it('tripwire: a policy violation ejects the writer, closes it, blacklists rejoin', () => {
    const violations: unknown[] = [];
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
      onViolation: (_room, v) => violations.push(v),
    });
    const good = client(relay, 'wg', 'og');
    const bad = client(relay, 'wb', 'ob');
    good.hello();
    bad.hello();

    bad.env([set(['admin', 'x'], 1)]);

    expect(violations).toEqual([
      { writer: 'wb', reason: 'can-write', path: ['admin', 'x'] },
    ]);
    expect(good.sock.sent.some((m) => m.t === 'eject' && m.writer === 'wb')).toBe(true);
    expect(bad.sock.closed).toBe(true);

    bad.env([set(['ok'], 1)]);
    expect(good.sock.sent.filter((m) => m.t === 'env')).toEqual([]);

    const again = client(relay, 'wb', 'ob2');
    again.hello();
    expect(last(again.sock)).toMatchObject({ t: 'reject', reason: 'unauthorized' });
  });

  it('tripwire: an envelope claiming a foreign writer is a writer-mismatch ejection', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['x'], 1)], { writer: 'someone-else' });

    expect(a.sock.closed).toBe(true);
  });

  it('enforces ops-limit and the per-writer rate bucket with an injected clock', () => {
    let at = 0;
    const relay = createRelay({
      limits: { maxOpsPerEnvelope: 2, maxEnvelopesPerSecond: 2 },
      now: () => at,
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['a'], 1), set(['b'], 2), set(['c'], 3)]);
    expect(a.sock.closed).toBe(true);

    const b = client(relay, 'wb', 'ob');
    b.hello();
    b.env([set(['x'], 1)]);
    b.env([set(['x'], 2)]);
    b.env([set(['x'], 3)]);
    b.env([set(['x'], 4)]);
    b.env([set(['x'], 5)]);
    expect(b.sock.closed).toBe(true);

    at = 10_000;
    const c = client(relay, 'wc', 'oc');
    c.hello();
    c.env([set(['x'], 9)]);
    expect(c.sock.closed).toBe(false);
  });

  it('fans presence out to others (not the sender), rosters it in welcome, drops on disconnect', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.conn.receive({ t: 'presence', room: 'r', data: { cursor: [1, 2] } });
    expect(b.sock.sent.some((m) => m.t === 'presence' && !m.gone)).toBe(true);
    expect(a.sock.sent.some((m) => m.t === 'presence')).toBe(false);

    const c = client(relay, 'wc', 'oc');
    c.hello();
    const welcome = last(c.sock) as { peers: readonly { origin: string }[] };
    expect(welcome.peers.map((p) => p.origin)).toEqual(['oa']);

    a.conn.disconnect();
    expect(
      b.sock.sent.some((m) => m.t === 'presence' && m.gone && m.peer.origin === 'oa'),
    ).toBe(true);
  });
});

describe('createRelay: reconnection edges', () => {
  it("a zombie connection's late close cannot kill a reconnected member's fresh presence", () => {
    const relay = createRelay();
    const observer = client(relay, 'wo', 'oo');
    observer.hello();

    const old = client(relay, 'wa', 'oa');
    old.hello();

    const fresh = client(relay, 'wa', 'oa');
    fresh.hello();
    expect(old.sock.closed).toBe(true);

    fresh.conn.receive({ t: 'presence', room: 'r', data: { here: true } });
    const gonesBefore = observer.sock.sent.filter((m) => m.t === 'presence' && m.gone).length;

    old.conn.disconnect();

    const gonesAfter = observer.sock.sent.filter((m) => m.t === 'presence' && m.gone).length;
    expect(gonesAfter).toBe(gonesBefore);

    const roster = client(relay, 'wr', 'or');
    roster.hello();
    expect(
      (last(roster.sock) as { peers: readonly { origin: string }[] }).peers.map((p) => p.origin),
    ).toEqual(['oa']);
  });

  it('routes signaling payloads to the addressed origin and broadcasts membership', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    const b = client(relay, 'wb', 'ob');
    b.hello();

    expect(a.sock.sent.some((m) => m.t === 'member' && m.origin === 'ob')).toBe(true);
    expect((last(b.sock) as { members: string[] }).members).toEqual(['oa']);

    a.conn.receive({ t: 'signal', room: 'r', to: 'ob', data: { offer: 1 } });
    const sig = b.sock.sent.find((m) => m.t === 'signal');
    expect(sig).toMatchObject({ t: 'signal', from: 'oa', data: { offer: 1 } });
    expect(a.sock.sent.some((m) => m.t === 'signal')).toBe(false);

    a.conn.disconnect();
    expect(b.sock.sent.some((m) => m.t === 'member' && m.gone && m.origin === 'oa')).toBe(true);
  });

  it('welcome carries a stable epoch per room instance', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    const b = client(relay, 'wb', 'ob');
    b.hello();

    const welcomeEpoch = (sock: ReturnType<typeof socket>) =>
      (sock.sent.find((m) => m.t === 'welcome') as { epoch: string }).epoch;
    const epochA = welcomeEpoch(a.sock);
    const epochB = welcomeEpoch(b.sock);
    expect(epochA).toBe(epochB);
    expect(epochA.length).toBeGreaterThan(0);

    const other = createRelay();
    const c = client(other, 'wc', 'oc');
    c.hello();
    expect(welcomeEpoch(c.sock)).not.toBe(epochA);
  });
});

describe('createRelay: persistence seam', () => {
  it('onCommit fires per sequenced envelope with the folded room state', () => {
    const commits: { env: { seq: number }; state: { seq: number; root: unknown } }[] = [];
    const relay = createRelay({
      onCommit: (_room, env, state) => commits.push({ env, state }),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set(['v'], 1)]);

    expect(commits.map((c) => c.env.seq)).toEqual([1, 2]);
    expect(commits[1].state).toMatchObject({ seq: 2, root: { v: 1 } });
  });

  it('onCommit does not fire for a rejected envelope', () => {
    const commits: unknown[] = [];
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
      onCommit: (_room, env) => commits.push(env),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['admin'], 1)]);

    expect(commits).toEqual([]);
    expect(a.sock.closed).toBe(true);
  });

  it('round-trips a room through onCommit capture and hydrate on a fresh relay', () => {
    let saved: { seq: number; epoch: string; root: unknown; journal: SeqEnvelope[] } = {
      seq: 0,
      epoch: '',
      root: undefined,
      journal: [],
    };
    const relay = createRelay({
      onCommit: (_room, env, state) => {
        saved = { ...state, journal: [...saved.journal, env] };
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set(['v'], 1)]);
    a.env([set(['v'], 2)]);

    // the relay dies; a new instance restores the persisted room
    const revived = createRelay();
    expect(revived.hydrate('r', saved)).toBe(true);
    expect(revived.room('r')).toMatchObject({ seq: 3, journal: 3 });

    // reconnecting client kept its watermark: restored epoch means delta, not snapshot
    const back = client(revived, 'wa', 'oa');
    back.hello(2);
    const welcome = last(back.sock);
    expect(welcome).toMatchObject({ t: 'welcome', mode: 'delta', seq: 3, epoch: saved.epoch });
    expect((welcome as { envs: { seq: number }[] }).envs.map((e) => e.seq)).toEqual([3]);

    // a fresh joiner gets the restored snapshot
    const fresh = client(revived, 'wf', 'of');
    fresh.hello();
    expect(last(fresh.sock)).toMatchObject({
      t: 'welcome',
      mode: 'snapshot',
      seq: 3,
      root: { v: 2 },
    });

    // and writes continue the restored seq space
    back.env([set(['v'], 3)]);
    const envs = fresh.sock.sent.filter((m) => m.t === 'env').map((m) => m.env.seq);
    expect(envs).toEqual([4]);
  });

  it('hydrate without a journal answers snapshot to stale watermarks; without an epoch it mints fresh', () => {
    const relay = createRelay();
    expect(relay.hydrate('r', { seq: 5, root: { v: 5 } })).toBe(true);

    const a = client(relay, 'wa', 'oa');
    a.hello(3);
    const welcome = last(a.sock) as { mode: string; epoch: string; root?: unknown };
    expect(welcome).toMatchObject({ mode: 'snapshot', seq: 5, root: { v: 5 } });
    expect(welcome.epoch.length).toBeGreaterThan(0);
  });

  it('refuses to hydrate a touched room', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    // members but no state yet: still refused (they were told seq 0)
    expect(relay.hydrate('r', { seq: 5, root: {} })).toBe(false);

    a.env([set([], { v: 0 })]);
    expect(relay.hydrate('r', { seq: 5, root: {} })).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
  });

  it('hydrate drops journal entries above seq and caps to journalLimit', () => {
    const mkEnv = (seq: number) => ({
      proto: MESH_PROTO_VERSION,
      origin: 'o',
      writer: 'w',
      version: seq,
      hlc: { p: seq, l: 0 },
      policyVersion: 0,
      ops: [set(['v'], seq)],
      seq,
    });
    const relay = createRelay({ journalLimit: 2 });
    relay.hydrate('r', {
      seq: 4,
      root: { v: 4 },
      journal: [mkEnv(2), mkEnv(4), mkEnv(3), mkEnv(9)],
    });
    expect(relay.room('r')).toMatchObject({ seq: 4, journal: 2 });

    // the kept tail is [3, 4]: a watermark of 2 is covered, delta answers [3, 4]
    const a = client(relay, 'wa', 'oa');
    a.hello(2);
    const welcome = last(a.sock);
    expect(welcome).toMatchObject({ mode: 'delta' });
    expect((welcome as { envs: { seq: number }[] }).envs.map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe('pathPrefixAcl', () => {
  const acl = pathPrefixAcl([
    { prefix: ['notes'], allow: () => true },
    { prefix: ['cases', '*', 'plan'], allow: (ctx) => ctx.kind !== 'agent' },
  ]);

  it('grants by prefix, denies outside any rule, and can discriminate agents', () => {
    const human: PrincipalCtx = { writer: 'h', kind: 'human' };
    const agent: PrincipalCtx = { writer: 'a', kind: 'agent' };

    const canWrite = acl.canWrite;
    if (!canWrite) throw new Error('pathPrefixAcl must define canWrite');
    expect(canWrite(human, ['notes', 3, 'text'])).toBe(true);
    expect(canWrite(human, ['cases', 'c1', 'plan', 'step'])).toBe(true);
    expect(canWrite(agent, ['cases', 'c1', 'plan', 'step'])).toBe(false);
    expect(canWrite(agent, ['notes', 0])).toBe(true);
    expect(canWrite(human, ['admin'])).toBe(false);
  });

  it('isolates rooms on one relay: envelopes and sequencing do not leak across rooms', () => {
    const relay = createRelay();
    const mk = (writer: string, origin: string) => {
      const sock = socket();
      const conn = relay.connect(sock, { writer });
      return { sock, conn, origin, writer };
    };
    const helloTo = (c: ReturnType<typeof mk>, room: string) =>
      c.conn.receive({
        t: 'hello',
        room,
        origin: c.origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
    const writeTo = (
      c: ReturnType<typeof mk>,
      room: string,
      ops: StoreOp[],
      version: number,
    ) =>
      c.conn.receive({
        t: 'env',
        room,
        env: {
          proto: MESH_PROTO_VERSION,
          origin: c.origin,
          writer: c.writer,
          version,
          hlc: { p: version, l: 0 },
          policyVersion: 0,
          ops,
        },
      });
    const envsAt = (c: ReturnType<typeof mk>) =>
      c.sock.sent.filter((m) => m.t === 'env') as {
        t: 'env';
        env: { seq: number; ops: StoreOp[] };
      }[];

    const a = mk('wa', 'oa');
    const b = mk('wb', 'ob');
    const c = mk('wc', 'oc');
    helloTo(a, 'r1');
    helloTo(b, 'r1');
    helloTo(c, 'r2');

    writeTo(a, 'r1', [set(['x'], 1)], 1);
    expect(envsAt(b)).toHaveLength(1);
    expect(envsAt(b)[0].env.ops).toEqual([set(['x'], 1)]);
    expect(envsAt(c)).toHaveLength(0);

    writeTo(c, 'r2', [set(['y'], 2)], 1);
    expect(envsAt(a).some((e) => e.env.ops[0].path[0] === 'y')).toBe(false);
    expect(envsAt(b)[0].env.seq).toBe(envsAt(c)[0].env.seq);
  });
});
