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
  type Relay,
  type RelayConnection,
  type RelayRow,
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
  type SyncSibling,
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
  /** The generation this client last learned from a welcome (the fence rides on every envelope). */
  const instance = (): string => {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
      const m = sock.sent[i];
      if (m.t === 'welcome') return m.instance;
    }
    return 'unwelcomed';
  };
  const env = (ops: SyncOp[], over?: Partial<OpEnvelope>) =>
    conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: instance(),
        origin,
        writer,
        version: ++version,
        hlc: { p: ++p, l: 0 },
        policyVersion: 0,
        ops,
        ...over,
      },
    });
  return { sock, conn, hello, env, instance };
}

/** Admitted, not refused: the submitter got the echo and no drop (a journaled refusal also takes a seq). */
const admitted = (
  sock: { sent: readonly ServerMsg[] },
  origin: string,
  version: number,
): boolean =>
  sock.sent.some(
    (m) =>
      m.t === 'env' && m.env.origin === origin && m.env.version === version,
  ) &&
  !sock.sent.some(
    (m) => m.t === 'drop' && m.origin === origin && m.version === version,
  );
const dropReason = (
  sock: { sent: readonly ServerMsg[] },
  origin: string,
  version: number,
): string | undefined => {
  const m = sock.sent.find(
    (x) => x.t === 'drop' && x.origin === origin && x.version === version,
  );
  return m?.t === 'drop' ? m.reason : undefined;
};

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
  if (welcome.mode !== 'snapshot' || !welcome.registers) {
    throw new Error(`expected a current snapshot welcome, got ${welcome.mode}`);
  }
  return { ...welcome, registers: welcome.registers };
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

  it('garbage collection keeps a lone tombstone: only the superseded set it covers goes', () => {
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
    // the delete stays (a delayed older set under it would otherwise resurrect the key); the
    // superseded set it cited, and the watermark, are what collection removed
    expect(regAt(welcome.registers, ['items', 'a'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'delete', origin: 'oa' }),
    ]);
    expect(regAt(welcome.registers, ['items', 'a'])?.water).toEqual({});
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

  it('[PIN proto 5] the relay speaks protocol 5 (the generation cut) and refuses a v4 hello and a v4 envelope', () => {
    expect(MESH_PROTO_VERSION).toBe(5);
    const relay = createRelay();
    const sock = socket();
    relay.connect(sock, { writer: 'w' }).receive({
      t: 'hello',
      room: 'r',
      origin: 'o',
      proto: 4,
      policyVersion: 0,
    });
    expect(last(sock)).toMatchObject({
      t: 'reject',
      reason: 'proto',
      expected: 5,
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['x'], 1)], { proto: 4 });
    expect(a.sock.closed).toBe(true);
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

    // and writes continue the restored seq space — and the origin's own version sequence: the
    // restored ranges answer a reused version as a duplicate, never with a second seq
    back.env([set(['v'], 3)], { version: 4 });
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
      instance: 'g',
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

describe('relay hydrate across a protocol upgrade (K-diff, proto 4)', () => {
  it('[PIN N1 relay journal suffix] a journal with an old-proto prefix keeps only its current-proto suffix: a joiner behind it is answered with a snapshot, so a delta-joiner and a snapshot-joiner end with the same registers', () => {
    const mk = (seq: number, proto: number, path: string): SeqEnvelope => ({
      proto,
      instance: 'g',
      origin: 'oa',
      writer: 'wa',
      version: seq,
      hlc: { p: seq, l: 0 },
      policyVersion: 0,
      ops: [set([path], seq)],
      seq,
    });
    const journal = [
      mk(1, 3, 'x'),
      mk(2, 3, 'y'),
      mk(3, MESH_PROTO_VERSION, 'z'),
    ];
    const all = createRegisterStore();
    for (const e of journal) all.ingest(e);
    const relay = createRelay();
    relay.hydrate('r', {
      seq: 3,
      instance: 'g',
      registers: all.checkpoint(),
      wm: { oa: 3 },
      journal,
    });
    expect(relay.room('r')).toMatchObject({ journal: 1 });

    // the joiner applied seq 1 before the upgrade; a client only ever folds current-proto envelopes
    const joinerAt1 = createRegisterStore();
    joinerAt1.ingest(journal[0]);
    const behind = client(relay, 'wb', 'ob');
    behind.hello(1);
    const welcome = last(behind.sock) as unknown as {
      mode: string;
      envs?: SeqEnvelope[];
      registers?: RegisterCheckpoint[];
    };
    if (welcome.mode === 'delta') {
      for (const e of welcome.envs ?? [])
        if (e.proto === MESH_PROTO_VERSION) joinerAt1.ingest(e);
    } else {
      joinerAt1.reset();
      joinerAt1.load(welcome.registers ?? []);
    }
    const fresh = client(relay, 'wf', 'of');
    fresh.hello();
    const snapshotJoiner = createRegisterStore();
    snapshotJoiner.load(snapshotOf(fresh.sock).registers);
    expect(welcome.mode).toBe('snapshot');
    expect(joinerAt1.checkpoint()).toEqual(snapshotJoiner.checkpoint());
  });
});

describe('relay hydrate: the exact delta boundary and journalLimit 0 (astra r3 B1)', () => {
  const mk = (seq: number, proto: number): SeqEnvelope => ({
    proto,
    instance: 'g',
    origin: 'oa',
    writer: 'wa',
    version: seq,
    hlc: { p: seq, l: 0 },
    policyVersion: 0,
    ops: [set([`k${seq}`], seq)],
    seq,
  });
  const relayWith = (
    journal: SeqEnvelope[],
    opt?: { journalLimit?: number },
  ) => {
    const regs = createRegisterStore();
    for (const e of journal) regs.ingest(e);
    const relay = createRelay(opt);
    relay.hydrate('r', {
      seq: journal.length,
      instance: 'g',
      registers: regs.checkpoint(),
      wm: { oa: journal.length },
      journal,
    });
    return relay;
  };
  const modeAt = (
    relay: ReturnType<typeof createRelay>,
    seq: number,
    origin: string,
  ) => {
    const c = client(relay, `w${origin}`, origin);
    c.hello(seq);
    return last(c.sock) as unknown as { mode: string; envs?: SeqEnvelope[] };
  };

  it('[PIN B relay boundary] first kept seq 3 (old prefix 1, 2): seq 1 = firstKept − 2 ⇒ snapshot; seq 2 = firstKept − 1 ⇒ delta of the suffix [3,4]; seq 4 ⇒ up-to-date', () => {
    const relay = relayWith([
      mk(1, 3),
      mk(2, 3),
      mk(3, MESH_PROTO_VERSION),
      mk(4, MESH_PROTO_VERSION),
    ]);
    expect(modeAt(relay, 1, 'o1').mode).toBe('snapshot');
    const delta = modeAt(relay, 2, 'o2');
    expect(delta.mode).toBe('delta');
    expect((delta.envs ?? []).map((e) => e.seq)).toEqual([3, 4]);
    expect(modeAt(relay, 4, 'o4').mode).toBe('up-to-date');
  });

  it('[PIN B all-old journal] a journal of only protocol-3 entries keeps nothing: seq 1 ⇒ snapshot, seq 2 (= room seq) ⇒ up-to-date', () => {
    const relay = relayWith([mk(1, 3), mk(2, 3)]);
    expect(relay.room('r')).toMatchObject({ journal: 0 });
    expect(modeAt(relay, 1, 'o1').mode).toBe('snapshot');
    expect(modeAt(relay, 2, 'o2').mode).toBe('up-to-date');
  });

  it('[PIN B1 journalLimit 0] keeps no journal at hydrate or after an admission; a behind client gets a snapshot', () => {
    const relay = relayWith(
      [mk(1, MESH_PROTO_VERSION), mk(2, MESH_PROTO_VERSION)],
      { journalLimit: 0 },
    );
    expect(relay.room('r')).toMatchObject({ journal: 0 });
    expect(modeAt(relay, 1, 'o1').mode).toBe('snapshot');
    const w = client(relay, 'ww', 'ow');
    w.hello(2);
    w.env([set(['z'], 1)]);
    expect(relay.room('r')).toMatchObject({ seq: 3, journal: 0 });
  });

  it('[PIN B limit 1 + future entry] snapshot seq 4, journal (1,3),(2,3),(3,4),(4,4),(5,4), journalLimit 1: the future entry 5 is filtered, only seq 4 is kept; seq 2 ⇒ snapshot, seq 3 ⇒ delta [4], seq 4 ⇒ up-to-date', () => {
    const journal = [
      mk(1, 3),
      mk(2, 3),
      mk(3, MESH_PROTO_VERSION),
      mk(4, MESH_PROTO_VERSION),
      mk(5, MESH_PROTO_VERSION),
    ];
    const regs = createRegisterStore();
    for (const e of journal.slice(0, 4)) regs.ingest(e);
    const relay = createRelay({ journalLimit: 1 });
    relay.hydrate('r', {
      seq: 4,
      instance: 'g',
      registers: regs.checkpoint(),
      wm: { oa: 4 },
      journal,
    });
    expect(relay.room('r')).toMatchObject({ seq: 4, journal: 1 });
    expect(modeAt(relay, 2, 'o2').mode).toBe('snapshot');
    const delta = modeAt(relay, 3, 'o3');
    expect(delta.mode).toBe('delta');
    expect((delta.envs ?? []).map((e) => e.seq)).toEqual([4]);
    expect(modeAt(relay, 4, 'o4').mode).toBe('up-to-date');
  });

  it('[PIN B1 admission trim] with journalLimit 2 the journal never exceeds 2 entries across admissions', () => {
    const relay = relayWith([mk(1, MESH_PROTO_VERSION)], { journalLimit: 2 });
    const w = client(relay, 'ww', 'ow');
    w.hello(1);
    for (let i = 0; i < 3; i++) w.env([set(['z'], i)]);
    expect(relay.room('r')).toMatchObject({ seq: 4, journal: 2 });
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
          instance: relay.room(room)?.instance ?? '',
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

describe('createRegisterStore — settle keeps tombstones and baselines', () => {
  const rEnv = (origin: string, ops: SyncOp[], p: number): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: 'g',
    origin,
    writer: origin,
    version: p,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops,
  });

  it("removes only covered siblings and watermarks at or below the origin's settled stamp; tombstones stay", () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set([], {})], 1));
    store.ingest(rEnv('oa', [set(['items'], { a: 1 })], 2));
    store.ingest(rEnv('oa', [set(['items', 'deep'], 9)], 3));
    store.ingest(
      rEnv(
        'oa',
        [
          del(
            ['items'],
            { a: 1 },
            { cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }] },
          ),
        ],
        4,
      ),
    );
    store.ingest(
      rEnv(
        'oa',
        [
          del(['items', 'deep'], 9, {
            cites: [{ origin: 'oa', hlc: { p: 3, l: 0 } }],
          }),
        ],
        5,
      ),
    );
    store.settle({ oa: { p: 100, l: 0 } });
    const cps = store.checkpoint();
    // a register keeps one sibling per origin, so the deletes replaced the sets; what settle
    // removed are the citation watermarks they left behind — the tombstones are untouched
    expect(regAt(cps, ['items'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'delete' }),
    ]);
    expect(regAt(cps, ['items', 'deep'])?.siblings).toEqual([
      expect.objectContaining({ kind: 'delete' }),
    ]);
    expect(regAt(cps, ['items'])?.water).toEqual({});
  });

  it('never lowers the epoch baseline, even when the sibling that carried it is collected', () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set(['x'], 1, { epoch: 5 })], 1));
    store.ingest(
      rEnv(
        'ob',
        [
          {
            kind: 'clear',
            path: ['x'],
            cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }],
            epoch: 0,
          },
        ],
        1,
      ),
    );
    store.settle({ oa: { p: 1, l: 0 }, ob: { p: 1, l: 0 } });
    expect(
      regAt(store.checkpoint(), ['x'])?.siblings.map((sib) => sib.origin),
    ).toEqual(['ob']);
    expect(store.maxEpoch(['x'])).toBe(5);
    const reloaded = createRegisterStore();
    reloaded.load(store.checkpoint());
    expect(reloaded.maxEpoch(['x'])).toBe(5);
  });
});

describe('createRegisterStore: a delete sibling carries no prev', () => {
  // `prev` on a retained sibling is the ancestor a client merge fold reads, and folds read it on
  // set siblings only; a delete op on the wire keeps its own `prev` for the emitter's inversion
  const rEnv = (origin: string, ops: SyncOp[], p: number): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: 'g',
    origin,
    writer: origin,
    version: p,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops,
  });
  const setWithPrev = (path: Key[], next: unknown, prev: unknown): SyncOp => ({
    kind: 'set',
    path,
    next,
    prev,
    cites: [],
    epoch: 0,
  });

  it('ingest retains a set sibling prev and drops a delete sibling prev', () => {
    const store = createRegisterStore();
    const gone = rEnv('oa', [del(['k'], { big: 'record' })], 1);
    store.ingest(gone);
    store.ingest(rEnv('ob', [setWithPrev(['k'], 2, 1)], 2));
    const sibs = regAt(store.checkpoint(), ['k'])?.siblings ?? [];
    const d = sibs.find((s) => s.kind === 'delete') as SyncSibling;
    const s = sibs.find((s) => s.kind === 'set') as SyncSibling;
    expect(Object.hasOwn(d, 'prev')).toBe(false);
    expect(Object.hasOwn(s, 'prev')).toBe(true);
    expect(s.prev).toBe(1);
    expect(Object.hasOwn(gone.ops[0], 'prev')).toBe(true);
  });

  it('load strips prev from an older checkpoint delete sibling, so the next checkpoint is clean', () => {
    const old: RegisterCheckpoint[] = [
      {
        path: ['k'],
        siblings: [
          {
            kind: 'delete',
            prev: { big: 'record' },
            writer: 'oa',
            origin: 'oa',
            hlc: { p: 1, l: 0 },
            epoch: 0,
          },
          {
            kind: 'set',
            value: 2,
            prev: 1,
            writer: 'ob',
            origin: 'ob',
            hlc: { p: 2, l: 0 },
            epoch: 0,
          },
        ],
        water: {},
      },
    ];
    const store = createRegisterStore();
    store.load(old);
    const sibs = regAt(store.checkpoint(), ['k'])?.siblings ?? [];
    expect(sibs).toHaveLength(2);
    const d = sibs.find((s) => s.kind === 'delete') as SyncSibling;
    const s = sibs.find((s) => s.kind === 'set') as SyncSibling;
    expect(Object.hasOwn(d, 'prev')).toBe(false);
    expect(s.prev).toBe(1);
    expect(Object.hasOwn(old[0].siblings[0], 'prev')).toBe(true);
  });

  it('a joiner welcome carries the delete tombstone without the deleted record', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['forks', 'f1'], { big: 'record' })]);
    a.env([
      del(
        ['forks', 'f1'],
        { big: 'record' },
        { cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }] },
      ),
    ]);
    const b = client(relay, 'wb', 'ob');
    b.hello();
    const sibs =
      regAt(snapshotOf(b.sock).registers, ['forks', 'f1'])?.siblings ?? [];
    expect(sibs).toEqual([
      expect.objectContaining({ kind: 'delete', origin: 'oa' }),
    ]);
    expect(Object.hasOwn(sibs[0], 'prev')).toBe(false);
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

describe('createRelay: settled notice', () => {
  it('rides behind the echo of the envelope that trimmed the tail, carrying the per-origin settled stamps', () => {
    const relay = createRelay({ journalLimit: 2 });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();

    a.env([set([], { v: 1 })]); // seq 1
    a.env([set(['v'], 2)]); // seq 2
    a.env([set(['v'], 3)]); // seq 3 -> the tail (limit 2) trims, collection runs

    const kinds = b.sock.sent.map((m) => m.t);
    const at = kinds.indexOf('settled');
    expect(at).toBeGreaterThan(0);
    expect(kinds[at - 1]).toBe('env'); // behind the write, never ahead of it
    const notice = b.sock.sent[at];
    expect(notice).toMatchObject({
      t: 'settled',
      room: 'r',
      settled: { oa: { p: 3, l: 0 } },
    });
  });
});

describe('createRelay: an origin settles from the version it entered the generation at', () => {
  const rig = () => {
    let state: RoomState | undefined;
    const drops: string[] = [];
    const relay = createRelay({
      onCommit: (_room, _env, s) => {
        state = s;
      },
      onDrop: (_room, _env, reason) => drops.push(reason),
    });
    return { relay, drops, state: () => state as RoomState };
  };

  it("a room's creator: its first envelope cut the generation, so it enters at version 2 and settles from there", () => {
    const { relay, state } = rig();
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set([], { v: 1 })], { schemaVersion: 1 }); // version 1 cuts, and is not in the new ranges
    a.env([set(['v'], 2)]);
    a.env([set(['v'], 3)]);

    expect(state().ranges).toEqual({ oa: [[2, 3]] });
    expect(state().settled).toEqual({ oa: { p: 3, l: 0 } });
  });

  it('an origin that lived through a cut carries its counter on and settles from its next version', () => {
    const { relay, state } = rig();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set([], { v: 1 })]);
    a.env([set(['v'], 2)]);
    b.env([set([], { v: 'migrated' })], { schemaVersion: 1 });
    expect(state().ranges).toEqual({});
    expect(state().settled).toEqual({});

    a.env([set(['v'], 3)]);
    a.env([set(['v'], 4)]);

    expect(state().ranges).toEqual({ oa: [[3, 4]] });
    expect(state().settled).toEqual({ oa: { p: 4, l: 0 } });
  });

  it('a version below the one it entered at is refused as out of order, and the settled stamp does not move', () => {
    const { relay, state, drops } = rig();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    b.env([set([], { v: 0 })], { schemaVersion: 1 });
    a.env([set(['v'], 5)], { version: 5 });
    const before = state();

    // older than everything the origin has sent here, which is what would undercut the stamp
    a.env([set(['v'], 'stale')], { version: 2, hlc: { p: 0, l: 1 } });

    expect(drops).toEqual(['order']);
    expect(relay.room('r')).toMatchObject({ seq: before.seq });
    expect(state().settled).toEqual({ oa: { p: 1, l: 0 } });
  });
});

describe('createRelay: epoch-bump admission (canBump)', () => {
  it('an unauthorized epoch RAISE is refused "epoch-bump" — journaled, answered, never ejected; the whole envelope is rejected, never an op mid-log', () => {
    const violations: PolicyViolation[] = [];
    const rows: RelayRow[] = [];
    const relay = createRelay({
      policy: { canBump: (ctx) => ctx.claims?.['role'] === 'owner' },
      onViolation: (_room, v) => violations.push(v),
      onRow: (_room, row) => void rows.push(row),
    });
    const a = client(relay, 'wa', 'oa'); // no owner claim
    a.hello();
    // first op is clean; the second claims precedence — nothing of the envelope may land
    a.env([set(['ok'], 1), set(['doc'], 'mine', { epoch: 1 })]);

    expect(violations).toEqual([]);
    expect(a.sock.closed).toBe(false);
    const drop = {
      t: 'drop',
      room: 'r',
      origin: 'oa',
      version: 1,
      reason: 'epoch-bump',
      seq: 1,
    };
    expect(a.sock.sent.filter((m) => m.t === 'drop')).toEqual([drop]);
    expect(rows).toEqual([
      {
        kind: 'refuse',
        seq: 1,
        instance: expect.any(String),
        origin: 'oa',
        version: 1,
        reason: 'epoch-bump',
      },
    ]);
    // the refusal's row took a seq; the clean first op did not sequence
    expect(relay.room('r')).toMatchObject({ seq: 1, journal: 0 });
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
  it('a cite of a dot the room has no record of is refused "citation" — journaled, answered, never ejected (the forged-watermark vector)', () => {
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

    expect(violations).toEqual([]);
    expect(forger.sock.closed).toBe(false);
    expect(forger.sock.sent.filter((m) => m.t === 'drop')).toEqual([
      {
        t: 'drop',
        room: 'r',
        origin: 'of',
        version: 1,
        reason: 'citation',
        seq: 2,
      },
    ]);
    expect(relay.room('r')).toMatchObject({ seq: 2, journal: 1 });
  });

  it('a refused envelope leaves no admission evidence: its origin gets no ranges entry and no high-water mark', () => {
    let state: RoomState | undefined;
    const relay = createRelay({
      policy: { verifyCitations: true },
      onCommit: (_room, _env, s) => {
        state = s;
      },
    });
    const a = client(relay, 'wa', 'oa');
    const forger = client(relay, 'wf', 'of');
    a.hello();
    forger.hello();
    a.env([set(['doc'], 'real')]);
    forger.env([
      set(['doc'], 'kill', { cites: [{ origin: 'oa', hlc: { p: 99, l: 0 } }] }),
    ]);
    a.env([set(['doc'], 'again')]);

    // an empty entry would ride into every later checkpoint, one per origin ever refused
    expect(state?.ranges).toEqual({ oa: [[1, 2]] });
    expect(state?.wm).toEqual({ oa: 2 });
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
    expect(admitted(b.sock, 'ob', 1)).toBe(true);
    expect(admitted(b.sock, 'ob', 2)).toBe(true);
  });

  it('exempts cites at or below the compaction frontier: a stale-but-honest cite of a compacted dot is admitted', () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      journalLimit: 2,
    });
    const a = client(relay, 'wa', 'oa');
    const c = client(relay, 'wc', 'oc');
    a.hello();
    c.hello();
    a.env([set([], {})]);
    a.env([set(['items', 'a'], 1)]); // (oa, 2.0)
    // oc supersedes (oa, 2.0); once oa settles past 2.0 the trim collects oa's sibling and the
    // watermark, so nothing retained at the path answers for oa any more
    c.env([
      del(['items', 'a'], 1, {
        cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
      }),
    ]);
    a.env([set(['other'], 1)]);

    // an observer that saw (oa, 2.0) before it settled: the relay can no longer verify the cite,
    // and a forged cite down there could kill nothing anyway (below-frontier ops are settled)
    const b = client(relay, 'wb', 'ob');
    b.hello();
    const held = regAt(snapshotOf(b.sock).registers, ['items', 'a']);
    expect(held?.siblings.map((s) => s.origin)).toEqual(['oc']);
    expect(held?.water).toEqual({});
    b.env(
      [
        set(['items', 'a'], 7, {
          cites: [{ origin: 'oa', hlc: { p: 2, l: 0 } }],
        }),
      ],
      { hlc: { p: 50, l: 0 } },
    );
    expect(admitted(b.sock, 'ob', 1)).toBe(true);
    // above oa's settled stamp the exemption answers nothing
    b.env(
      [
        set(['items', 'b'], 7, {
          cites: [{ origin: 'oa', hlc: { p: 40, l: 0 } }],
        }),
      ],
      { hlc: { p: 51, l: 0 } },
    );
    expect(dropReason(b.sock, 'ob', 2)).toBe('citation');
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
    expect(admitted(a.sock, 'oa', 1)).toBe(true);
  });

  it.each([
    [
      'another origin at the same stamp',
      { origin: 'ghost', hlc: { p: 5, l: 0 } },
    ],
  ])(
    'a near miss of the own dot is verified like any cite: %s is refused',
    (_, cite) => {
      const relay = createRelay({ policy: { verifyCitations: true } });
      const a = client(relay, 'wa', 'oa');
      a.hello();
      a.env([set(['doc'], 'x', { cites: [cite] })], { hlc: { p: 5, l: 0 } });
      expect(dropReason(a.sock, 'oa', 1)).toBe('citation');
    },
  );

  it.each([
    [
      'its own origin at a later time',
      { origin: 'oa', hlc: { p: 99, l: 0 } },
      true,
    ],
    [
      'its own origin at a later counter',
      { origin: 'oa', hlc: { p: 5, l: 7 } },
      true,
    ],
    [
      'its own origin at a later time, without verifyCitations',
      { origin: 'oa', hlc: { p: 99, l: 0 } },
      false,
    ],
  ])(
    'an own cite above the stamp is malformed, ejected before the citation gate: %s',
    (_, cite, verifyCitations) => {
      const violations: PolicyViolation[] = [];
      const relay = createRelay({
        policy: { verifyCitations },
        onViolation: (_room, v) => violations.push(v),
      });
      const a = client(relay, 'wa', 'oa');
      const b = client(relay, 'wb', 'ob');
      a.hello();
      b.hello();
      a.env([set(['doc'], 'x', { cites: [cite] })], { hlc: { p: 5, l: 0 } });
      expect(violations).toEqual([
        { writer: 'wa', reason: 'malformed', detail: 'cites' },
      ]);
      expect(last(a.sock)).toMatchObject({ t: 'eject', reason: 'malformed' });
      expect(a.sock.closed).toBe(true);
      expect(a.sock.sent.some((m) => m.t === 'drop')).toBe(false);
      expect(
        b.sock.sent.some((m) => m.t === 'env' && m.env.origin === 'oa'),
      ).toBe(false);
    },
  );

  it('a same-time stamp with a higher counter is not covered by the lower one', () => {
    const relay = createRelay({ policy: { verifyCitations: true } });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set(['doc'], 'v1')], { hlc: { p: 5, l: 0 } });
    b.env([
      set(['doc'], 'w', { cites: [{ origin: 'oa', hlc: { p: 5, l: 3 } }] }),
    ]);
    expect(dropReason(b.sock, 'ob', 1)).toBe('citation');
  });

  it("a cite of an origin's own skipped version stamp is covered by the store's extent", () => {
    const relay = createRelay({ policy: { verifyCitations: true } });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set(['b'], 1)], { version: 1, hlc: { p: 1, l: 0 } });
    a.env([set(['b'], 3)], { version: 3, hlc: { p: 3, l: 0 } });
    b.env([
      set(['b'], 'w', { cites: [{ origin: 'oa', hlc: { p: 3, l: 0 } }] }),
    ]);
    expect(admitted(b.sock, 'ob', 1)).toBe(true);
  });

  it("the settled exemption is floored at the cited origin's first stamp of the generation", () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      journalLimit: 1,
    });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set([], {})], { hlc: { p: 5, l: 0 } });
    a.env([set(['x'], 1)], { hlc: { p: 6, l: 0 } });
    // oa never wrote at 3: below its first stamp the exemption answers nothing
    b.env([
      set(['y'], 'w', { cites: [{ origin: 'oa', hlc: { p: 3, l: 0 } }] }),
    ]);
    expect(dropReason(b.sock, 'ob', 1)).toBe('citation');
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
    expect(admitted(a.sock, 'oa', 1)).toBe(true);
  });
});

describe('createRegisterStore — admission reads (maxEpoch / covers)', () => {
  const rEnv = (origin: string, ops: SyncOp[], p: number): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: 'g',
    origin,
    writer: origin,
    version: p,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops,
  });

  it('siblings: the live ones at a path, none that a citation superseded, none where nothing is retained', () => {
    const store = createRegisterStore();
    store.ingest(rEnv('oa', [set(['doc'], 'a')], 1));
    store.ingest(rEnv('ob', [set(['doc'], 'b')], 2)); // concurrent with oa: both live
    const seen = (path: string[]) =>
      store
        .siblings(path)
        .map((s) => [s.origin, s.kind === 'set' ? s.value : s.kind])
        .sort();
    expect(seen(['doc'])).toEqual([
      ['oa', 'a'],
      ['ob', 'b'],
    ]);
    // oc cites oa's dot: oa's sibling is superseded and leaves the live set; ob's stays
    store.ingest(
      rEnv(
        'oc',
        [set(['doc'], 'c', { cites: [{ origin: 'oa', hlc: { p: 1, l: 0 } }] })],
        3,
      ),
    );
    expect(seen(['doc'])).toEqual([
      ['ob', 'b'],
      ['oc', 'c'],
    ]);
    // a delete is a live sibling too, carried with its kind
    store.ingest(
      rEnv(
        'od',
        [del(['doc'], 'c', { cites: [{ origin: 'oc', hlc: { p: 3, l: 0 } }] })],
        4,
      ),
    );
    expect(seen(['doc'])).toEqual([
      ['ob', 'b'],
      ['od', 'delete'],
    ]);
    expect(store.siblings(['elsewhere'])).toEqual([]);
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
          instance: relay.room(room)?.instance ?? '',
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
    const refused = writeTo('w4', 'o4', 'open-room', [
      set(['x'], 1, { epoch: 1 }),
    ]);
    expect(refused.closed).toBe(false); // refused, not ejected
    expect(refused.sent.filter((m) => m.t === 'drop')).toMatchObject([
      { reason: 'epoch-bump' },
    ]);
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
        // nothing is owed: release at once, and a submit made from inside `emit` queues behind it
        draining = true;
        for (const msg of msgs) emit(msg);
        draining = false;
        if (queue.length > 0) void drain();
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
  type MakeGate = (emit: (id: number) => void) => Gate<number>;
  const run = async (seed: number, make: MakeGate = releaseGate) => {
    const rnd = mulberry32(seed);
    const n = 3 + Math.floor(rnd() * 6);
    const groups: Group[] = [];
    for (let i = 0; i < n; i++) {
      groups.push({ id: i, d: rnd() < 0.3 ? undefined : deferred() });
    }

    const resolved = new Set<number>();
    const emitted: { id: number; resolvedThen: ReadonlySet<number> }[] = [];
    const gate = make((id) =>
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

  /** The first group emitted before it or an earlier group was durable, if any. */
  const early = (
    emitted: readonly { id: number; resolvedThen: ReadonlySet<number> }[],
  ): number | undefined =>
    emitted.find((e) =>
      Array.from({ length: e.id + 1 }, (_, j) => j).some(
        (j) => !e.resolvedThen.has(j),
      ),
    )?.id;

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

  it('a group submitted from inside an emit releases after the group in flight (re-entrant, 500 seeds)', async () => {
    for (let seed = 0; seed < 500; seed++) {
      const rnd = mulberry32(seed);
      const submitted: number[] = [];
      const emitted: number[] = [];
      const pending: Deferred[] = [];
      let budget = 2 + Math.floor(rnd() * 8);
      let ids = 0;
      const submit = (): void => {
        const id = ids++;
        submitted.push(id * 10, id * 10 + 1);
        let d: Deferred | undefined;
        if (rnd() < 0.3) pending.push((d = deferred()));
        gate.submit([id * 10, id * 10 + 1], d?.promise);
      };
      const gate: Gate<number> = releaseGate<number>((msg) => {
        emitted.push(msg);
        if (budget > 0 && rnd() < 0.5) {
          budget--;
          submit();
        }
      });
      const top = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < top; i++) {
        submit();
        if (pending.length && rnd() < 0.5) pending.shift()?.resolve();
        await settle(4);
      }
      while (pending.length) {
        pending.shift()?.resolve();
        await settle();
      }
      await settle();
      expect(emitted, `seed ${seed}`).toEqual(submitted);
    }
  });

  it('an ungated emitter fails the same safety assertion over the same schedules (the property is not vacuous)', async () => {
    const ungated: MakeGate = (emit) => ({
      submit: (msgs) => msgs.forEach(emit),
      pending: () => 0,
    });
    let caught = 0;
    for (let seed = 0; seed < 200; seed++) {
      if (early((await run(seed, ungated)).emitted) !== undefined) caught++;
      expect(early((await run(seed)).emitted), `seed ${seed}`).toBeUndefined();
    }
    expect(caught).toBeGreaterThan(100);
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

  // ───────────────────────────────────────────────────────────────────────
  // Acknowledgement by duplicate, and where a persistence hook sits in the release order.
  // A resend of an admitted version is answered with a `drop` 'duplicate', which the client
  // counts as the acknowledgement, exactly like the echo. The persistence hook runs after the room
  // admitted the row and may re-enter the room synchronously (a resend of that row, a reconnect of
  // its origin, another origin's join or write). The driver keeps its own storage log (what the
  // adapter was told and how each promise settled); every durability property reads that log,
  // never the room model's bookkeeping.
  //   D1   no acknowledgement of v (its echo to the submitter, a duplicate drop, a delta welcome
  //        carrying it) before v is durable, and no welcome at seq s before the rows up to s are
  //   D1p  no acknowledgement or echo of v before every row up to v's is durable
  //   D2   per connection, welcome and env seqs strictly increase, and a duplicate drop never
  //        comes before the echo of its version (property R of relay-order.spec.ts, which lets a
  //        migration's re-welcome share its envelope's seq; this model has no migration)
  //   D3   in a room that is NOT stalled: nothing pending means the duplicate drop is out before
  //        the step returns; everything settled means every held duplicate drop to an open
  //        connection is out. A stalled room answers nothing, and a duplicate held behind a later
  //        row that fails is never sent: the accepted, conservative outcome
  //   D4   no acknowledgement of a version whose row failed, in that room life
  //   D5   'generation', 'schema' and 'order' drops are out before the step returns
  //   D6   nothing that carries document state (echo, welcome, duplicate drop) is released while a
  //        persistence hook runs: whatever the hook submits is released after its row
  //   D7   a step that starts idle and meets only void hooks ends, when its outermost call
  //        returns, with nothing queued and every open connection holding all it was owed, in
  //        the order the driver caused it (echoes, duplicate drops, welcomes; the driver's own
  //        account). A call nested inside a hook cannot release before that hook returns
  //   NL   after a crash, the room rebuilt from the durable prefix of the storage log holds every
  //        acknowledged version
  //   LV   after that crash, a reconnect and settling everything, every write is acknowledged
  //        (no refusal is legitimate: the scripts are honest and probes never touch the outbox)
  //   U    the adapter is told a version at most once per room life
  //   H    an honest client is never refused 'order'
  // NON-COVERAGE: one room, two writer origins; no cuts, migrations or journaled refusals (their
  // hook sites have the commit hook's shape and are covered by rows in relay-durability.spec.ts);
  // a hook that throws, a throwing `onDrop` and unhandled rejections (real-relay rows in
  // relay-durability.spec.ts: a throw is synchronous, so it has no schedule to sweep); a welcome is its seq plus, for a delta, the envs above the hello's seq, never
  // register contents; the client-to-relay link is lossless FIFO while open and a send on a closed
  // link is lost; a crash keeps exactly the durable prefix of the storage log (the most
  // conservative adapter `unload` allows), so an adapter keeping later resolved rows past a gap is
  // not modeled; a client's own restart is a reconnect with the same outbox; the session keeps a
  // write refused 'generation' and asks for a snapshot, and that branch is not modeled because no
  // outbox write can be refused 'generation' here (one generation, probes use versions outside the
  // outbox); policy, ejection, presence and `onDrop` timing are out. relay-order.spec.ts's
  // generator drives the real relay's API (hello, cuts, typed sockets) and cannot be pointed at
  // this model; D2 here is its property R, over the hook re-entries it does not generate.
  // ───────────────────────────────────────────────────────────────────────

  type Stale = 'generation' | 'schema';
  type DropWhy = Stale | 'order' | 'duplicate';
  type Ref = {
    readonly origin: string;
    readonly version: number;
    readonly seq: number;
  };
  type Wire =
    | {
        readonly t: 'welcome';
        readonly seq: number;
        readonly envs?: readonly Ref[];
      }
    | ({ readonly t: 'env' } & Ref)
    | {
        readonly t: 'drop';
        readonly origin: string;
        readonly version: number;
        readonly reason: DropWhy;
      };
  /** How the room answers a resend of a version its admission evidence holds. */
  type AckRule = 'immediate' | 'queued' | 'per-row' | 'admit-after-durable';
  /**
   * Where a row's release item enters the queue: after its hook returns (`after-hook`), in a slot
   * reserved before the hook (`reserved`), or at a mark taken before the hook while a flag queues
   * every submit and stops the drain (`mark`).
   */
  type Order = 'after-hook' | 'reserved' | 'mark';
  type Neuter =
    | 'queue-refusals'
    | 'echo-on-own-promise'
    | 'async-release'
    | 'lose-release';
  type Conn = { readonly owner: string; open: boolean; readonly got: Wire[] };
  type Held = {
    readonly conn: Conn;
    readonly origin: string;
    readonly version: number;
    out: boolean;
  };
  type Hook = (row: Ref) => Promise<void> | undefined;
  type Place = (run: () => void, done?: Promise<void>) => void;

  function slotGate(onFail: () => void, neuter?: Neuter) {
    const async = neuter === 'async-release';
    type Item = { run?: () => void; done?: Promise<void>; open: boolean };
    const queue: Item[] = [];
    let stalled = false;
    let draining = false;
    let holding = 0;
    const drain = async (): Promise<void> => {
      if (draining || holding > 0) return;
      draining = true;
      while (!stalled && queue.length > 0) {
        const head = queue[0];
        if (head.open) break;
        if (head.done) {
          try {
            await head.done;
          } catch {
            stalled = true;
            onFail();
            break;
          }
        }
        queue.shift();
        head.run?.();
      }
      draining = false;
    };
    const kick = (): void => {
      if (stalled) return;
      if (async) void Promise.resolve().then(drain);
      else void drain();
    };
    return {
      submit: (run: () => void, done?: Promise<void>): void => {
        const idle = !draining && holding === 0 && queue.length === 0;
        if (!async && !stalled && idle && done === undefined) {
          draining = true;
          try {
            run();
          } finally {
            draining = false;
          }
          if (queue.length > 0) void drain();
          return;
        }
        queue.push({ run, done, open: false });
        kick();
      },
      reserve: (): Place => {
        const item: Item = { open: true };
        queue.push(item);
        return (run, done) => {
          // the neuter loses a void row's release: the queue still empties
          item.run = neuter === 'lose-release' && !done ? undefined : run;
          item.done = done;
          item.open = false;
          kick();
        };
      },
      hold: (): Place => {
        const mark = queue.length;
        holding++;
        return (run, done) => {
          holding--;
          queue.splice(mark, 0, { run, done, open: false });
          kick();
        };
      },
      pending: () => queue.length,
    };
  }

  function ackRoom(o: {
    readonly rule: AckRule;
    readonly order: Order;
    readonly substrate: readonly Ref[];
    readonly journal: boolean;
    readonly deliver: (conn: Conn, msg: Wire) => void;
    readonly hook: Hook;
    readonly neuter?: Neuter;
  }) {
    type Row = Ref & { settled: boolean; d?: Promise<void> };
    const rows: Row[] = o.substrate.map((r) => ({ ...r, settled: true }));
    let seq = rows.reduce((m, r) => Math.max(m, r.seq), 0);
    const evidence = new Map<string, Set<number>>();
    const note = (origin: string, version: number): void => {
      let s = evidence.get(origin);
      if (!s) evidence.set(origin, (s = new Set()));
      s.add(version);
    };
    for (const r of rows) note(r.origin, r.version);
    const members = new Set<Conn>();
    const held: Held[] = [];
    let stalled = false;
    let dead = false;
    const gate = slotGate(() => {
      stalled = true;
    }, o.neuter);
    const send = (conn: Conn, msg: Wire): boolean => {
      if (dead || !conn.open || !members.has(conn)) return false;
      o.deliver(conn, msg);
      return true;
    };
    const refuseNow = (conn: Conn, msg: Wire): void => {
      if (o.neuter === 'queue-refusals') gate.submit(() => send(conn, msg));
      else send(conn, msg);
    };
    const duplicate = (conn: Conn, origin: string, version: number): void => {
      const entry: Held = { conn, origin, version, out: false };
      held.push(entry);
      const msg: Wire = { t: 'drop', origin, version, reason: 'duplicate' };
      const out = (): void => {
        entry.out = send(conn, msg);
      };
      if (o.rule === 'immediate' || o.rule === 'admit-after-durable')
        return out();
      if (o.rule === 'queued') return gate.submit(out);
      const row = rows.find(
        (r) => r.origin === origin && r.version === version,
      );
      if (!row?.d || row.settled) return out();
      void row.d.then(out, () => undefined);
    };
    const admit = (origin: string, version: number): void => {
      const row: Row = { origin, version, seq: ++seq, settled: false };
      rows.push(row);
      if (o.rule !== 'admit-after-durable') note(origin, version);
      const audience = [...members];
      const fan = (): void => {
        for (const m of audience)
          send(m, { t: 'env', origin, version, seq: row.seq });
      };
      const place =
        o.order === 'reserved'
          ? gate.reserve()
          : o.order === 'mark'
            ? gate.hold()
            : undefined;
      const d = o.hook({ origin, version, seq: row.seq });
      row.d = d;
      const durable = (): void => {
        row.settled = true;
        if (o.rule === 'admit-after-durable') note(origin, version);
      };
      if (d) void d.then(durable, () => undefined);
      else durable();
      if (o.neuter === 'echo-on-own-promise') {
        place?.(() => undefined);
        if (d) void d.then(fan, () => undefined);
        else fan();
        return;
      }
      if (place) place(fan, d);
      else gate.submit(fan, d);
    };

    return {
      held,
      members,
      stalled: () => stalled,
      pending: () => gate.pending(),
      canOrder: (origin: string) => (evidence.get(origin)?.size ?? 0) > 0,
      /** A same-origin hello displaces the connection that origin held. */
      hello: (conn: Conn, since?: number): void => {
        for (const m of [...members]) {
          if (m.owner !== conn.owner) continue;
          members.delete(m);
          m.open = false;
        }
        members.add(conn);
        const at = seq;
        const envs =
          o.journal && since !== undefined
            ? rows
                .filter((r) => r.seq > since)
                .map((r) => ({
                  origin: r.origin,
                  version: r.version,
                  seq: r.seq,
                }))
            : undefined;
        gate.submit(() => send(conn, { t: 'welcome', seq: at, envs }));
      },
      leave: (conn: Conn): void => {
        members.delete(conn);
      },
      receive: (
        conn: Conn,
        origin: string,
        version: number,
        stale?: Stale,
      ): void => {
        if (dead || !members.has(conn)) return;
        if (stale)
          return refuseNow(conn, { t: 'drop', origin, version, reason: stale });
        const ev = evidence.get(origin);
        if (ev?.has(version)) return duplicate(conn, origin, version);
        if (ev && version < Math.max(...ev))
          return refuseNow(conn, {
            t: 'drop',
            origin,
            version,
            reason: 'order',
          });
        admit(origin, version);
      },
      kill: (): void => {
        dead = true;
        for (const m of members) m.open = false;
        members.clear();
      },
    };
  }
  type AckRoom = ReturnType<typeof ackRoom>;

  /** What a persistence hook does to the room before it returns. */
  type Reentry = 'resend' | 'reconnect' | 'join-other' | 'write-other';
  const reentries: readonly Reentry[] = [
    'resend',
    'reconnect',
    'join-other',
    'write-other',
  ];
  type Ev =
    | {
        readonly k: 'write';
        readonly who: string;
        readonly gated?: boolean;
        readonly inHook?: Reentry;
      }
    | {
        readonly k: 'resend' | 'settle' | 'fail';
        readonly who: string;
        readonly v: number;
      }
    | { readonly k: 'leave' | 'join' | 'reconnect'; readonly who: string }
    | { readonly k: 'crash' }
    | { readonly k: 'discard' }
    | {
        readonly k: 'probe';
        readonly who: string;
        readonly reason: Stale | 'order';
      };

  /** The client session as the model sees it: an outbox, and what it counts acknowledged. */
  type Client = {
    readonly origin: string;
    conn?: Conn;
    welcomed: boolean;
    version: number;
    /** The highest seq heard: the hello's `seq`, so a journaled room answers with a delta. */
    seen: number;
    readonly unacked: Set<number>;
    readonly acked: Set<number>;
    readonly refused: Set<number>;
  };
  /** The driver's own record of one hook call: what the adapter was told and how it settled. */
  type Stored = Ref & {
    state: 'told' | 'ok' | 'failed';
    readonly d?: Deferred;
  };

  type AckRun = {
    readonly rule: AckRule;
    readonly order?: Order;
    readonly seed?: number;
    readonly script?: readonly Ev[];
    /** The client counts a duplicate drop only after it saw the echo (alternative b). */
    readonly echoFirst?: boolean;
    readonly neuter?: Neuter;
    readonly journal?: boolean;
    readonly voidHooks?: boolean;
    /** Re-entrant writes and hook re-entries in random runs (default on). */
    readonly reentry?: boolean;
  };
  const key = (r: { origin: string; version: number }): string =>
    `${r.origin}#${r.version}`;
  const ackWorld = (run: AckRun) => {
    const rnd = mulberry32(run.seed ?? 0);
    const random = run.script === undefined;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const order = run.order ?? 'after-hook';
    const journal = run.journal ?? (random && rnd() < 0.5);
    const voidOnly = run.voidHooks ?? (random && rnd() < 0.3);
    const violations: string[] = [];
    const firstAt = new Map<string, number>();
    const trace: Ev[] = [];
    const heard: { life: number; owner: string; msg: Wire }[] = [];
    const stats = {
      pendingResends: 0,
      held: 0,
      fails: 0,
      crashes: 0,
      discards: 0,
      probes: 0,
      reentrant: 0,
      hookReentry: 0,
      gatedHooks: 0,
      voidSteps: 0,
      voidOwed: 0,
      voidShort: 0,
    };
    const flag = (tag: string, what: string): void => {
      if (!firstAt.has(tag)) firstAt.set(tag, trace.length);
      violations.push(`${tag}: ${what}`);
    };
    let life = 0;
    let substrate: Ref[] = [];
    let storage: Stored[] = [];
    const inHook: Stored[] = [];
    let budget = 0;
    let gatedOnce: boolean | undefined;
    let reentryOnce: Reentry | undefined;
    const gatedNow = (): boolean => {
      const g = gatedOnce;
      gatedOnce = undefined;
      if (g !== undefined) return g;
      if (voidOnly) return false;
      return random ? rnd() < 0.75 : true;
    };
    const clients: Client[] = ['a', 'b'].map((origin) => ({
      origin,
      welcomed: false,
      version: 0,
      seen: 0,
      unacked: new Set<number>(),
      acked: new Set<number>(),
      refused: new Set<number>(),
    }));
    const byOrigin = (o: string): Client =>
      clients.find((c) => c.origin === o) as Client;
    const other = (o: string): Client => byOrigin(o === 'a' ? 'b' : 'a');
    let room!: AckRoom;

    /**
     * What each connection is owed by the end of the current step, in the order the driver caused
     * it, read from the driver's own storage log: a fresh version's echo to every connected client,
     * a resend's duplicate drop to its sender, a hello's welcome.
     */
    let owed: { readonly conn: Conn; readonly name: string; at: number }[] = [];
    const owe = (conn: Conn, name: string): void =>
      void owed.push({ conn, name, at: conn.got.length });
    const nameOf = (msg: Wire): string =>
      msg.t === 'welcome'
        ? 'welcome'
        : msg.t === 'env' || msg.reason === 'duplicate'
          ? `${msg.t} ${key(msg)}`
          : `${msg.reason} ${key(msg)}`;
    const send = (c: Client, v: number): void => {
      if (!c.conn) return;
      const mine = storage.filter((e) => e.origin === c.origin);
      if (mine.some((e) => e.version === v))
        owe(c.conn, `drop ${c.origin}#${v}`);
      else if (mine.every((e) => e.version < v))
        for (const x of clients)
          if (x.conn) owe(x.conn, `env ${c.origin}#${v}`);
      room.receive(c.conn, c.origin, v);
    };
    const flush = (c: Client): void => {
      for (const v of [...c.unacked].sort((x, y) => x - y)) send(c, v);
    };
    const write = (c: Client): void => {
      c.unacked.add(++c.version);
      send(c, c.version);
    };
    const ack = (c: Client, v: number): void => {
      c.unacked.delete(v);
      c.acked.add(v);
    };
    const connect = (c: Client): void => {
      const conn: Conn = { owner: c.origin, open: true, got: [] };
      c.conn = conn;
      owe(conn, 'welcome');
      room.hello(conn, c.seen > 0 ? c.seen : undefined);
      if (c.welcomed) flush(c);
    };
    const disconnect = (c: Client): void => {
      if (!c.conn) return;
      c.conn.open = false;
      room.leave(c.conn);
      c.conn = undefined;
    };

    const reenter = (what: Reentry, row: Ref): void => {
      const owner = byOrigin(row.origin);
      const peer = other(row.origin);
      if (what === 'resend') send(owner, row.version);
      else if (what === 'reconnect') connect(owner);
      else if (what === 'join-other') connect(peer);
      else if (peer.conn) write(peer);
    };
    const hook: Hook = (row) => {
      const gated = gatedNow();
      const e: Stored = {
        ...row,
        state: 'told',
        d: gated ? deferred() : undefined,
      };
      storage.push(e);
      inHook.push(e);
      let what = reentryOnce;
      reentryOnce = undefined;
      if (!what && budget > 0 && rnd() < 0.3) {
        budget--;
        what = pick(reentries);
      }
      if (what) {
        stats.hookReentry++;
        reenter(what, row);
      }
      inHook.pop();
      if (gated) stats.gatedHooks++;
      else e.state = 'ok'; // a void hook is durable the moment it returns
      return e.d?.promise;
    };

    const prefixOk = (s: number): boolean =>
      storage.every((x) => x.seq > s || x.state === 'ok');
    const deliver = (conn: Conn, msg: Wire): void => {
      const name =
        msg.t === 'welcome' ? `welcome@${msg.seq}` : `${msg.t} ${key(msg)}`;
      const carries = msg.t !== 'drop' || msg.reason === 'duplicate';
      if (carries && inHook.length > 0)
        flag(
          'D6',
          `${conn.owner} got ${name} while the hook of ${key(inHook[inHook.length - 1])} ran`,
        );
      if (msg.t !== 'drop') {
        const prev = [...conn.got].reverse().find((m) => m.t !== 'drop');
        if (prev && msg.seq <= prev.seq)
          flag('D2', `${conn.owner} read seq ${msg.seq} after ${prev.seq}`);
      }
      const dupBefore = conn.got.some(
        (m) =>
          m.t === 'drop' &&
          m.reason === 'duplicate' &&
          m.origin === (msg as Ref).origin &&
          m.version === (msg as Ref).version,
      );
      if (msg.t === 'env' && dupBefore)
        flag(
          'D2',
          `${conn.owner} heard the duplicate before the echo of ${key(msg)}`,
        );
      const ackOf = (
        r: { origin: string; version: number },
        what: string,
      ): void => {
        const of = storage.filter(
          (e) => e.origin === r.origin && e.version === r.version,
        );
        if (!of.some((e) => e.state === 'ok'))
          flag('D1', `${conn.owner} told ${what} before it was durable`);
        if (
          of.some((e) => e.state === 'failed') &&
          !of.some((e) => e.state === 'ok')
        )
          flag('D4', `${conn.owner} told ${what} after it failed`);
        if (!of.some((e) => prefixOk(e.seq)))
          flag(
            'D1p',
            `${conn.owner} told ${what} before its prefix was durable`,
          );
      };
      if (msg.t === 'env') {
        if (msg.origin === conn.owner) ackOf(msg, name);
        else if (!prefixOk(msg.seq))
          flag(
            'D1p',
            `${conn.owner} told ${name} before its prefix was durable`,
          );
      } else if (msg.t === 'drop' && msg.reason === 'duplicate') {
        ackOf(msg, name);
      } else if (msg.t === 'welcome') {
        if (!prefixOk(msg.seq))
          flag(
            'D1',
            `${conn.owner} welcomed at seq ${msg.seq} before it was durable`,
          );
        for (const e of msg.envs ?? [])
          if (e.origin === conn.owner) ackOf(e, `welcome/delta ${key(e)}`);
      }
      conn.got.push(msg);
      heard.push({ life, owner: conn.owner, msg });
      const c = clients.find((x) => x.conn === conn);
      if (!c) return;
      if (msg.t === 'welcome') {
        c.seen = Math.max(c.seen, msg.seq);
        for (const e of msg.envs ?? []) {
          c.seen = Math.max(c.seen, e.seq);
          if (e.origin === c.origin) ack(c, e.version);
        }
        c.welcomed = true;
        flush(c);
      } else if (msg.t === 'env') {
        c.seen = Math.max(c.seen, msg.seq);
        if (msg.origin === c.origin) ack(c, msg.version);
      } else if (msg.origin === c.origin && c.unacked.has(msg.version)) {
        if (msg.reason === 'duplicate') {
          if (!run.echoFirst) ack(c, msg.version);
        } else {
          c.unacked.delete(msg.version);
          c.refused.add(msg.version);
          if (msg.reason === 'order') flag('H', `${key(msg)} refused 'order'`);
        }
      }
      if (msg.t !== 'drop' && budget > 0 && rnd() < 0.2) {
        budget--;
        stats.reentrant++;
        write(c);
      }
    };

    const make = (): AckRoom =>
      ackRoom({
        rule: run.rule,
        order,
        substrate,
        journal,
        deliver,
        hook,
        neuter: run.neuter,
      });
    const crash = (): void => {
      const prefix: Ref[] = [];
      for (const e of [...storage].sort((x, y) => x.seq - y.seq)) {
        if (e.state !== 'ok') break;
        prefix.push({ origin: e.origin, version: e.version, seq: e.seq });
      }
      substrate = prefix;
      storage = prefix.map((r) => ({ ...r, state: 'ok' }));
      room.kill();
      for (const c of clients) c.conn = undefined;
      life++;
      room = make();
    };
    room = make();
    const told = (who: string, v: number): Stored | undefined =>
      storage.find(
        (e) => e.origin === who && e.version === v && e.state === 'told' && e.d,
      );
    const act = (ev: Ev): void => {
      if (ev.k === 'crash') {
        stats.crashes++;
        return crash();
      }
      if (ev.k === 'discard') {
        if (!room.stalled()) return;
        stats.discards++;
        for (const c of clients) disconnect(c);
        return crash();
      }
      const c = byOrigin(ev.who);
      switch (ev.k) {
        case 'write':
          if (!c.conn) return;
          gatedOnce = ev.gated;
          reentryOnce = ev.inHook;
          return write(c);
        case 'resend': {
          if (!c.conn) return;
          const idle = room.pending() === 0;
          if (told(c.origin, ev.v)) stats.pendingResends++;
          const n = room.held.length;
          send(c, ev.v);
          const h = room.held[n];
          if (h && !h.out) stats.held++;
          if (idle && h && !h.out)
            flag('D3', `${key(h)} duplicate held with nothing pending`);
          return;
        }
        case 'settle':
        case 'fail': {
          const e = told(ev.who, ev.v);
          if (!e) return;
          if (ev.k === 'fail') {
            stats.fails++;
            e.state = 'failed';
            return e.d?.reject(new Error('storage closed'));
          }
          e.state = 'ok';
          return e.d?.resolve();
        }
        case 'leave':
          return disconnect(c);
        case 'join':
          if (!c.conn) connect(c);
          return;
        case 'reconnect':
          return connect(c);
        case 'probe': {
          const conn = c.conn;
          if (!conn || (ev.reason === 'order' && !room.canOrder(c.origin)))
            return;
          stats.probes++;
          const v = ev.reason === 'order' ? 0 : c.version + 1000;
          const at = conn.got.length;
          room.receive(
            conn,
            c.origin,
            v,
            ev.reason === 'order' ? undefined : ev.reason,
          );
          if (
            !conn.got
              .slice(at)
              .some(
                (m) =>
                  m.t === 'drop' && m.reason === ev.reason && m.version === v,
              )
          )
            flag('D5', `${c.origin} probe '${ev.reason}' not answered at once`);
          return;
        }
      }
    };
    const apply = (ev: Ev): void => {
      trace.push(ev);
      const idle =
        room.pending() === 0 &&
        !room.stalled() &&
        storage.every((e) => e.state === 'ok');
      const gatedBefore = stats.gatedHooks;
      owed = [];
      act(ev);
      if (
        idle &&
        stats.gatedHooks === gatedBefore &&
        ev.k !== 'crash' &&
        ev.k !== 'discard'
      ) {
        stats.voidSteps++;
        if (room.pending() > 0)
          flag(
            'D7',
            `${room.pending()} release(s) still queued after an idle void step`,
          );
        // delivery, not only an empty queue: an open connection read all it was owed, in order
        for (const conn of new Set(owed.map((o) => o.conn))) {
          if (!conn.open) continue;
          const mine = owed.filter((o) => o.conn === conn);
          const want = mine.map((o) => o.name);
          const got = conn.got
            .slice(Math.min(...mine.map((o) => o.at)))
            .map(nameOf)
            .filter((n) => want.includes(n));
          if (got.join() !== want.join()) {
            stats.voidShort++;
            flag(
              'D7',
              `${conn.owner} read [${got.join(', ')}] by the end of an idle void step, owed [${want.join(', ')}]`,
            );
          }
        }
        stats.voidOwed += owed.length;
      }
      const seen = new Set<string>();
      for (const e of storage) {
        if (seen.has(key(e))) flag('U', `${key(e)} told twice`);
        seen.add(key(e));
      }
    };
    return {
      rnd,
      random,
      violations,
      firstAt,
      trace,
      heard,
      stats,
      clients,
      flag,
      arm: (): void => {
        budget = random && run.reentry !== false ? 4 : 0;
      },
      connect,
      apply,
      crash,
      room: () => room,
      storage: () => storage,
      substrate: () => substrate,
    };
  };

  /** Script or random events, then settle, crash, reconnect and settle again; NL and LV last. */
  const ackRun = async (run: AckRun) => {
    const w = ackWorld(run);
    const { rnd } = w;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const next = (): Ev => {
      const room = w.room();
      const roll = rnd();
      const who = rnd() < 0.5 ? 'a' : 'b';
      const pend = w.storage().filter((e) => e.state === 'told' && e.d);
      const mine = w.storage().filter((e) => e.origin === who);
      if (roll < 0.26) return { k: 'write', who, gated: rnd() < 0.75 };
      if (roll < 0.44 && mine.length)
        return { k: 'resend', who, v: pick(mine).version };
      if (roll < 0.62 && pend.length) {
        const e = pick(pend);
        return { k: 'settle', who: e.origin, v: e.version };
      }
      if (roll < 0.66 && pend.length) {
        const e = pick(pend);
        return { k: 'fail', who: e.origin, v: e.version };
      }
      if (roll < 0.76) {
        const connected = !!w.clients.find((c) => c.origin === who)?.conn;
        return {
          k: connected ? pick(['leave', 'reconnect'] as const) : 'join',
          who,
        };
      }
      if (roll < 0.8) return { k: 'crash' };
      if (roll < 0.86)
        return room.stalled() ? { k: 'discard' } : { k: 'join', who };
      return {
        k: 'probe',
        who,
        reason: pick(['generation', 'schema', 'order'] as const),
      };
    };
    const quiesce = async (): Promise<void> => {
      for (let round = 0; round < 50; round++) {
        await settle(20);
        const open = w.storage().filter((e) => e.state === 'told' && e.d);
        if (w.room().stalled() || !open.length) return;
        for (const e of open) {
          e.state = 'ok';
          e.d?.resolve();
        }
      }
    };
    const step = async (ev: Ev): Promise<void> => {
      w.apply(ev);
      await settle(8);
    };

    for (const c of w.clients) w.connect(c);
    w.arm();
    for (const ev of run.script ?? []) await step(ev);
    const steps = w.random ? 10 + Math.floor(rnd() * 16) : 0;
    for (let s = 0; s < steps; s++) await step(next());
    await quiesce();
    const room = w.room();
    if (!room.stalled()) {
      for (const h of room.held) {
        if (!h.out && h.conn.open && room.members.has(h.conn))
          w.flag('D3', `held duplicate ${key(h)} never sent`);
      }
    }
    w.crash();
    for (const c of w.clients) {
      for (const v of c.acked) {
        if (
          !w.substrate().some((r) => r.origin === c.origin && r.version === v)
        )
          w.flag('NL', `${c.origin}#${v} acknowledged, then lost in the crash`);
      }
    }
    for (const c of w.clients) w.connect(c);
    await quiesce();
    for (const c of w.clients) {
      for (let v = 1; v <= c.version; v++) {
        if (c.refused.has(v)) w.flag('LV', `${c.origin}#${v} ended refused`);
        else if (!c.acked.has(v))
          w.flag('LV', `${c.origin}#${v} never acknowledged`);
      }
    }
    const tags = new Set(w.violations.map((v) => v.slice(0, v.indexOf(':'))));
    return { ...w, tags };
  };

  const sweep = async (run: Omit<AckRun, 'seed'>, seeds: number) => {
    const tags = new Set<string>();
    type Stats = ReturnType<typeof ackWorld>['stats'];
    const stats = {} as Record<keyof Stats, number>;
    let first: string | null = null;
    let shortest:
      | { readonly at: number; readonly trace: readonly Ev[] }
      | undefined;
    for (let seed = 0; seed < seeds; seed++) {
      const r = await ackRun({ ...run, seed });
      for (const t of r.tags) tags.add(t);
      for (const k of Object.keys(r.stats) as (keyof Stats)[])
        stats[k] = (stats[k] ?? 0) + r.stats[k];
      if (r.violations.length) first ??= `seed ${seed}: ${r.violations[0]}`;
      const at = r.firstAt.get('D1');
      if (at !== undefined && (!shortest || at < shortest.at))
        shortest = { at, trace: r.trace.slice(0, at) };
    }
    return { tags, stats, first, shortest };
  };

  const slotAdapter =
    (shape: 'submit' | 'reserved' | 'mark'): MakeGate =>
    (emit) => {
      const g = slotGate(() => undefined);
      return {
        submit: (msgs, done) => {
          const run = () => msgs.forEach(emit);
          if (shape === 'submit') return g.submit(run, done);
          (shape === 'reserved' ? g.reserve() : g.hold())(run, done);
        },
        pending: g.pending,
      };
    };

  it('the slot gate keeps the release order and safety, whichever way an item enters (200 seeds each)', async () => {
    for (const shape of ['submit', 'reserved', 'mark'] as const) {
      for (let seed = 0; seed < 200; seed++) {
        const { n, emitted } = await run(seed, slotAdapter(shape));
        expect(
          emitted.map((e) => e.id),
          `${shape} seed ${seed}`,
        ).toEqual(Array.from({ length: n }, (_, i) => i));
        expect(early(emitted), `${shape} seed ${seed}`).toBeUndefined();
      }
    }
  });

  it('what a hook submits lands behind its reserved row, in the same tick when nothing is owed', () => {
    for (const shape of ['reserved', 'mark'] as const) {
      const out: string[] = [];
      const g = slotGate(() => undefined);
      const place = shape === 'reserved' ? g.reserve() : g.hold();
      g.submit(() => out.push('from the hook'));
      const inner = shape === 'reserved' ? g.reserve() : g.hold();
      g.submit(() => out.push('from the inner hook'));
      inner(() => out.push('inner row'));
      expect(out, shape).toEqual([]);
      place(() => out.push('row'));
      expect(out, shape).toEqual([
        'row',
        'from the hook',
        'inner row',
        'from the inner hook',
      ]);
      expect(g.pending()).toBe(0);
    }
    const afterHook: string[] = [];
    const g = slotGate(() => undefined);
    g.submit(() => afterHook.push('from the hook'));
    g.submit(() => afterHook.push('row'));
    expect(afterHook).toEqual(['from the hook', 'row']);
  });

  it('a queued duplicate answer with a reserved row slot holds D1 to D7, NL, LV, U and H (400 seeds, both shapes)', async () => {
    for (const order of ['reserved', 'mark'] as const) {
      const { first, stats } = await sweep({ rule: 'queued', order }, 400);
      expect(first, order).toBeNull();
      // the schedules reach every case the properties are about
      expect(stats.pendingResends).toBeGreaterThan(50);
      expect(stats.held).toBeGreaterThan(50);
      expect(stats.fails).toBeGreaterThan(10);
      expect(stats.crashes).toBeGreaterThan(10);
      expect(stats.discards).toBeGreaterThan(0);
      expect(stats.probes).toBeGreaterThan(50);
      expect(stats.reentrant).toBeGreaterThan(50);
      expect(stats.hookReentry).toBeGreaterThan(100);
      expect(stats.voidSteps).toBeGreaterThan(100);
      expect(stats.voidOwed).toBeGreaterThan(500);
      expect(stats.voidShort).toBe(0);
    }
  });

  it('a duplicate answered at once breaks D1, D4 and NL; without re-entry the shortest trace is two events', async () => {
    const { tags } = await sweep({ rule: 'immediate', order: 'reserved' }, 400);
    expect([...tags]).toEqual(
      expect.arrayContaining(['D1', 'D1p', 'D4', 'NL']),
    );
    const quiet = await sweep(
      { rule: 'immediate', order: 'reserved', reentry: false },
      400,
    );
    expect(quiet.shortest?.at).toBe(2);
    // a write, then its resend: an explicit one, or the flush of a reconnect
    expect(quiet.shortest?.trace[0].k).toBe('write');
  });

  it('a queued duplicate answer with the row submitted after its hook breaks D1 and D6 through the hook', async () => {
    const { tags } = await sweep({ rule: 'queued', order: 'after-hook' }, 400);
    expect([...tags]).toEqual(
      expect.arrayContaining(['D1', 'D1p', 'D2', 'D6']),
    );
  });

  it('counterexample: a gated write, resent before its row settles, is acknowledged by the duplicate', async () => {
    const script: Ev[] = [
      { k: 'write', who: 'a' },
      { k: 'resend', who: 'a', v: 1 },
    ];
    const atOnce = await ackRun({
      rule: 'immediate',
      order: 'reserved',
      script,
    });
    expect(atOnce.violations).toContain(
      'D1: a told drop a#1 before it was durable',
    );
    expect(atOnce.firstAt.get('D1')).toBe(2);
    expect(
      (await ackRun({ rule: 'queued', order: 'reserved', script })).violations,
    ).toEqual([]);
  });

  it('counterexample: the write fails after its duplicate acknowledged it, and the discard loses it', async () => {
    const script: Ev[] = [
      { k: 'write', who: 'a' },
      { k: 'resend', who: 'a', v: 1 },
      { k: 'fail', who: 'a', v: 1 },
      { k: 'resend', who: 'a', v: 1 },
      { k: 'discard' },
    ];
    const atOnce = await ackRun({
      rule: 'immediate',
      order: 'reserved',
      script,
    });
    expect(atOnce.tags).toEqual(new Set(['D1', 'D1p', 'D4', 'NL']));
    expect(atOnce.violations).toContain(
      'NL: a#1 acknowledged, then lost in the crash',
    );
    expect(
      (await ackRun({ rule: 'queued', order: 'reserved', script })).violations,
    ).toEqual([]);
  });

  it('counterexamples through the hook: resend, reconnect, another origin writing, gated and void', async () => {
    const seen: Ev = { k: 'write', who: 'b', gated: false };
    const away: Ev = { k: 'leave', who: 'b' };
    const cases: {
      readonly pre?: readonly Ev[];
      readonly ev: Ev;
      readonly journal?: boolean;
      readonly want: string;
    }[] = [
      {
        ev: { k: 'write', who: 'a', inHook: 'resend' },
        want: 'D1: a told drop a#1 before it was durable',
      },
      {
        ev: { k: 'write', who: 'a', inHook: 'resend', gated: false },
        want: 'D6: a got drop a#1 while the hook of a#1 ran',
      },
      {
        pre: [seen],
        ev: { k: 'write', who: 'a', inHook: 'reconnect' },
        journal: true,
        want: 'D1: a told welcome/delta a#1 before it was durable',
      },
      {
        pre: [seen],
        ev: { k: 'write', who: 'a', inHook: 'reconnect', gated: false },
        journal: true,
        want: 'D6: a got welcome@2 while the hook of a#1 ran',
      },
      {
        pre: [away],
        ev: { k: 'write', who: 'a', inHook: 'join-other' },
        want: 'D1: b welcomed at seq 1 before it was durable',
      },
      {
        ev: { k: 'write', who: 'a', inHook: 'write-other' },
        want: 'D2: a read seq 1 after 2',
      },
      {
        ev: { k: 'write', who: 'a', inHook: 'write-other', gated: false },
        want: 'D2: b read seq 1 after 2',
      },
    ];
    for (const { pre, ev, journal, want } of cases) {
      const script = [...(pre ?? []), ev];
      const afterHook = await ackRun({
        rule: 'queued',
        order: 'after-hook',
        journal,
        script,
      });
      expect(afterHook.violations, JSON.stringify(ev)).toContain(want);
      for (const order of ['reserved', 'mark'] as const) {
        const fixed = await ackRun({ rule: 'queued', order, journal, script });
        expect(fixed.violations, `${order} ${JSON.stringify(ev)}`).toEqual([]);
      }
    }
  });

  it('accepted: a durable version held behind a later, unrelated row that fails is never answered in that room', async () => {
    const script: Ev[] = [
      { k: 'write', who: 'a' },
      { k: 'leave', who: 'a' },
      { k: 'settle', who: 'a', v: 1 },
      { k: 'write', who: 'b' },
      { k: 'join', who: 'a' },
      { k: 'fail', who: 'b', v: 1 },
    ];
    const r = await ackRun({ rule: 'queued', order: 'reserved', script });
    expect(r.violations).toEqual([]);
    const firstLife = r.heard
      .filter((h) => h.life === 0 && h.owner === 'a')
      .map((h) => h.msg);
    expect(
      firstLife.some(
        (m) => m.t === 'drop' || (m.t === 'env' && m.origin === 'a'),
      ),
    ).toBe(false);
    // the resend after the join was held behind b#1 and never sent; the restarted room answers it
    expect(r.clients[0].acked.has(1)).toBe(true);
  });

  it('killed: admission recorded only once durable sequences a resend twice, or refuses it as out of order', async () => {
    const twice = await ackRun({
      rule: 'admit-after-durable',
      order: 'reserved',
      script: [
        { k: 'write', who: 'a' },
        { k: 'resend', who: 'a', v: 1 },
      ],
    });
    expect(twice.violations).toContain('U: a#1 told twice');
    const order = await ackRun({
      rule: 'admit-after-durable',
      order: 'reserved',
      script: [
        { k: 'write', who: 'a' },
        { k: 'write', who: 'a' },
        { k: 'settle', who: 'a', v: 2 },
        { k: 'resend', who: 'a', v: 1 },
      ],
    });
    expect(order.violations).toContain("H: a#1 refused 'order'");
  });

  it('killed: a client that waits for the echo never acknowledges a write whose echo went to a closed connection, when the recovery welcome is a same-generation snapshot', async () => {
    // a saw b#1 (seq 1), so its hello carries seq 1; its own a#1 is seq 2
    const script: Ev[] = [
      { k: 'write', who: 'b', gated: false },
      { k: 'write', who: 'a' },
      { k: 'leave', who: 'a' },
      { k: 'settle', who: 'a', v: 1 },
      { k: 'join', who: 'a' },
    ];
    const snapshot = await ackRun({
      rule: 'queued',
      order: 'reserved',
      echoFirst: true,
      journal: false,
      script,
    });
    expect(snapshot.violations).toEqual(['LV: a#1 never acknowledged']);
    // a delta welcome carries a#1 and acknowledges it: the alternative fails only without one
    const delta = await ackRun({
      rule: 'queued',
      order: 'reserved',
      echoFirst: true,
      journal: true,
      script,
    });
    expect(delta.violations).toEqual([]);
    for (const journal of [false, true]) {
      const r = await ackRun({
        rule: 'queued',
        order: 'reserved',
        journal,
        script,
      });
      expect(r.violations).toEqual([]);
    }
  });

  it('killed: a duplicate held behind its own row only overtakes the echo and acknowledges past a failed head', async () => {
    const overtakes = await ackRun({
      rule: 'per-row',
      order: 'reserved',
      script: [
        { k: 'write', who: 'b' },
        { k: 'write', who: 'a' },
        { k: 'resend', who: 'a', v: 1 },
        { k: 'settle', who: 'a', v: 1 },
        { k: 'settle', who: 'b', v: 1 },
      ],
    });
    expect(overtakes.tags).toEqual(new Set(['D1p', 'D2']));
    expect(overtakes.violations).toContain(
      'D2: a heard the duplicate before the echo of a#1',
    );
    const lost: Ev[] = [
      { k: 'write', who: 'b' },
      { k: 'write', who: 'a' },
      { k: 'resend', who: 'a', v: 1 },
      { k: 'settle', who: 'a', v: 1 },
      { k: 'fail', who: 'b', v: 1 },
      { k: 'discard' },
    ];
    const past = await ackRun({
      rule: 'per-row',
      order: 'reserved',
      script: lost,
    });
    expect(past.violations).toContain(
      'NL: a#1 acknowledged, then lost in the crash',
    );
    expect(
      (await ackRun({ rule: 'queued', order: 'reserved', script: lost }))
        .violations,
    ).toEqual([]);
  });

  it('the properties are not vacuous: queued refusals break D5, echoes on their own promise break D2, async releases break D7', async () => {
    const refusals = await sweep(
      { rule: 'queued', order: 'reserved', neuter: 'queue-refusals' },
      200,
    );
    expect(refusals.tags.has('D5')).toBe(true);
    const echoes = await sweep(
      { rule: 'queued', order: 'reserved', neuter: 'echo-on-own-promise' },
      200,
    );
    expect(echoes.tags.has('D2')).toBe(true);
    const async = await sweep(
      { rule: 'queued', order: 'reserved', neuter: 'async-release' },
      200,
    );
    expect(async.tags.has('D7')).toBe(true);
    // a lost release leaves the queue empty: only the delivery check sees it
    const lost = await sweep(
      { rule: 'queued', order: 'reserved', neuter: 'lose-release' },
      200,
    );
    expect(lost.tags.has('D7')).toBe(true);
    expect(lost.stats.voidShort).toBeGreaterThan(0);
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
        for (const reg of m.registers ?? []) {
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
        for (const reg of msg.registers ?? []) {
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
        instance: relay.room('r')?.instance ?? '',
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

    return {
      peers,
      all,
      byDot,
      violations,
      states,
      crashPoint,
      own,
      instance: relay.room('r')?.instance ?? '',
    };
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
      const { all, byDot, states, crashPoint, own, instance } = await run(seed);

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
      } else {
        // nothing durable yet: the adapter still persisted the generation nonce at creation, so
        // the writers' resends are this generation's, not a refused older one
        expect(restored.hydrate('r', { seq: 0, instance })).toBe(true);
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
        for (const reg of welcome.registers ?? []) {
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
    if (welcome.mode !== 'snapshot' || !welcome.registers)
      throw new Error('unreachable');
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

describe('createRelay: refusals answered with a drop', () => {
  const dropsTo = (sock: { sent: ServerMsg[] }) =>
    sock.sent.filter(
      (m): m is Extract<ServerMsg, { t: 'drop' }> => m.t === 'drop',
    );

  it('a resend of an admitted version is answered "duplicate" — the acknowledgement — and never sequenced twice', () => {
    const reasons: string[] = [];
    const relay = createRelay({
      onDrop: (_room, _env, reason) => void reasons.push(reason),
    });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    a.env([set(['x'], 1)]); // version 1, seq 1
    const echoed = b.sock.sent.filter((m) => m.t === 'env').length;
    a.env([set(['x'], 1)], { version: 1, hlc: { p: 1, l: 0 } }); // the echo was lost; resent verbatim
    expect(relay.room('r')?.seq).toBe(1);
    expect(reasons).toEqual(['duplicate']);
    expect(dropsTo(a.sock)).toEqual([
      {
        t: 'drop',
        room: 'r',
        origin: 'oa',
        version: 1,
        reason: 'duplicate',
        seq: 1,
      },
    ]);
    expect(dropsTo(b.sock)).toEqual([]); // the submitter alone hears it
    expect(b.sock.sent.filter((m) => m.t === 'env').length).toBe(echoed);
  });

  it('a resend of an admitted write is still "duplicate" once the room has moved on — the policy judges after the refusals, never an honest retry', () => {
    // an agent may take a record from nobody or from another client, never from a person
    const relay = createRelay({
      policy: {
        validate: (
          op: StoreOp,
          ctx: PrincipalCtx,
          _room: string,
          info?: PolicyRoomInfo,
        ) =>
          ctx.kind !== 'agent' ||
          op.kind !== 'set' ||
          op.path.join('/') !== 'wp/assignee' ||
          (info?.siblings?.(op.path) ?? []).every(
            (s) =>
              s.kind !== 'set' ||
              (s.value as { kind?: string } | null)?.kind !== 'human',
          ),
      },
    });
    const human = client(relay, 'wh', 'oh', { kind: 'human' });
    human.hello();
    human.env([set([], { wp: { assignee: null } })]);
    const agent = client(relay, 'wa', 'oa', { kind: 'agent' });
    agent.hello();
    agent.env([set(['wp', 'assignee'], { kind: 'client', writer: 'wa' })]); // nobody held it: admitted
    expect(agent.sock.closed).toBe(false);
    human.env([set(['wp', 'assignee'], { kind: 'human', writer: 'wh' })]); // a person takes it
    // the agent lost its acknowledgement and resends verbatim; the register now holds a person,
    // so a rule that ran before the duplicate check would eject this honest retry
    agent.env([set(['wp', 'assignee'], { kind: 'client', writer: 'wa' })], {
      version: 1,
      hlc: { p: 1, l: 0 },
    });
    expect(dropsTo(agent.sock).map((d) => d.reason)).toEqual(['duplicate']);
    expect(agent.sock.closed).toBe(false);
    expect(relay.room('r')?.seq).toBe(3);
  });

  it('an envelope from another generation is refused "generation" before any other evidence answers', () => {
    const reasons: string[] = [];
    const relay = createRelay({
      onDrop: (_room, _env, reason) => void reasons.push(reason),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['x'], 1)]);
    a.env([set(['x'], 2)], { instance: 'an-older-generation', version: 1 }); // would be a duplicate by version
    expect(relay.room('r')?.seq).toBe(1);
    expect(reasons).toEqual(['generation']);
    expect(dropsTo(a.sock).map((d) => d.reason)).toEqual(['generation']);
    expect(a.sock.closed).toBe(false);
  });

  it('a migration cuts the generation: members are re-welcomed under the new nonce and old-generation writes are refused', () => {
    const relay = createRelay();
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    const before = a.instance();
    a.env([set([], { v: 1 })]);
    a.env([set([], { v: 2 })], { schemaVersion: 1 }); // the cut
    const welcomes = b.sock.sent.filter((m) => m.t === 'welcome');
    expect(welcomes).toHaveLength(2);
    expect(b.instance()).not.toBe(before);
    expect(relay.room('r')?.instance).toBe(b.instance());
    // a write b stamped before it learned the cut
    b.env([set(['late'], 1)], { instance: before });
    expect(dropsTo(b.sock).map((d) => d.reason)).toEqual(['generation']);
    // and one after
    b.env([set(['fresh'], 1)]);
    expect(relay.room('r')?.seq).toBe(3);
  });

  it('a version below the origin\'s admitted maximum that was never admitted is refused "order"', () => {
    const reasons: string[] = [];
    const relay = createRelay({
      onDrop: (_room, _env, reason) => void reasons.push(reason),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    a.env([set(['x'], 1)], { version: 2 }); // a hole at 1 (a refused write, or a second tab)
    a.env([set(['x'], 2)], { version: 1 });
    expect(relay.room('r')?.seq).toBe(1);
    expect(reasons).toEqual(['order']);
    expect(a.sock.closed).toBe(false);
  });

  it('restored ranges and settled vector answer exactly like the live room did', () => {
    let saved: RoomSnapshot = { seq: 0 };
    const source = createRelay({
      journalLimit: 2,
      onCommit: (_room, env, state) => {
        saved = {
          seq: state.seq,
          instance: state.instance,
          registers: state.checkpoint(),
          ranges: state.ranges,
          settled: state.settled,
          schemaVersion: state.schemaVersion,
          journal: [env],
        };
      },
    });
    const a = client(source, 'wa', 'oa');
    a.hello();
    a.env([set([], {})]);
    a.env([set(['x'], 1)]);
    a.env([set(['x'], 2)]); // trims: collection ran on settled { oa: 3.0 }
    expect(saved.ranges).toEqual({ oa: [[1, 3]] });
    expect(saved.settled).toEqual({ oa: { p: 3, l: 0 } });

    const revived = createRelay({ journalLimit: 2 });
    expect(revived.hydrate('r', saved)).toBe(true);
    const back = client(revived, 'wa', 'oa');
    back.hello();
    const reasons: string[] = [];
    back.env([set(['x'], 1)], { version: 2, hlc: { p: 2, l: 0 } }); // a resend of what the old room held
    expect(revived.room('r')?.seq).toBe(3);
    expect(
      back.sock.sent
        .filter((m) => m.t === 'drop')
        .map((m) => (m as { reason: string }).reason),
    ).toEqual(['duplicate']);
    back.env([set(['x'], 3)], { version: 4 });
    expect(revived.room('r')?.seq).toBe(4);
    void reasons;
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

  it('siblings hand a rule what the relay holds at a path, so an op cannot talk its way past with its own prev', () => {
    // an agent may take a record from nobody or from another client, never from a person; the
    // rule reads the relay's register, not the op's claim of what it saw
    const holderPolicy = {
      validate: (
        op: StoreOp,
        ctx: PrincipalCtx,
        _room: string,
        info?: PolicyRoomInfo,
      ) => {
        if (ctx.kind !== 'agent' || op.kind !== 'set') return true;
        if (op.path.join('/') !== 'wp/assignee') return true;
        return (info?.siblings?.(op.path) ?? []).every(
          (s) =>
            s.kind !== 'set' ||
            (s.value as { kind?: string } | null)?.kind !== 'human',
        );
      },
    };
    const held = (by: unknown) => {
      const relay = createRelay({ policy: holderPolicy });
      const human = client(relay, 'wh', 'oh', { kind: 'human' });
      human.hello();
      human.env([set([], { wp: { assignee: null } })]);
      human.env([set(['wp', 'assignee'], by)]);
      expect(human.sock.closed).toBe(false);
      const agent = client(relay, 'wa', 'oa', { kind: 'agent' });
      agent.hello();
      // the op's own prev claims nobody holds it, whatever the register says
      agent.env([
        {
          kind: 'set',
          path: ['wp', 'assignee'],
          next: { kind: 'client', writer: 'wa' },
          prev: null,
          cites: [],
          epoch: 0,
        },
      ]);
      return agent;
    };

    const fromPerson = held({ kind: 'human', writer: 'wh' });
    expect(last(fromPerson.sock)).toMatchObject({
      t: 'eject',
      reason: 'validate',
    });
    expect(fromPerson.sock.closed).toBe(true);

    const fromClient = held({ kind: 'client', writer: 'wx' });
    expect(fromClient.sock.closed).toBe(false);
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
    relay: ReturnType<typeof createRelay>,
    origin: string,
    version: number,
    path: string,
  ): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: relay.room('r')?.instance ?? '',
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
        { send: (m: ServerMsg) => got.push(m), close: () => undefined },
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
    a.conn.receive({ t: 'env', room: 'r', env: envelope(relay, 'a', 1, 'x') });
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
    let c: { got: ServerMsg[] } | undefined;
    const join = (origin: string) => {
      const got: ServerMsg[] = [];
      const conn = relay.connect(
        { send: (m: ServerMsg) => got.push(m), close: () => undefined },
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
    const relay: Relay = createRelay({
      onCommit: () => {
        // an adapter that opens a seat on the room the moment it hears of a commit
        c ??= join('c');
      },
    });
    const a = join('a');
    a.conn.receive({ t: 'env', room: 'r', env: envelope(relay, 'a', 1, 'x') });

    expect(countOf(a.got, 1)).toBe(1);
    if (c === undefined) throw new Error('the late member never joined');
    expect(countOf(c.got, 1)).toBe(1);
    expect(c.got.filter((m) => m.t === 'env')).toHaveLength(0);
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
  const write = (
    relay: ReturnType<typeof createRelay>,
    conn: RelayConnection,
    origin: string,
    version: number,
  ) =>
    conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: relay.room('r')?.instance ?? '',
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
    write(relay, a.conn, 'a', 1);
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
    write(relay, a.conn, 'a', 1);
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
    write(relay, a.conn, 'a', 1);
    write(relay, a.conn, 'a', 2);
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
    write(relay, a.conn, 'a', 1);
    write(relay, a.conn, 'a', 2);

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
    write(relay, a.conn, 'a', 1);
    a.conn.disconnect();
    expect(relay.hydrate('r', { seq: 9 })).toBe(false);
    expect(relay.unload('r')).toBe(true);
    expect(relay.hydrate('r', { seq: 9 })).toBe(true);
    expect(relay.room('r')?.seq).toBe(9);
  });
});

const welcomeOfSocket = (sock: ReturnType<typeof socket>) =>
  sock.sent.find((m) => m.t === 'welcome');

describe('createRelay: ICE servers in welcomes', () => {
  it('issues what the function form returns for (room, origin) at each welcome; no option means no ice key', () => {
    const calls: [string, string][] = [];
    const issued: unknown[] = [];
    const relay = createRelay({
      iceServers: (room, origin) => {
        calls.push([room, origin]);
        const servers = [
          {
            urls: `turn:${origin}.example`,
            username: origin,
            credential: `c${calls.length}`,
          },
        ];
        issued.push(servers);
        return servers;
      },
    });
    const a = client(relay, 'wa', 'oa');
    const b = client(relay, 'wb', 'ob');
    a.hello();
    b.hello();
    expect(calls).toEqual([
      ['r', 'oa'],
      ['r', 'ob'],
    ]);
    const iceOf = (sock: ReturnType<typeof socket>) =>
      sock.sent.flatMap((m) => (m.t === 'welcome' ? [m.ice] : []));
    expect(iceOf(a.sock)[0]).toBe(issued[0]);
    expect(iceOf(b.sock)[0]).toBe(issued[1]);

    // the migration re-welcome is the second emission site: each member gets a fresh call
    a.env([set([], { v: 1 })], { schemaVersion: 1 });
    expect(calls.slice(2).sort()).toEqual([
      ['r', 'oa'],
      ['r', 'ob'],
    ]);
    expect(iceOf(a.sock)).toHaveLength(2);
    expect(issued).toContain(iceOf(a.sock)[1]);
    expect(issued).toContain(iceOf(b.sock)[1]);
    expect(iceOf(a.sock)[1]).not.toBe(iceOf(a.sock)[0]);

    const plain = createRelay();
    const c = client(plain, 'wc', 'oc');
    c.hello();
    const welcome = c.sock.sent.find((m) => m.t === 'welcome');
    expect(welcome).toBeDefined();
    expect('ice' in (welcome as object)).toBe(false);
  });

  it('reads the option when a held welcome is released, not when the hello arrives', async () => {
    const gate = deferred();
    let calls = 0;
    const relay = createRelay({
      onCommit: () => gate.promise,
      iceServers: () => (calls++, [{ urls: 'stun:example' }]),
    });
    const a = client(relay, 'wa', 'oa');
    a.hello();
    expect(calls).toBe(1);
    a.env([set(['x'], 1)]);
    const b = client(relay, 'wb', 'ob');
    b.hello();
    expect(b.sock.sent.some((m) => m.t === 'welcome')).toBe(false);
    expect(calls).toBe(1);
    gate.resolve();
    await settle();
    expect(calls).toBe(2);
    expect(welcomeOfSocket(b.sock)).toMatchObject({
      ice: [{ urls: 'stun:example' }],
    });
  });
});
