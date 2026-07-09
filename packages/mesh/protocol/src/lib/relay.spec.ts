import { pathPrefixAcl, type PrincipalCtx } from './policy';
import { createRegisterStore } from './register';
import { createRelay, type RelaySocket } from './relay';
import {
  MESH_PROTO_VERSION,
  type Dot,
  type Key,
  type OpEnvelope,
  type RegisterCheckpoint,
  type SeqEnvelope,
  type ServerMsg,
  type SyncOp,
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
  const env = (ops: SyncOp[], over?: Partial<OpEnvelope>) =>
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

// an uncited op is a CONCURRENT write; causal succession must cite the superseded dot(s)
const set = (
  path: (string | number)[],
  next: unknown,
  meta?: { cites?: Dot[]; epoch?: number },
): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites: meta?.cites ?? [],
  epoch: meta?.epoch ?? 0,
});
const del = (
  path: (string | number)[],
  prev: unknown,
  meta?: { cites?: Dot[]; epoch?: number },
): SyncOp => ({
  kind: 'delete',
  path,
  prev,
  cites: meta?.cites ?? [],
  epoch: meta?.epoch ?? 0,
});
const clr = (
  path: (string | number)[],
  meta?: { cites?: Dot[]; epoch?: number },
): SyncOp => ({
  kind: 'clear',
  path,
  cites: meta?.cites ?? [],
  epoch: meta?.epoch ?? 0,
});

const last = (sock: ReturnType<typeof socket>) =>
  sock.sent[sock.sent.length - 1];

const snapshotOf = (sock: ReturnType<typeof socket>) => {
  const welcome = [...sock.sent]
    .reverse()
    .find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
  if (welcome.mode !== 'snapshot') {
    throw new Error(`expected snapshot welcome, got ${welcome.mode}`);
  }
  return welcome;
};

const regAt = (
  registers: readonly RegisterCheckpoint[],
  path: readonly Key[],
): RegisterCheckpoint | undefined =>
  registers.find((r) => r.path.join('') === path.join(''));

describe('createRelay', () => {
  it('answers up-to-date on a fresh room; a later joiner gets the seeded register state (never a folded value)', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');

    a.hello();
    expect(last(a.sock)).toMatchObject({
      t: 'welcome',
      mode: 'up-to-date',
      seq: 0,
    });

    a.env([set([], { todos: ['x'] })]);
    a.env([set(['title'], 'hi')]);

    const b = client(relay, 'wb', 'ob');
    b.hello();
    const welcome = snapshotOf(b.sock);
    expect(welcome.seq).toBe(2);
    expect(welcome.wm).toEqual({ oa: 2 });
    // register state per path: the retained op, not a materialized tree
    const root = regAt(welcome.registers, []);
    expect(root?.siblings).toEqual([
      expect.objectContaining({
        kind: 'set',
        value: { todos: ['x'] },
        origin: 'oa',
        writer: 'wa',
        epoch: 0,
      }),
    ]);
    expect(regAt(welcome.registers, ['title'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'set', value: 'hi', origin: 'oa' }),
    ]);
  });

  it('assigns monotonic seq and echoes to EVERY member including the sender (the ack)', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.env([set(['x'], 1)]);
    a.env([set(['x'], 2)]);

    const seqsAtA = a.sock.sent
      .filter((m) => m.t === 'env')
      .map((m) => m.env.seq);
    const seqsAtB = b.sock.sent
      .filter((m) => m.t === 'env')
      .map((m) => m.env.seq);
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
      (welcome as unknown as { envs: { seq: number }[] }).envs.map(
        (e) => e.seq,
      ),
    ).toEqual([2, 3]);
  });

  it('falls back to snapshot when the journal no longer covers the watermark; a cited tombstone rides the register state', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { keep: 1, drop: 2 })]);
    a.env([del(['drop'], 2)]);
    a.env([set(['keep'], 10)]);
    a.env([set(['keep'], 11)]);

    const b = client(relay, 'wb', 'ob');
    b.hello(1);
    const welcome = snapshotOf(b.sock);
    expect(welcome.seq).toBe(4);
    // the tombstone is RETAINED (not silently folded away): the root register's live value
    // still contains `drop`, so dropping the tombstone would resurrect the key on a joiner
    expect(regAt(welcome.registers, ['drop'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'delete', origin: 'oa' }),
    ]);
    expect(regAt(welcome.registers, ['keep'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'set', value: 11 }),
    ]);
    expect(regAt(welcome.registers, [])?.siblings[0]).toMatchObject({
      kind: 'set',
      value: { keep: 1, drop: 2 },
    });
  });

  it('compaction drops a below-frontier lone tombstone once nothing else materializes its key', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], {})]); // seed: the root value never contained the key
    a.env([set(['items', 'a'], 1)]);
    // the delete cites the set's dot (causal succession), so the set is superseded
    a.env([
      del(['items', 'a'], 1, {
        cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
      }),
    ]);
    a.env([set(['other'], 1)]);
    a.env([set(['other'], 2)]); // pushes the delete envelope past the journal window

    const b = client(relay, 'wb', 'ob');
    b.hello();
    const welcome = snapshotOf(b.sock);
    expect(regAt(welcome.registers, ['items', 'a'])).toBeUndefined();
    expect(regAt(welcome.registers, ['other'])?.siblings[0]).toMatchObject({
      kind: 'set',
      value: 2,
    });
  });

  it('rejects a proto mismatch and a policy-version mismatch at hello', () => {
    const relay = createRelay({ policyVersion: 3 });
    const sock = socket();
    const conn = relay.connect(sock, { writer: 'w' });

    conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'o',
      proto: 99,
      policyVersion: 3,
    });
    expect(last(sock)).toMatchObject({
      t: 'reject',
      reason: 'proto',
      expected: MESH_PROTO_VERSION,
    });

    conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'o',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });
    expect(last(sock)).toMatchObject({
      t: 'reject',
      reason: 'policy-version',
      expected: 3,
    });
  });

  it('rejects a pre-citation emitter per envelope: a stale-proto envelope is a proto violation, never merged', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['x'], 1)], { proto: MESH_PROTO_VERSION - 1 });
    expect(a.sock.closed).toBe(true);
    expect(relay.room('r')).toMatchObject({ seq: 0 });
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
    expect(
      good.sock.sent.some((m) => m.t === 'eject' && m.writer === 'wb'),
    ).toBe(true);
    expect(bad.sock.closed).toBe(true);

    bad.env([set(['ok'], 1)]);
    expect(good.sock.sent.filter((m) => m.t === 'env')).toEqual([]);

    const again = client(relay, 'wb', 'ob2');
    again.hello();
    expect(last(again.sock)).toMatchObject({
      t: 'reject',
      reason: 'unauthorized',
    });
  });

  it('a clear IS a write at its path for ACL purposes', () => {
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['mine'], { x: 1 }), clr(['admin', 'x'])]);
    expect(a.sock.closed).toBe(true);
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

  it('an honest subtree replace (one set + a clear per observed descendant) passes the DEFAULT ops limit', () => {
    const relay = createRelay(); // default maxOpsPerEnvelope: 1024
    const a = client(relay, 'wa', 'oa');
    a.hello();
    const rows = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`r${i}`, i]),
    );
    a.env([set([], { rows })]);
    a.env([
      set(['rows'], {}),
      ...Array.from({ length: 500 }, (_, i) => clr(['rows', `r${i}`])),
    ]);
    expect(a.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 2 });
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
      b.sock.sent.some(
        (m) => m.t === 'presence' && m.gone && m.peer.origin === 'oa',
      ),
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
    const gonesBefore = observer.sock.sent.filter(
      (m) => m.t === 'presence' && m.gone,
    ).length;

    old.conn.disconnect();

    const gonesAfter = observer.sock.sent.filter(
      (m) => m.t === 'presence' && m.gone,
    ).length;
    expect(gonesAfter).toBe(gonesBefore);

    const roster = client(relay, 'wr', 'or');
    roster.hello();
    expect(
      (last(roster.sock) as { peers: readonly { origin: string }[] }).peers.map(
        (p) => p.origin,
      ),
    ).toEqual(['oa']);
  });

  it('routes signaling payloads to the addressed origin and broadcasts membership', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    const b = client(relay, 'wb', 'ob');
    b.hello();

    expect(a.sock.sent.some((m) => m.t === 'member' && m.origin === 'ob')).toBe(
      true,
    );
    expect((last(b.sock) as unknown as { members: string[] }).members).toEqual([
      'oa',
    ]);

    a.conn.receive({ t: 'signal', room: 'r', to: 'ob', data: { offer: 1 } });
    const sig = b.sock.sent.find((m) => m.t === 'signal');
    expect(sig).toMatchObject({ t: 'signal', from: 'oa', data: { offer: 1 } });
    expect(a.sock.sent.some((m) => m.t === 'signal')).toBe(false);

    a.conn.disconnect();
    expect(
      b.sock.sent.some((m) => m.t === 'member' && m.gone && m.origin === 'oa'),
    ).toBe(true);
  });

  it('welcome carries a stable instance nonce per room incarnation', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    const b = client(relay, 'wb', 'ob');
    b.hello();

    const welcomeInstance = (sock: ReturnType<typeof socket>) =>
      (sock.sent.find((m) => m.t === 'welcome') as { instance: string })
        .instance;
    const instanceA = welcomeInstance(a.sock);
    const instanceB = welcomeInstance(b.sock);
    expect(instanceA).toBe(instanceB);
    expect(instanceA.length).toBeGreaterThan(0);

    const other = createRelay();
    const c = client(other, 'wc', 'oc');
    c.hello();
    expect(welcomeInstance(c.sock)).not.toBe(instanceA);
  });
});

describe('createRelay: persistence seam', () => {
  it('onCommit fires per sequenced envelope with the retained register state', () => {
    const commits: {
      env: { seq: number };
      state: {
        seq: number;
        registers: readonly RegisterCheckpoint[];
        wm: Readonly<Record<string, number>>;
      };
    }[] = [];
    const relay = createRelay({
      onCommit: (_room, env, state) => commits.push({ env, state }),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set(['v'], 1)]);

    expect(commits.map((c) => c.env.seq)).toEqual([1, 2]);
    expect(commits[1].state.seq).toBe(2);
    expect(commits[1].state.wm).toEqual({ oa: 2 });
    expect(regAt(commits[1].state.registers, ['v'])?.siblings[0]).toMatchObject(
      { kind: 'set', value: 1 },
    );
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
    let saved: {
      seq: number;
      instance: string;
      registers: readonly RegisterCheckpoint[];
      wm: Readonly<Record<string, number>>;
      journal: SeqEnvelope[];
    } = {
      seq: 0,
      instance: '',
      registers: [],
      wm: {},
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

    // reconnecting client kept its watermark: restored instance means delta, not snapshot
    const back = client(revived, 'wa', 'oa');
    back.hello(2);
    const welcome = last(back.sock);
    expect(welcome).toMatchObject({
      t: 'welcome',
      mode: 'delta',
      seq: 3,
      instance: saved.instance,
    });
    expect(
      (welcome as unknown as { envs: { seq: number }[] }).envs.map(
        (e) => e.seq,
      ),
    ).toEqual([3]);

    // a fresh joiner gets the restored register state
    const fresh = client(revived, 'wf', 'of');
    fresh.hello();
    const freshWelcome = snapshotOf(fresh.sock);
    expect(freshWelcome.wm).toEqual({ oa: 3 });
    expect(regAt(freshWelcome.registers, ['v'])?.siblings[0]).toMatchObject({
      kind: 'set',
      value: 2,
    });

    // and writes continue the restored seq space
    back.env([set(['v'], 3)]);
    const envs = fresh.sock.sent
      .filter((m) => m.t === 'env')
      .map((m) => m.env.seq);
    expect(envs).toEqual([4]);
  });

  it('hydrate without a journal answers snapshot to stale watermarks; without an instance it mints fresh', () => {
    const relay = createRelay();
    const registers: RegisterCheckpoint[] = [
      {
        path: [],
        siblings: [
          {
            kind: 'set',
            value: { v: 5 },
            writer: 'w',
            origin: 'o',
            hlc: { p: 5, l: 0 },
            epoch: 0,
          },
        ],
        water: {},
      },
    ];
    expect(relay.hydrate('r', { seq: 5, registers, wm: { o: 5 } })).toBe(true);

    const a = client(relay, 'wa', 'oa');
    a.hello(3);
    const welcome = snapshotOf(a.sock);
    expect(welcome.seq).toBe(5);
    expect(welcome.instance.length).toBeGreaterThan(0);
    expect(welcome.wm).toEqual({ o: 5 });
    expect(regAt(welcome.registers, [])?.siblings[0]).toMatchObject({
      kind: 'set',
      value: { v: 5 },
    });
  });

  it('refuses to hydrate a touched room', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    // members but no state yet: still refused (they were told seq 0)
    expect(relay.hydrate('r', { seq: 5, registers: [] })).toBe(false);

    a.env([set([], { v: 0 })]);
    expect(relay.hydrate('r', { seq: 5, registers: [] })).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
  });

  it('hydrate drops journal entries above seq and caps to journalLimit', () => {
    const mkEnv = (seq: number): SeqEnvelope => ({
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
      registers: [],
      journal: [mkEnv(2), mkEnv(4), mkEnv(3), mkEnv(9)],
    });
    expect(relay.room('r')).toMatchObject({ seq: 4, journal: 2 });

    // the kept tail is [3, 4]: a watermark of 2 is covered, delta answers [3, 4]
    const a = client(relay, 'wa', 'oa');
    a.hello(2);
    const welcome = last(a.sock);
    expect(welcome).toMatchObject({ mode: 'delta' });
    expect(
      (welcome as unknown as { envs: { seq: number }[] }).envs.map(
        (e) => e.seq,
      ),
    ).toEqual([3, 4]);
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
      ops: SyncOp[],
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
      c.sock.sent.filter((m) => m.t === 'env') as unknown as {
        t: 'env';
        env: { seq: number; ops: SyncOp[] };
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

describe('createRelay — schemaVersion + migration', () => {
  const welcomeOf = (sock: ReturnType<typeof socket>) =>
    sock.sent.find((m) => m.t === 'welcome') as
      | Extract<ServerMsg, { t: 'welcome' }>
      | undefined;

  const migrate = (
    relay: ReturnType<typeof createRelay>,
    room: string,
    origin: string,
    schemaVersion: number,
    root: unknown,
  ) => {
    const c = client(relay, 'migrator', origin);
    // a migrator declares the new schema (newer than the room → allowed in) and emits the
    // bump; a migration root-replace is epoch-BUMPED (the migrator is an authorized bumper)
    c.conn.receive({
      t: 'hello',
      room,
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      schemaVersion,
    });
    c.env([set([], root, { epoch: 1 })], { schemaVersion });
    return c;
  };

  it('a migration envelope bumps the room schemaVersion (seen in a later welcome)', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['title'], 'v0')]);

    migrate(relay, 'r', 'omig', 1, { title: 'v1', extra: true });

    const late = client(relay, 'wl', 'ol');
    late.hello();
    expect(welcomeOf(late.sock)?.schemaVersion).toBe(1);
    expect((welcomeOf(late.sock) as { mode: string }).mode).toBe('snapshot');
  });

  it('the migration restarts retention: a joiner gets ONLY the migrated register state, at the bumped epoch', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { title: 'v0' })]);
    a.env([set(['title'], 'v0-edit')]); // old-shape descendant register

    migrate(relay, 'r', 'omig', 1, { title: 'v1' });

    const late = client(relay, 'wl', 'ol');
    late.hello();
    const welcome = snapshotOf(late.sock);
    // no old-shape leftovers: replaying them beside the new root would resurrect v0 state
    expect(welcome.registers).toHaveLength(1);
    expect(regAt(welcome.registers, [])?.siblings).toEqual([
      expect.objectContaining({
        kind: 'set',
        value: { title: 'v1' },
        epoch: 1,
      }),
    ]);
  });

  it('the migration bumps the instance — the watermark-death signal clients reset on', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['title'], 'v0')]);
    const instanceBefore = welcomeOf(a.sock)?.instance;

    migrate(relay, 'r', 'omig', 1, { title: 'v1' });

    const back = client(relay, 'wb', 'ob');
    back.hello();
    const w = welcomeOf(back.sock);
    expect(w?.instance).not.toBe(instanceBefore); // instance changed → clients discard their old watermark
    expect(w?.schemaVersion).toBe(1);
    // the migration envelope rode the log, so it is in the room's history for any resumer
    expect(relay.room('r')?.journal ?? 0).toBeGreaterThan(0);
  });

  it('rejects a client older than the room schema with reason "schema"', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    migrate(relay, 'r', 'omig', 2, { title: 'v2' });

    const old = client(relay, 'wo', 'oo');
    old.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'oo',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      schemaVersion: 1, // older than the room's 2
    });
    const rej = old.sock.sent.find((m) => m.t === 'reject') as
      | Extract<ServerMsg, { t: 'reject' }>
      | undefined;
    expect(rej?.reason).toBe('schema');
    expect(rej?.expected).toBe(2);
  });

  it('lets an equal-or-newer client in', () => {
    const relay = createRelay();
    migrate(relay, 'r', 'omig', 1, { title: 'v1' });
    const c = client(relay, 'wc', 'oc');
    c.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'oc',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      schemaVersion: 1,
    });
    expect(welcomeOf(c.sock)).toBeDefined();
    expect(c.sock.sent.some((m) => m.t === 'reject')).toBe(false);
  });

  it('hydrate restores the schemaVersion', () => {
    const relay = createRelay();
    relay.hydrate('r', {
      seq: 5,
      registers: [],
      schemaVersion: 3,
    });
    const c = client(relay, 'wc', 'oc');
    c.hello();
    expect(welcomeOf(c.sock)?.schemaVersion).toBe(3);
  });
});

describe('createRegisterStore — lone-tombstone compaction reaches a fixpoint', () => {
  const rEnv = (origin: string, ops: SyncOp[], p: number): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    origin,
    writer: origin,
    version: p,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops,
  });

  it('reclaims an ancestor tombstone even when its descendant tombstone is collected the same pass', () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set([], {})], 1)); // root never held the key
    store.ingest(rEnv('oa', [set(['items'], { a: 1 })], 2));
    store.ingest(rEnv('oa', [set(['items', 'deep'], 9)], 3));
    store.ingest(rEnv('oa', [del(['items'], { a: 1 })], 4)); // items → lone tombstone
    store.ingest(rEnv('oa', [del(['items', 'deep'], 9)], 5)); // items.deep → lone tombstone

    store.compact({ p: 100, l: 0 });
    const cps = store.checkpoint();
    // nothing materializes either key; a single-pass compaction strands the ancestor tombstone
    expect(regAt(cps, ['items', 'deep'])).toBeUndefined();
    expect(regAt(cps, ['items'])).toBeUndefined();
  });
});

describe('createRelay: room lifecycle', () => {
  it('a rejected first-contact hello leaves no room behind', () => {
    const relay = createRelay({ policyVersion: 1 });
    const sock = socket();
    const conn = relay.connect(sock, { writer: 'w' });
    conn.receive({
      t: 'hello',
      room: 'ghost',
      origin: 'o',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0, // wrong: rejected
    });
    expect(sock.sent.some((m) => m.t === 'reject')).toBe(true);
    expect(relay.room('ghost')).toBeUndefined();
  });

  it('evicts a never-seeded room once its last member leaves; keeps one with state', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    expect(relay.room('r')).toBeDefined();
    a.conn.disconnect(); // never seeded (seq 0) -> reclaimed
    expect(relay.room('r')).toBeUndefined();

    const b = client(relay, 'wb', 'ob');
    b.hello();
    b.env([set([], { v: 1 })]); // seq 1 -> has state
    b.conn.disconnect();
    expect(relay.room('r')).toBeDefined(); // retained for late joiners
  });
});

describe('createRelay: frontier broadcast', () => {
  it('broadcasts the advanced frontier to connected clients when the journal trims', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.env([set([], { v: 1 })]); // seq 1
    a.env([set(['v'], 2)]); // seq 2
    a.env([set(['v'], 3)]); // seq 3 -> journal (limit 2) trims, frontier advances

    const frontiers = b.sock.sent.filter((m) => m.t === 'frontier');
    expect(frontiers.length).toBeGreaterThan(0);
    expect(frontiers[0]).toMatchObject({ t: 'frontier', room: 'r' });
  });
});

describe('createRelay: migration schema floor', () => {
  it('drops an outdated-schema straggler after a migration (no old-shape resurrection)', () => {
    const relay = createRelay();
    const a = client(relay, 'a', 'oa');
    const b = client(relay, 'b', 'ob');
    a.hello();
    b.hello();

    a.env([set([], { v: 1 })]); // seed at schema 0
    b.env([set([], { v: 2 })], { schemaVersion: 1 }); // migration to schema 1

    const bEnvsBefore = b.sock.sent.filter((m) => m.t === 'env').length;
    a.env([set(['old'], 'stale')], { schemaVersion: 0 }); // outdated straggler
    const bEnvsAfter = b.sock.sent.filter((m) => m.t === 'env').length;

    // the straggler was neither sequenced nor broadcast, so it cannot fold into the migrated room
    expect(bEnvsAfter).toBe(bEnvsBefore);
  });
});
