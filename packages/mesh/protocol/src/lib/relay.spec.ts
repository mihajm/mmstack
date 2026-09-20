import {
  pathPrefixAcl,
  type PolicyRoomInfo,
  type PolicyViolation,
  type PrincipalCtx,
} from './policy';
// counts the relay's register walks, so "lazy" can be asserted rather than asserted-by-reading
const spy = vi.hoisted(() => ({ checkpoints: 0 }));
vi.mock('./register', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    createRegisterStore: typeof createRegisterStore;
  };
  return {
    ...actual,
    createRegisterStore: () => {
      const store = actual.createRegisterStore();
      return {
        ...store,
        checkpoint: () => {
          spy.checkpoints++;
          return store.checkpoint();
        },
      };
    },
  };
});

import {
  createRelay,
  type RelayConnection,
  type RelaySocket,
  type RoomSnapshot,
  type RoomState,
} from './relay';
import { createRegisterStore } from './register';
import {
  MESH_PROTO_VERSION,
  type Dot,
  type Hlc,
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

  it("ejection: 'connection' drops only the offending connection; the writer's other tab stays live and a fresh connection is admitted", () => {
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
      ejection: 'connection',
    });
    const good = client(relay, 'wg', 'og');
    const bad = client(relay, 'wb', 'ob1');
    const tab = client(relay, 'wb', 'ob2');
    good.hello();
    bad.hello();
    tab.hello();

    bad.env([set(['admin', 'x'], 1)]);

    expect(bad.sock.closed).toBe(true);
    expect(bad.sock.sent.some((m) => m.t === 'eject')).toBe(true);
    expect(tab.sock.closed).toBe(false);
    expect(tab.sock.sent.some((m) => m.t === 'eject')).toBe(false);
    expect(good.sock.sent.some((m) => m.t === 'eject')).toBe(false);
    expect(
      good.sock.sent.some(
        (m) => m.t === 'member' && m.origin === 'ob1' && m.gone,
      ),
    ).toBe(true);

    bad.env([set(['ok'], 1)]);
    expect(good.sock.sent.filter((m) => m.t === 'env')).toEqual([]);
    bad.hello();
    expect(last(bad.sock)).toMatchObject({
      t: 'reject',
      reason: 'unauthorized',
    });

    tab.env([set(['tab'], 1)]);
    expect(good.sock.sent.filter((m) => m.t === 'env')).toHaveLength(1);

    const again = client(relay, 'wb', 'ob3');
    again.hello();
    expect(last(again.sock)).toMatchObject({ t: 'welcome' });
    again.env([set(['again'], 1)]);
    expect(good.sock.sent.filter((m) => m.t === 'env')).toHaveLength(2);
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
      registers: readonly RegisterCheckpoint[];
      state: { seq: number; wm: Readonly<Record<string, number>> };
    }[] = [];
    const relay = createRelay({
      onCommit: (_room, env, state) => {
        commits.push({ env, registers: state.checkpoint(), state });
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set(['v'], 1)]);

    expect(commits.map((c) => c.env.seq)).toEqual([1, 2]);
    expect(commits[1].state.seq).toBe(2);
    expect(commits[1].state.wm).toEqual({ oa: 2 });
    expect(regAt(commits[1].registers, ['v'])?.siblings[0]).toMatchObject({
      kind: 'set',
      value: 1,
    });
  });

  it('onCommit does not fire for a rejected envelope', () => {
    const commits: unknown[] = [];
    const relay = createRelay({
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
      onCommit: (_room, env) => {
        commits.push(env);
      },
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
        saved = {
          ...state,
          registers: state.checkpoint(),
          journal: [...saved.journal, env],
        };
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
    expect(canWrite(human, ['notes', 3, 'text'], 'r')).toBe(true);
    expect(canWrite(human, ['cases', 'c1', 'plan', 'step'], 'r')).toBe(true);
    expect(canWrite(agent, ['cases', 'c1', 'plan', 'step'], 'r')).toBe(false);
    expect(canWrite(agent, ['notes', 0], 'r')).toBe(true);
    expect(canWrite(human, ['admin'], 'r')).toBe(false);
  });

  it('rules see the room, so one relay expresses per-room authority', () => {
    const acl = pathPrefixAcl([
      { prefix: [], allow: (_ctx, room) => room === 'mine' },
    ]);
    expect(acl.canWrite?.({ writer: 'w' }, ['x'], 'mine')).toBe(true);
    expect(acl.canWrite?.({ writer: 'w' }, ['x'], 'other')).toBe(false);
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
      Extract<ServerMsg, { t: 'welcome' }> | undefined;

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
      Extract<ServerMsg, { t: 'reject' }> | undefined;
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

describe('createRelay: epoch-bump admission (canBump)', () => {
  it('tripwire: an unauthorized epoch RAISE ejects with "epoch-bump"; the whole envelope is rejected, never an op mid-log', () => {
    const violations: PolicyViolation[] = [];
    const relay = createRelay({
      policy: { canBump: (ctx) => ctx.claims?.['role'] === 'owner' },
      onViolation: (_room, v) => violations.push(v),
    });
    const a = client(relay, 'wa', 'oa'); // no owner claim
    a.hello();
    // first op is clean; the second claims precedence — nothing of the envelope may land
    a.env([set(['ok'], 1), set(['doc'], 'mine', { epoch: 1 })]);

    expect(violations).toEqual([
      {
        writer: 'wa',
        reason: 'epoch-bump',
        path: ['doc'],
        detail: 'epoch 1 > observed 0',
      },
    ]);
    expect(a.sock.closed).toBe(true);
    expect(relay.room('r')).toMatchObject({ seq: 0 }); // the clean first op did not sequence either
  });

  it('an authorized bump is admitted; an unauthorized writer CARRYING (or trailing) the observed epoch is always admitted without consulting authority', () => {
    let asked = 0;
    const relay = createRelay({
      policy: {
        canBump: (ctx) => {
          asked++;
          return ctx.claims?.['role'] === 'owner';
        },
      },
    });
    const owner = client(relay, 'wo', 'oo', { claims: { role: 'owner' } });
    const peer = client(relay, 'wp', 'op');
    owner.hello();
    peer.hello();

    owner.env([set(['doc'], 'v1', { epoch: 5 })]); // a raise, granted
    expect(owner.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
    expect(asked).toBe(1);

    // the peer observed the bump: citing it and carrying epoch 5 forward is how the room keeps
    // merging after an override — it must need NO authority
    peer.env([
      set(['doc'], 'v2', {
        epoch: 5,
        cites: [{ origin: 'oo', hlc: { p: 1, l: 0 } }],
      }),
    ]);
    // and an op still racing BELOW the observed max is not a raise either
    peer.env([set(['doc'], 'race', { epoch: 0 })]);

    expect(peer.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 3 });
    expect(asked).toBe(1); // never consulted for the carry or the trailing write
  });

  it('backward compatible: a policy without canBump (and no policy at all) leaves epochs ungated', () => {
    const gated = createRelay({ policy: { canWrite: () => true } });
    const a = client(gated, 'wa', 'oa');
    a.hello();
    a.env([set(['doc'], 'x', { epoch: 999 })]);
    expect(a.sock.closed).toBe(false);
    expect(gated.room('r')).toMatchObject({ seq: 1 });

    const open = createRelay();
    const b = client(open, 'wb', 'ob');
    b.hello();
    b.env([set(['doc'], 'x', { epoch: 999 })]);
    expect(b.sock.closed).toBe(false);
  });
});

describe('createRelay: citation-existence admission (verifyCitations)', () => {
  it('tripwire: a cite of a dot the room has no record of ejects with "unknown-citation" (the forged-watermark vector)', () => {
    const violations: PolicyViolation[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      onViolation: (_room, v) => violations.push(v),
    });
    const a = client(relay, 'wa', 'oa');
    const forger = client(relay, 'wf', 'of');
    a.hello();
    forger.hello();
    a.env([set(['doc'], 'real')]); // (oa, 1.0) is the only dot oa ever minted here

    // citing a FUTURE dot of a known origin would raise oa's supersession watermark past
    // writes it never made, killing them on arrival
    forger.env([
      set(['doc'], 'kill', { cites: [{ origin: 'oa', hlc: { p: 99, l: 0 } }] }),
    ]);

    expect(violations).toEqual([
      {
        writer: 'wf',
        reason: 'unknown-citation',
        path: ['doc'],
        detail: 'cites oa@99.0',
      },
    ]);
    expect(forger.sock.closed).toBe(true);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
  });

  it("admits a cite of a retained dot, and of an origin's OLDER dot its newer sibling already covers", () => {
    const relay = createRelay({ policy: { verifyCitations: true } });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set(['doc'], 'v1')]); // (oa, 1.0)
    a.env([set(['doc'], 'v2')]); // (oa, 2.0) — the register keeps only oa's best sibling

    b.env([
      set(['doc'], 'w1', { cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }] }),
    ]);
    // the older dot is no longer a sibling, but it sits within oa's known extent at the path:
    // a writer that raced oa's newer write legitimately still cites it
    b.env([
      set(['doc'], 'w2', { cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }] }),
    ]);

    expect(b.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 4 });
  });

  it('exempts cites at or below the compaction frontier: a stale-but-honest cite of a compacted dot is admitted', () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      journalLimit: 2,
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], {})]);
    a.env([set(['items', 'a'], 1)]); // (oa, 2.0)
    a.env([
      del(['items', 'a'], 1, {
        cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
      }),
    ]);
    a.env([set(['other'], 1)]);
    a.env([set(['other'], 2)]); // journal trims past the delete; ['items','a'] compacts away entirely

    // an observer that saw (oa, 2.0) before it settled: the relay can no longer verify the cite,
    // and a forged cite down there could kill nothing anyway (below-frontier ops are settled)
    const b = client(relay, 'wb', 'ob');
    b.hello();
    b.env(
      [
        set(['items', 'a'], 7, {
          cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
        }),
      ],
      { hlc: { p: 50, l: 0 } },
    );
    expect(b.sock.closed).toBe(false);
  });

  it("tolerates a self-citation of the envelope's own dot, exactly as ingest does (born-dead guard)", () => {
    const relay = createRelay({ policy: { verifyCitations: true } });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([
      set(['doc'], 'x', { cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }] }),
    ]); // cites its own envelope stamp
    expect(a.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
  });

  it('a stale-schema straggler stays a silent drop, never an ejection for its now-unverifiable cites', () => {
    const violations: PolicyViolation[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      onViolation: (_room, v) => violations.push(v),
    });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set([], { v: 1 })]);
    a.env([set(['old'], 'x')]); // (oa, 2.0) at ['old']
    b.env([set([], { v: 2 })], { schemaVersion: 1 }); // migration: retention restarts

    // a's in-flight pre-migration write cites its own earlier dot, which the reset room no
    // longer knows; it is outdated, not malicious — the schema floor drops it before authority
    // is consulted
    a.env(
      [
        set(['old'], 'stale', {
          cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
        }),
      ],
      { schemaVersion: 0 },
    );
    expect(a.sock.closed).toBe(false);
    expect(violations).toEqual([]);
  });

  it('backward compatible: without verifyCitations an unknown cite is admitted as before', () => {
    const relay = createRelay({ policy: { canWrite: () => true } });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([
      set(['doc'], 'x', { cites: [{ origin: 'ghost', hlc: { p: 9, l: 0 } }] }),
    ]);
    expect(a.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 1 });
  });
});

describe('createRegisterStore — admission reads (maxEpoch / covers)', () => {
  const rEnv = (origin: string, ops: SyncOp[], p: number): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    origin,
    writer: origin,
    version: p,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops,
  });

  it('maxEpoch spans ALL retained siblings — a superseded bump still counts within the retention window — and is 0 where nothing is retained', () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set(['doc'], 'v', { epoch: 5 })], 1));
    // cite-supersession is rank-independent: a lower-epoch write citing the bump supersedes it,
    // but the observed max must not regress until compaction actually reclaims the sibling
    store.ingest(
      rEnv(
        'ob',
        [
          set(['doc'], 'w', {
            cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }],
            epoch: 3,
          }),
        ],
        2,
      ),
    );
    expect(store.maxEpoch(['doc'])).toBe(5);
    expect(store.maxEpoch(['elsewhere'])).toBe(0);
  });

  it('covers: an exact dot, an older dot under the sibling, a watermarked dot; never an unknown origin or an unminted future dot', () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set(['doc'], 'v1')], 1));
    store.ingest(rEnv('oa', [set(['doc'], 'v2')], 2)); // oa's sibling advances to 2.0
    // a cite can precede its op (cites-before-ops): the watermark is the only trace of (oc, 9.0)
    store.ingest(
      rEnv(
        'ob',
        [set(['doc'], 'w', { cites: [{ origin: 'oc', hlc: { p: 9, l: 0 } }] })],
        3,
      ),
    );

    expect(store.covers(['doc'], { origin: 'oa', hlc: { p: 2, l: 0 } })).toBe(
      true,
    );
    expect(store.covers(['doc'], { origin: 'oa', hlc: { p: 1, l: 0 } })).toBe(
      true,
    );
    expect(store.covers(['doc'], { origin: 'oa', hlc: { p: 3, l: 0 } })).toBe(
      false,
    ); // oa never minted it
    expect(store.covers(['doc'], { origin: 'oc', hlc: { p: 9, l: 0 } })).toBe(
      true,
    ); // watermark trace
    expect(
      store.covers(['doc'], { origin: 'ghost', hlc: { p: 1, l: 0 } }),
    ).toBe(false);
    expect(store.covers(['nope'], { origin: 'oa', hlc: { p: 1, l: 0 } })).toBe(
      false,
    );
  });
});

describe('createRelay: observational hooks (onDrop / onReject)', () => {
  it('a stale-schema straggler fires onDrop("schema"): dropped, not sequenced, not ejected, no violation', () => {
    const drops: { room: string; version: number; reason: string }[] = [];
    const violations: PolicyViolation[] = [];
    const relay = createRelay({
      onDrop: (room, env, reason) =>
        drops.push({ room, version: env.version, reason }),
      onViolation: (_room, v) => violations.push(v),
    });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.env([set([], { v: 1 })]); // sequenced normally: must not fire onDrop
    b.env([set([], { v: 2 })], { schemaVersion: 1 }); // migration to schema 1
    a.env([set(['old'], 'stale')], { schemaVersion: 0 }); // the silent drop (a's version 2)

    expect(drops).toEqual([{ room: 'r', version: 2, reason: 'schema' }]);
    expect(violations).toEqual([]);
    expect(a.sock.closed).toBe(false);
    expect(relay.room('r')).toMatchObject({ seq: 2 }); // the straggler never sequenced
  });

  it('every hello denial fires onReject with the writer, the reason, and the expected pin', () => {
    const rejects: {
      room: string;
      writer: string;
      reason: string;
      expected?: number;
    }[] = [];
    const relay = createRelay({
      policyVersion: 3,
      policy: { canWrite: (_ctx, path) => path[0] !== 'admin' },
      onReject: (room, ctx, reason, expected) =>
        rejects.push({ room, writer: ctx.writer, reason, expected }),
    });

    const ok = client(relay, 'wok', 'ook');
    ok.sock.sent.length = 0;
    ok.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'ook',
      proto: MESH_PROTO_VERSION,
      policyVersion: 3,
    });
    expect(rejects).toEqual([]); // a successful hello is not a denial

    const stale = client(relay, 'ws', 'os');
    stale.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'os',
      proto: MESH_PROTO_VERSION - 1,
      policyVersion: 3,
    });
    stale.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'os',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });

    const bad = client(relay, 'wb', 'ob');
    bad.hello = () =>
      bad.conn.receive({
        t: 'hello',
        room: 'r',
        origin: 'ob',
        proto: MESH_PROTO_VERSION,
        policyVersion: 3,
      });
    bad.hello();
    bad.env([set(['admin', 'x'], 1)], { policyVersion: 3 }); // tripwire: ejected
    bad.hello(); // the banned writer knocking again

    expect(rejects).toEqual([
      {
        room: 'r',
        writer: 'ws',
        reason: 'proto',
        expected: MESH_PROTO_VERSION,
      },
      { room: 'r', writer: 'ws', reason: 'policy-version', expected: 3 },
      { room: 'r', writer: 'wb', reason: 'unauthorized', expected: undefined },
    ]);
  });

  it('onJoin fires per accepted hello with the origin-principal binding; never for a denied hello', () => {
    const joins: {
      room: string;
      writer: string;
      kind?: string;
      origin: string;
    }[] = [];
    const relay = createRelay({
      policyVersion: 1,
      onJoin: (room, ctx, origin) =>
        joins.push({ room, writer: ctx.writer, kind: ctx.kind, origin }),
    });
    const sock = socket();
    const conn = relay.connect(sock, { writer: 'w', kind: 'agent' });

    conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'o1',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0, // denied: no binding was established
    });
    expect(joins).toEqual([]);

    const hello = () =>
      conn.receive({
        t: 'hello',
        room: 'r',
        origin: 'o1',
        proto: MESH_PROTO_VERSION,
        policyVersion: 1,
      });
    hello();
    hello(); // a reconnect re-asserts the binding: fires again, adapter dedupes
    expect(joins).toEqual([
      { room: 'r', writer: 'w', kind: 'agent', origin: 'o1' },
      { room: 'r', writer: 'w', kind: 'agent', origin: 'o1' },
    ]);
  });

  it('a schema-behind hello fires onReject("schema") with the room schema as expected', () => {
    const rejects: { reason: string; expected?: number }[] = [];
    const relay = createRelay({
      onReject: (_room, _ctx, reason, expected) =>
        rejects.push({ reason, expected }),
    });
    relay.hydrate('r', { seq: 5, registers: [], schemaVersion: 3 });

    const old = client(relay, 'wo', 'oo');
    old.conn.receive({
      t: 'hello',
      room: 'r',
      origin: 'oo',
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
      schemaVersion: 1,
    });
    expect(rejects).toEqual([{ reason: 'schema', expected: 3 }]);
  });
});

describe('createRelay: per-room policy authority', () => {
  it('canWrite and canBump receive the room, so ONE relay holds different authority per room', () => {
    const relay = createRelay({
      policy: {
        canWrite: (_ctx, _path, room) => room !== 'readonly-room',
        canBump: (_ctx, _path, _epoch, room) => room === 'owned-room',
      },
    });
    const writeTo = (
      writer: string,
      origin: string,
      room: string,
      ops: SyncOp[],
    ) => {
      const sock = socket();
      const conn = relay.connect(sock, { writer });
      conn.receive({
        t: 'hello',
        room,
        origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
      conn.receive({
        t: 'env',
        room,
        env: {
          proto: MESH_PROTO_VERSION,
          origin,
          writer,
          version: 1,
          hlc: { p: 1, l: 0 },
          policyVersion: 0,
          ops,
        },
      });
      return sock;
    };

    // the SAME write by the same principal shape: admitted in one room, tripwired in another
    expect(writeTo('w1', 'o1', 'open-room', [set(['x'], 1)]).closed).toBe(
      false,
    );
    expect(writeTo('w2', 'o2', 'readonly-room', [set(['x'], 1)]).closed).toBe(
      true,
    );
    // the SAME epoch raise: granted only in the room whose authority allows it
    expect(
      writeTo('w3', 'o3', 'owned-room', [set(['x'], 1, { epoch: 1 })]).closed,
    ).toBe(false);
    expect(
      writeTo('w4', 'o4', 'open-room', [set(['x'], 1, { epoch: 1 })]).closed,
    ).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// Durable acknowledgement — the release gate as a pure model.
//
// The gate is the whole mechanism durable release adds: an ordered queue of outbound groups,
// each held until its own durability promise settles AND every earlier group has been
// released. The model carries no relay, no sockets and no wire types, so what it proves is the
// ordering algebra itself; the relay suite below re-points the same properties at the impl.
// ─────────────────────────────────────────────────────────────────────────────

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(cause: unknown): void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // the gate observes a rejection; the host must not see it unhandled
  return { promise, resolve, reject };
};

/** Let every already-settled promise chain run to quiescence. */
const settle = async (turns = 50): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Gate<M> = {
  /** Queue one outbound group behind everything already queued. */
  submit(msgs: readonly M[], done?: Promise<void>): void;
  pending(): number;
};

function releaseGate<M>(
  emit: (msg: M) => void,
  onFail?: (msgs: readonly M[], cause: unknown) => void,
): Gate<M> {
  type Item = { readonly msgs: readonly M[]; readonly done?: Promise<void> };
  const queue: Item[] = [];
  let stalled = false;
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (!stalled && queue.length > 0) {
      const head = queue[0];
      if (head.done) {
        try {
          await head.done;
        } catch (cause) {
          stalled = true;
          onFail?.(head.msgs, cause);
          break;
        }
      }
      queue.shift();
      for (const msg of head.msgs) emit(msg);
    }
    draining = false;
  };

  return {
    submit: (msgs, done) => {
      if (stalled) {
        queue.push({ msgs, done });
        return;
      }
      if (!draining && queue.length === 0 && done === undefined) {
        for (const msg of msgs) emit(msg); // nothing is owed: release at once
        return;
      }
      queue.push({ msgs, done });
      void drain();
    },
    pending: () => queue.length,
  };
}

describe('release gate (pure model)', () => {
  type Group = { readonly id: number; readonly d?: Deferred };

  /**
   * One randomized run: `n` groups submitted in order, interleaved with resolutions of any
   * still-pending promise (resolution order is deliberately NOT submission order).
   */
  const run = async (seed: number) => {
    const rnd = mulberry32(seed);
    const n = 3 + Math.floor(rnd() * 6);
    const groups: Group[] = [];
    for (let i = 0; i < n; i++) {
      groups.push({ id: i, d: rnd() < 0.3 ? undefined : deferred() });
    }

    const resolved = new Set<number>();
    const emitted: { id: number; resolvedThen: ReadonlySet<number> }[] = [];
    const gate = releaseGate<number>((id) =>
      emitted.push({ id, resolvedThen: new Set(resolved) }),
    );

    let next = 0;
    const unresolved = (): Group[] =>
      groups.filter((g) => g.d && !resolved.has(g.id) && g.id < next);

    while (next < n || unresolved().length > 0) {
      const pendingNow = unresolved();
      const submitNext = next < n && (pendingNow.length === 0 || rnd() < 0.55);
      if (submitNext) {
        const g = groups[next++];
        if (!g.d) resolved.add(g.id); // a void hook is durable the moment it returns
        gate.submit([g.id], g.d?.promise);
      } else {
        const pick = pendingNow[Math.floor(rnd() * pendingNow.length)];
        resolved.add(pick.id);
        pick.d?.resolve();
      }
      await settle(4);
    }
    await settle();
    return { n, groups, emitted };
  };

  it('releases in submit order, never before its own promise, never before an earlier one (200 seeds)', async () => {
    for (let seed = 0; seed < 200; seed++) {
      const { n, emitted } = await run(seed);
      // order
      expect(emitted.map((e) => e.id)).toEqual(
        Array.from({ length: n }, (_, i) => i),
      );
      // safety: at the moment group i was emitted, groups 0..i were all durable
      for (const e of emitted) {
        for (let j = 0; j <= e.id; j++) {
          expect(e.resolvedThen.has(j)).toBe(true);
        }
      }
    }
  });

  it('an ungated emitter fails the same safety assertion (the property is not vacuous)', async () => {
    const resolved = new Set<number>();
    const emitted: { id: number; resolvedThen: ReadonlySet<number> }[] = [];
    const ungated = (id: number) =>
      emitted.push({ id, resolvedThen: new Set(resolved) });

    const d = deferred();
    ungated(0); // what the relay does today: broadcast, then hand the adapter the record
    resolved.add(0);
    d.resolve();
    await settle();

    expect(emitted[0].resolvedThen.has(0)).toBe(false);
  });

  it('a rejected promise stalls the queue: nothing at or after it is ever released', async () => {
    const emitted: number[] = [];
    const failures: { msgs: readonly number[]; cause: unknown }[] = [];
    const gate = releaseGate<number>(
      (id) => emitted.push(id),
      (msgs, cause) => failures.push({ msgs, cause }),
    );

    const a = deferred();
    const b = deferred();
    const c = deferred();
    gate.submit([0], a.promise);
    gate.submit([1], b.promise);
    gate.submit([2], c.promise);

    a.resolve();
    b.reject(new Error('storage closed'));
    c.resolve();
    await settle();

    expect(emitted).toEqual([0]);
    expect(failures).toHaveLength(1);
    expect(failures[0].msgs).toEqual([1]);
    expect((failures[0].cause as Error).message).toBe('storage closed');

    gate.submit([3]); // a later write queues behind the stall rather than jumping it
    await settle();
    expect(emitted).toEqual([0]);
  });

  it('a group with no promise still waits behind queued work, and passes at once when nothing is owed', async () => {
    const emitted: number[] = [];
    const gate = releaseGate<number>((id) => emitted.push(id));

    gate.submit([0]);
    expect(emitted).toEqual([0]); // synchronous: the void-adapter path is untouched

    const d = deferred();
    gate.submit([1], d.promise);
    gate.submit([2]);
    await settle();
    expect(emitted).toEqual([0]);

    d.resolve();
    await settle();
    expect(emitted).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Durable release — the model's properties, re-pointed at the real relay.
//
// The adapter answers a promise per envelope and the test resolves them BY HAND, in an order
// that is deliberately not seq order. Randomized interleavings of { ingest, resolve one
// pending promise, join a fresh connection } are checked against four properties, and the
// scenario then crashes: a second relay is hydrated from exactly the durable prefix and each
// connection resends what it never saw echoed.
// ─────────────────────────────────────────────────────────────────────────────

const envKey = (e: { origin: string; version: number }): string =>
  `${e.origin}#${e.version}`;
const dotKey = (d: { origin: string; hlc: Hlc }): string =>
  `${d.origin}@${d.hlc.p}.${d.hlc.l}`;

describe('createRelay: durable release', () => {
  type Peer = {
    readonly writer: string;
    readonly origin: string;
    conn: RelayConnection;
    readonly got: ServerMsg[];
    version: number;
    p: number;
  };

  const heldBy = (
    peer: Peer,
    byDot: ReadonlyMap<string, string>,
  ): Set<string> => {
    const held = new Set<string>();
    for (const m of peer.got) {
      if (m.t === 'env') held.add(envKey(m.env));
      else if (m.t === 'welcome' && m.mode === 'delta') {
        for (const e of m.envs) held.add(envKey(e));
      } else if (m.t === 'welcome' && m.mode === 'snapshot') {
        for (const reg of m.registers) {
          for (const sib of reg.siblings) {
            const k = byDot.get(dotKey(sib));
            if (k) held.add(k);
          }
        }
      }
    }
    return held;
  };

  const run = async (seed: number) => {
    const rnd = mulberry32(seed);
    const pending: { env: SeqEnvelope; d: Deferred }[] = [];
    const states = new Map<
      number,
      RoomState & { readonly registers: readonly RegisterCheckpoint[] }
    >();
    const durableEnvs: SeqEnvelope[] = [];
    const durable = new Set<string>();
    const durableDots = new Set<string>();
    const durableSeqs = new Set<number>();
    const byDot = new Map<string, string>();
    const all = new Set<string>();
    const own = new Map<string, OpEnvelope[]>();
    const violations: string[] = [];

    const relay = createRelay({
      onCommit: (_room, env, state) => {
        // captured inside the hook: the thunk reads live state, so a later call would
        // describe a later seq than the envelope it is filed under
        states.set(env.seq, { ...state, registers: state.checkpoint() });
        const d = deferred();
        pending.push({ env, d });
        return d.promise;
      },
    });

    // P1, enforced at the instant the relay hands the message to the socket
    const check = (who: string, msg: ServerMsg): void => {
      const late = (what: string) =>
        violations.push(`${who} was told ${what} before it was durable`);
      if (msg.t === 'env') {
        if (!durable.has(envKey(msg.env))) late(`env ${envKey(msg.env)}`);
      } else if (msg.t === 'welcome' && msg.mode === 'delta') {
        for (const e of msg.envs) {
          if (!durable.has(envKey(e))) late(`welcome/delta ${envKey(e)}`);
        }
      } else if (msg.t === 'welcome' && msg.mode === 'snapshot') {
        for (const reg of msg.registers) {
          for (const sib of reg.siblings) {
            if (!durableDots.has(dotKey(sib))) {
              late(`welcome/snapshot ${dotKey(sib)}`);
            }
          }
        }
        for (const [origin, v] of Object.entries(msg.wm)) {
          if (!durable.has(`${origin}#${v}`) && v > 0) {
            late(`welcome/wm ${origin}#${v}`);
          }
        }
      }
    };

    const peers: Peer[] = [];
    const join = (i: number): Peer => {
      const peer: Peer = {
        writer: `w${i}`,
        origin: `o${i}`,
        conn: null as unknown as RelayConnection,
        got: [],
        version: 0,
        p: 0,
      };
      const sock: RelaySocket = {
        send: (m) => {
          check(peer.origin, m);
          peer.got.push(m);
        },
        close: () => undefined,
      };
      peer.conn = relay.connect(sock, { writer: peer.writer });
      peer.conn.receive({
        t: 'hello',
        room: 'r',
        origin: peer.origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
      peers.push(peer);
      return peer;
    };

    let paths = 0;
    const emit = (peer: Peer): void => {
      const at = paths++;
      const env: OpEnvelope = {
        proto: MESH_PROTO_VERSION,
        origin: peer.origin,
        writer: peer.writer,
        version: ++peer.version,
        hlc: { p: ++peer.p, l: 0 },
        policyVersion: 0,
        // every write lands at its own path, so nothing supersedes anything and a snapshot
        // must still carry every dot the room ever accepted
        ops: [set(['p', at], at)],
      };
      byDot.set(dotKey(env), envKey(env));
      all.add(envKey(env));
      const mine = own.get(peer.origin) ?? [];
      mine.push(env);
      own.set(peer.origin, mine);
      peer.conn.receive({ t: 'env', room: 'r', env });
    };

    const resolveOne = (i: number): void => {
      const [item] = pending.splice(i, 1);
      durable.add(envKey(item.env));
      durableDots.add(dotKey(item.env));
      durableSeqs.add(item.env.seq);
      durableEnvs.push(item.env);
      item.d.resolve();
    };

    join(0);
    join(1);
    for (let step = 0; step < 18; step++) {
      const roll = rnd();
      if (roll < 0.5 || (pending.length === 0 && roll < 0.9)) {
        emit(peers[Math.floor(rnd() * peers.length)]);
      } else if (pending.length > 0 && roll < 0.9) {
        resolveOne(Math.floor(rnd() * pending.length)); // NOT seq order
      } else if (peers.length < 4) {
        join(peers.length);
      }
      await settle(4);
    }
    await settle();

    // P1 holds while writes are still in flight, before anything is drained
    expect(violations).toEqual([]);

    const crashPoint = {
      durableEnvs: [...durableEnvs],
      durableSeqs: new Set(durableSeqs),
      held: new Map(peers.map((p) => [p.origin, heldBy(p, byDot)])),
    };

    while (pending.length > 0) resolveOne(Math.floor(rnd() * pending.length));
    await settle();

    return { peers, all, byDot, violations, states, crashPoint, own };
  };

  it('P1/P2/P3: nothing is released early, everything is released, per-connection seqs rise (200 seeds)', async () => {
    for (let seed = 0; seed < 200; seed++) {
      const { peers, all, byDot, violations } = await run(seed);

      expect(violations).toEqual([]); // P1 safety

      for (const peer of peers) {
        // P2 liveness: once every promise resolves, every connection holds every envelope
        expect([...heldBy(peer, byDot)].sort()).toEqual([...all].sort());

        // P3 order: per connection, echoed seqs are strictly increasing
        const seqs = peer.got
          .filter((m): m is Extract<ServerMsg, { t: 'env' }> => m.t === 'env')
          .map((m) => m.env.seq);
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
        }
      }
    }
  });

  it('P4 restart: a relay hydrated from the durable prefix plus each writer’s unacked resend holds the whole set (60 seeds)', async () => {
    for (let seed = 0; seed < 60; seed++) {
      const { all, byDot, states, crashPoint, own } = await run(seed);

      // a journal appends in order, so what survives a crash is the longest durable PREFIX
      let k = 0;
      while (crashPoint.durableSeqs.has(k + 1)) k++;

      const restored = createRelay({});
      if (k > 0) {
        const st = states.get(k) as RoomState & {
          readonly registers: readonly RegisterCheckpoint[];
        };
        expect(
          restored.hydrate('r', {
            seq: k,
            registers: st.registers,
            wm: st.wm,
            instance: st.instance,
            schemaVersion: st.schemaVersion,
            journal: crashPoint.durableEnvs.filter((e) => e.seq <= k),
          }),
        ).toBe(true);
      }

      for (const [origin, envs] of own) {
        const held = crashPoint.held.get(origin) ?? new Set<string>();
        const writer = `w${origin.slice(1)}`;
        const conn = restored.connect(
          { send: () => undefined, close: () => undefined },
          { writer },
        );
        conn.receive({
          t: 'hello',
          room: 'r',
          origin,
          proto: MESH_PROTO_VERSION,
          policyVersion: 0,
        });
        for (const env of envs) {
          if (!held.has(envKey(env)))
            conn.receive({ t: 'env', room: 'r', env });
        }
      }

      const probe = socket();
      const pc = restored.connect(probe, { writer: 'probe' });
      pc.receive({
        t: 'hello',
        room: 'r',
        origin: 'probe',
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
      const welcome = last(probe) as Extract<ServerMsg, { t: 'welcome' }>;
      const recovered = new Set<string>();
      if (welcome.mode === 'snapshot') {
        for (const reg of welcome.registers) {
          for (const sib of reg.siblings) {
            recovered.add(dotKey(sib));
          }
        }
      }
      const everyDot = [...byDot.entries()]
        .filter(([, env]) => all.has(env))
        .map(([dot]) => dot);
      expect([...recovered].sort()).toEqual(everyDot.sort());
    }
  });

  // pinned oracle for the capture point: reading room state when the welcome is finally SENT
  // would fold in whatever was ingested while it waited, which is exactly what is not durable
  it('a held welcome answers the room as it stood when the hello arrived, not as it stands at release', async () => {
    const pending: Deferred[] = [];
    const relay = createRelay({
      onCommit: () => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['a'], 1)]);
    await settle();

    const b = client(relay, 'wb', 'ob');
    b.hello(); // captured here: the room holds only oa's first write
    await settle();
    expect(b.sock.sent.some((m) => m.t === 'welcome')).toBe(false);

    a.env([set(['later'], 2)]); // ingested while the welcome waits
    await settle();

    pending[0].resolve();
    await settle();

    const welcome = b.sock.sent.find((m) => m.t === 'welcome') as Extract<
      ServerMsg,
      { t: 'welcome' }
    >;
    expect(welcome.mode).toBe('snapshot');
    if (welcome.mode !== 'snapshot') throw new Error('unreachable');
    expect(welcome.seq).toBe(1);
    expect(regAt(welcome.registers, ['a'])).toBeDefined();
    expect(regAt(welcome.registers, ['later'])).toBeUndefined();

    pending[1].resolve();
    await settle();
    expect(b.sock.sent.some((m) => m.t === 'env' && m.env.seq === 2)).toBe(
      true,
    );
  });

  it('presence and membership pass while a write is held: only document state waits', async () => {
    const pending: Deferred[] = [];
    const relay = createRelay({
      onCommit: () => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['a'], 1)]);
    await settle();
    expect(a.sock.sent.some((m) => m.t === 'env')).toBe(false);

    const b = client(relay, 'wb', 'ob');
    b.hello();
    b.conn.receive({ t: 'presence', room: 'r', data: { at: 'x' } });
    await settle();

    expect(a.sock.sent.some((m) => m.t === 'member')).toBe(true);
    expect(a.sock.sent.some((m) => m.t === 'presence')).toBe(true);
    expect(a.sock.sent.some((m) => m.t === 'env')).toBe(false);

    pending[0].resolve();
    await settle();
    expect(a.sock.sent.some((m) => m.t === 'env')).toBe(true);
  });

  it('a rejected durability promise stalls the room: the echo never lands, later work queues, onDurabilityFailed fires once', async () => {
    const failures: { env: SeqEnvelope; cause: unknown }[] = [];
    const pending: Deferred[] = [];
    const relay = createRelay({
      onDurabilityFailed: (_room, env, cause) => failures.push({ env, cause }),
      onCommit: () => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['a'], 1)]);
    await settle();

    pending[0].reject(new Error('storage closed'));
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0].env.seq).toBe(1);
    expect((failures[0].cause as Error).message).toBe('storage closed');
    expect(a.sock.sent.some((m) => m.t === 'env')).toBe(false);

    a.env([set(['b'], 2)]); // still sequenced and retained, never released
    pending[1]?.resolve();
    await settle();
    expect(a.sock.sent.some((m) => m.t === 'env')).toBe(false);
    expect(relay.room('r')?.seq).toBe(2);

    const b = client(relay, 'wb', 'ob'); // a stalled room stops answering hellos too
    b.hello();
    await settle();
    expect(b.sock.sent.some((m) => m.t === 'welcome')).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it('a void onCommit releases synchronously, exactly as before', () => {
    const relay = createRelay({ onCommit: () => undefined });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['a'], 1)]);
    expect(last(a.sock)).toEqual({
      t: 'env',
      room: 'r',
      env: expect.objectContaining({ seq: 1 }),
    });
  });
});

describe('createRelay: the commit checkpoint is a thunk', () => {
  beforeEach(() => {
    spy.checkpoints = 0;
  });

  it('walks no register when the hook never asks for one', () => {
    const relay = createRelay({ onCommit: () => undefined });
    const a = client(relay, 'wa', 'oa');
    a.hello(); // a fresh room answers up-to-date: nothing to walk
    for (let i = 0; i < 5; i++) a.env([set(['v'], i)]);

    expect(relay.room('r')?.seq).toBe(5);
    expect(spy.checkpoints).toBe(0);
  });

  it('walks once per commit that asks, and the answer is the state a joiner would be seeded with', () => {
    let captured: readonly RegisterCheckpoint[] = [];
    const relay = createRelay({
      onCommit: (_room, _env, state) => {
        captured = state.checkpoint();
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    for (let i = 0; i < 5; i++) a.env([set(['v'], i)]);

    expect(spy.checkpoints).toBe(5);

    const fresh = client(relay, 'wf', 'of');
    fresh.hello();
    expect(captured).toEqual(snapshotOf(fresh.sock).registers);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Below-frontier admission. The relay's gate must be the SAME predicate the client runs on
// receive, or the two sides retain different op sets and a joiner is seeded into divergence.
// ─────────────────────────────────────────────────────────────────────────────

describe('below-frontier drop (pure model: relay/client twin)', () => {
  // transcribed from the client's receive gate: `prunedFrontier &&
  // compareHlc(env.hlc, prunedFrontier) <= 0` → drop, with `compareHlc(a, b) =
  // a.p !== b.p ? a.p - b.p : a.l - b.l`
  const compareHlc = (a: Hlc, b: Hlc): number =>
    a.p !== b.p ? a.p - b.p : a.l - b.l;
  const clientDrops = (frontier: Hlc | undefined, hlc: Hlc): boolean =>
    !!frontier && compareHlc(hlc, frontier) <= 0;

  // transcribed from the relay's gate: `room.frontier && hlcLte(env.hlc, room.frontier)`
  const relayDrops = (frontier: Hlc | undefined, hlc: Hlc): boolean =>
    !!frontier &&
    (hlc.p < frontier.p || (hlc.p === frontier.p && hlc.l <= frontier.l));

  it('the two gates agree on every stamp, including the boundary (4000 pairs)', () => {
    const rnd = mulberry32(7);
    const disagreements: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const fp = Math.floor(rnd() * 5);
      const fl = Math.floor(rnd() * 5);
      const frontier: Hlc = { p: fp, l: fl };
      const hlc: Hlc = {
        p: Math.floor(rnd() * 5),
        l: Math.floor(rnd() * 5),
      };
      if (relayDrops(frontier, hlc) !== clientDrops(frontier, hlc)) {
        disagreements.push(`${hlc.p}.${hlc.l} vs ${fp}.${fl}`);
      }
    }
    expect(disagreements).toEqual([]);
    // the boundary is inclusive on BOTH sides
    expect(relayDrops({ p: 3, l: 2 }, { p: 3, l: 2 })).toBe(true);
    expect(clientDrops({ p: 3, l: 2 }, { p: 3, l: 2 })).toBe(true);
    expect(relayDrops({ p: 3, l: 2 }, { p: 3, l: 3 })).toBe(false);
  });

  it('with no frontier the gate is inert, and a frontier that advances never admits more', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 400; i++) {
      const hlc: Hlc = {
        p: Math.floor(rnd() * 6),
        l: Math.floor(rnd() * 6),
      };
      expect(relayDrops(undefined, hlc)).toBe(false);

      const lo: Hlc = { p: Math.floor(rnd() * 6), l: Math.floor(rnd() * 6) };
      const hi: Hlc = { p: lo.p + Math.floor(rnd() * 3), l: lo.l };
      if (relayDrops(lo, hlc)) expect(relayDrops(hi, hlc)).toBe(true);
    }
  });
});

describe('createRelay: below-frontier admission', () => {
  /** Write past `journalLimit` so the room compacts and a frontier exists. */
  const compacted = (relay: ReturnType<typeof createRelay>) => {
    const a = client(relay, 'wa', 'oa');
    a.hello();
    for (let i = 0; i < 5; i++) a.env([set(['fill', i], i)]);
    const notice = a.sock.sent.find((m) => m.t === 'frontier');
    if (!notice || notice.t !== 'frontier') {
      throw new Error('expected the room to have compacted');
    }
    return { a, frontier: notice.frontier };
  };

  it('drops a write at or below the frontier: not sequenced, not ejected, not echoed, not seeded into a joiner', () => {
    const drops: { env: OpEnvelope; reason: string }[] = [];
    const relay = createRelay({
      journalLimit: 4,
      onDrop: (_room, env, reason) => {
        drops.push({ env, reason });
      },
    });
    const { a, frontier } = compacted(relay);
    expect(frontier).toEqual({ p: 1, l: 0 });

    const stale = client(relay, 'ws', 'os');
    stale.hello();
    const seqBefore = relay.room('r')?.seq;

    // an honest offline writer: stamped before the room compacted, at a path nobody used
    stale.env([set(['stale'], 'resurrected')], { hlc: { p: 1, l: 0 } });

    expect(drops.map((d) => d.reason)).toEqual(['frontier']);
    expect(relay.room('r')?.seq).toBe(seqBefore);
    expect(stale.sock.closed).toBe(false);
    expect(stale.sock.sent.some((m) => m.t === 'eject')).toBe(false);
    expect(
      a.sock.sent.some(
        (m) => m.t === 'env' && m.env.ops.some((o) => o.path[0] === 'stale'),
      ),
    ).toBe(false);

    // the established peer's own receive gate would have refused it too, so the room's
    // retained state and the peer's stay the same op set: a joiner is seeded with that set
    const b = client(relay, 'wb', 'ob');
    b.hello();
    expect(regAt(snapshotOf(b.sock).registers, ['stale'])).toBeUndefined();

    // one tick above the frontier is admitted — the gate is a boundary, not a blanket
    stale.env([set(['fresh'], 1)], { hlc: { p: 1, l: 1 } });
    expect(relay.room('r')?.seq).toBe((seqBefore ?? 0) + 1);
  });

  it('a restored frontier still refuses; a snapshot that lost it readmits the same write', () => {
    let saved: RoomSnapshot = { seq: 0 };
    const source = createRelay({
      journalLimit: 4,
      onCommit: (_room, env, state) => {
        saved = {
          seq: state.seq,
          instance: state.instance,
          registers: state.checkpoint(),
          wm: state.wm,
          frontier: state.frontier,
          schemaVersion: state.schemaVersion,
          journal: [env],
        };
      },
    });
    compacted(source);
    expect(saved.frontier).toEqual({ p: 1, l: 0 });

    const replay = (snapshot: RoomSnapshot) => {
      const reasons: string[] = [];
      const revived = createRelay({
        journalLimit: 4,
        onDrop: (_room, _env, reason) => {
          reasons.push(reason);
        },
      });
      expect(revived.hydrate('r', snapshot)).toBe(true);
      const stale = client(revived, 'ws', 'os');
      stale.hello();
      stale.env([set(['stale'], 'resurrected')], { hlc: { p: 1, l: 0 } });
      return { reasons, seq: revived.room('r')?.seq };
    };

    const restored = replay(saved);
    expect(restored.reasons).toEqual(['frontier']);
    expect(restored.seq).toBe(saved.seq);

    // the same room restored from a checkpoint written before the frontier was persisted
    const legacy: RoomSnapshot = {
      seq: saved.seq,
      instance: saved.instance,
      registers: saved.registers,
      wm: saved.wm,
      schemaVersion: saved.schemaVersion,
      journal: saved.journal,
    };
    const forgetful = replay(legacy);
    expect(forgetful.reasons).toEqual([]);
    expect(forgetful.seq).toBe((saved.seq ?? 0) + 1);
  });
});

describe('createRelay: the room sequence reaches the policy', () => {
  // an agent may seed a room it finds empty, and may never write the root afterwards: a later
  // root set is a concurrent sibling that wins the root register and shadows every leaf the
  // first seed's value carried
  const seatPolicy = {
    canWrite: (
      ctx: PrincipalCtx,
      path: readonly Key[],
      _room: string,
      info?: PolicyRoomInfo,
    ) => path.length > 0 || ctx.kind !== 'agent' || info?.seq === 0,
  };

  it("admits an agent's seed of an empty room and ejects the same write once the room has state", () => {
    const relay = createRelay({ policy: seatPolicy });
    const agent = client(relay, 'wa', 'oa', { kind: 'agent' });
    agent.hello();

    agent.env([set([], { title: 'seeded' })]); // the fresh-room seed
    expect(relay.room('r')?.seq).toBe(1);
    expect(agent.sock.closed).toBe(false);

    const late = client(relay, 'wl', 'ol', { kind: 'agent' });
    late.hello();
    late.env([set([], { title: 'reseeded' })]); // the room is no longer empty

    expect(last(late.sock)).toMatchObject({ t: 'eject', reason: 'can-write' });
    expect(late.sock.closed).toBe(true);
    expect(relay.room('r')?.seq).toBe(1);
  });

  it('a human keeps writing the root at any sequence, and leaf writes are unaffected', () => {
    const relay = createRelay({ policy: seatPolicy });
    const human = client(relay, 'wh', 'oh', { kind: 'human' });
    human.hello();
    human.env([set([], { title: 'seeded' })]);
    human.env([set([], { title: 'again' })]);
    expect(human.sock.closed).toBe(false);

    const agent = client(relay, 'wa', 'oa', { kind: 'agent' });
    agent.hello();
    agent.env([set(['title'], 'from the agent')]);
    expect(agent.sock.closed).toBe(false);
    expect(relay.room('r')?.seq).toBe(3);
  });

  it('canBump sees the room sequence too', () => {
    const seen: number[] = [];
    const relay = createRelay({
      policy: {
        canBump: (_ctx, _path, _epoch, _room, info) => {
          seen.push(info?.seq ?? -1);
          return true;
        },
      },
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['v'], 1, { epoch: 1 })]);
    a.env([set(['v'], 2, { epoch: 2 })]);
    expect(seen).toEqual([0, 1]); // the sequence BEFORE each envelope is assigned one
  });
});

describe('createRelay: a late joiner holds a waiting envelope once', () => {
  const envelope = (
    origin: string,
    version: number,
    path: string,
  ): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    origin,
    writer: origin,
    version,
    hlc: { p: 100, l: version },
    policyVersion: 0,
    ops: [{ kind: 'set', path: [path], next: version, cites: [], epoch: 0 }],
  });

  const countOf = (got: readonly ServerMsg[], seq: number): number => {
    let n = 0;
    for (const m of got) {
      if (m.t === 'env' && m.env.seq === seq) n += 1;
      else if (m.t === 'welcome' && m.mode === 'delta')
        n += m.envs.filter((e) => e.seq === seq).length;
      else if (m.t === 'welcome' && m.mode === 'snapshot') n += 1;
    }
    return n;
  };

  it('a member whose welcome carried the envelope is not sent it again at release', async () => {
    const held: Deferred[] = [];
    const relay = createRelay({
      onCommit: () => {
        const d = deferred();
        held.push(d);
        return d.promise;
      },
    });
    const join = (origin: string) => {
      const got: ServerMsg[] = [];
      const conn = relay.connect(
        { send: (m) => got.push(m), close: () => undefined },
        {
          writer: origin,
        },
      );
      conn.receive({
        t: 'hello',
        room: 'r',
        origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
      return { conn, got };
    };
    const a = join('a');
    a.conn.receive({ t: 'env', room: 'r', env: envelope('a', 1, 'x') });
    const b = join('b');
    expect(b.got.filter((m) => m.t === 'welcome')).toHaveLength(0);

    held[0].resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(countOf(a.got, 1)).toBe(1);
    expect(countOf(b.got, 1)).toBe(1);
    expect(b.got.filter((m) => m.t === 'env')).toHaveLength(0);
  });

  it('a member that joins inside the commit hook itself is not echoed either', () => {
    let relay: Relay;
    let c: { got: ServerMsg[] } | undefined;
    const join = (origin: string) => {
      const got: ServerMsg[] = [];
      const conn = relay.connect(
        { send: (m) => got.push(m), close: () => undefined },
        {
          writer: origin,
        },
      );
      conn.receive({
        t: 'hello',
        room: 'r',
        origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
      });
      return { conn, got };
    };
    relay = createRelay({
      onCommit: () => {
        // an adapter that opens a seat on the room the moment it hears of a commit
        c ??= join('c');
      },
    });
    const a = join('a');
    a.conn.receive({ t: 'env', room: 'r', env: envelope('a', 1, 'x') });

    expect(countOf(a.got, 1)).toBe(1);
    expect(c).toBeDefined();
    expect(countOf(c!.got, 1)).toBe(1);
    expect(c!.got.filter((m) => m.t === 'env')).toHaveLength(0);
  });
});

describe('createRelay: unloading a quiescent room', () => {
  const join = (relay: ReturnType<typeof createRelay>, origin: string) => {
    const sock = socket();
    const conn = relay.connect(sock, { writer: origin });
    conn.receive({
      t: 'hello',
      room: 'r',
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });
    return { sock, conn };
  };
  const write = (conn: RelayConnection, origin: string, version: number) =>
    conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        origin,
        writer: origin,
        version,
        hlc: { p: version, l: 0 },
        policyVersion: 0,
        ops: [set(['x'], version)],
      },
    });

  it('refuses a room somebody is in, and a name it is not holding', () => {
    const relay = createRelay();
    const a = join(relay, 'a');
    write(a.conn, 'a', 1);
    expect(relay.unload('r')).toBe(false);
    expect(relay.unload('never-heard-of')).toBe(false);
    expect(relay.room('r')?.seq).toBe(1);
    a.conn.disconnect();
    expect(relay.unload('r')).toBe(true);
  });

  it('refuses while a durability promise is pending, and allows it once that has landed', async () => {
    const held: Deferred[] = [];
    const relay = createRelay({
      onCommit: () => {
        const d = deferred();
        held.push(d);
        return d.promise;
      },
    });
    const a = join(relay, 'a');
    write(a.conn, 'a', 1);
    a.conn.disconnect();

    expect(relay.unload('r')).toBe(false);
    held[0].resolve();
    await settle();
    expect(relay.unload('r')).toBe(true);
    expect(relay.room('r')).toBeUndefined();
  });

  /**
   * The reason the adapter's hydration gate exists: the relay keeps nothing, so the next hello
   * for an unloaded name starts a brand-new sequence space. An adapter that lets that reach a
   * persisted name grows two histories into one journal.
   */
  it('gives the next hello a fresh room at seq 0, which is why an adapter must re-hydrate before serving', () => {
    const relay = createRelay();
    const a = join(relay, 'a');
    write(a.conn, 'a', 1);
    write(a.conn, 'a', 2);
    expect(relay.room('r')?.seq).toBe(2);
    a.conn.disconnect();

    expect(relay.unload('r')).toBe(true);
    expect(relay.room('r')).toBeUndefined();

    const b = join(relay, 'b');
    expect(welcomeOfSocket(b.sock)?.seq).toBe(0);
    expect(relay.room('r')?.seq).toBe(0);
  });

  /**
   * A rejected durability promise stalls the room for good: the failed head stays queued, every
   * later answer queues behind it, and nothing is ever released again. The adapter, which knows its
   * substrate refused the write and holds the truth, may DISCARD the queue and drop the room; a
   * queue that is merely pending is not its to throw away, and a room with members never is.
   */
  it('drops a stalled room only when the adapter says discard, never a pending one', async () => {
    const held: Deferred[] = [];
    const relay = createRelay({
      onCommit: () => {
        const d = deferred();
        held.push(d);
        return d.promise;
      },
    });
    const a = join(relay, 'a');
    write(a.conn, 'a', 1);
    write(a.conn, 'a', 2);

    /** Pending, not stalled: discard is refused too. */
    expect(relay.room('r')?.stalled).toBe(false);
    a.conn.disconnect();
    expect(relay.unload('r', { discard: true })).toBe(false);

    held[0].reject(new Error('lost the head'));
    await settle();
    expect(relay.room('r')?.stalled).toBe(true);
    expect(relay.unload('r')).toBe(false);

    /** Members present: still refused, whatever the option says. */
    const b = join(relay, 'b');
    expect(relay.unload('r', { discard: true })).toBe(false);
    b.conn.disconnect();

    expect(relay.unload('r', { discard: true })).toBe(true);
    expect(relay.room('r')).toBeUndefined();
    /** The second promise was never awaited: nothing behind the failed head was released. */
    held[1].resolve();
    await settle();
    expect(relay.room('r')).toBeUndefined();
  });

  it('takes a hydrated snapshot after an unload, since the name is free again', () => {
    const relay = createRelay();
    const a = join(relay, 'a');
    write(a.conn, 'a', 1);
    a.conn.disconnect();
    expect(relay.hydrate('r', { seq: 9 })).toBe(false);
    expect(relay.unload('r')).toBe(true);
    expect(relay.hydrate('r', { seq: 9 })).toBe(true);
    expect(relay.room('r')?.seq).toBe(9);
  });
});

const welcomeOfSocket = (sock: ReturnType<typeof socket>) =>
  sock.sent.find((m) => m.t === 'welcome');
