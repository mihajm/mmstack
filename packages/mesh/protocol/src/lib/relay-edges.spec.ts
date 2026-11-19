import { describe, expect, it } from 'vitest';
import type { PolicyViolation, PrincipalCtx } from './policy';
import {
  createRelay,
  type Relay,
  type RelayOptions,
  type RelayRow,
  type RoomState,
} from './relay';
import {
  MESH_PROTO_VERSION,
  type OpEnvelope,
  type RegisterCheckpoint,
  type ServerMsg,
  type SnapshotState,
  type SyncOp,
  type SyncSibling,
  type WelcomeMsg,
} from './wire';

type Peer = ReturnType<typeof peer>;

function peer(
  relay: Relay,
  origin: string,
  opts: { writer?: string; closable?: boolean; room?: string } = {},
) {
  const room = opts.room ?? 'r';
  const sent: ServerMsg[] = [];
  const state = { closed: false };
  const socket =
    opts.closable === false
      ? { send: (m: ServerMsg) => void sent.push(m) }
      : {
          send: (m: ServerMsg) => void sent.push(m),
          close: () => void (state.closed = true),
        };
  const ctx: PrincipalCtx = { writer: opts.writer ?? `w${origin}` };
  const conn = relay.connect(socket, ctx);
  let version = 0;
  let p = 0;
  const instance = (): string => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const m = sent[i];
      if (m.t === 'welcome') return m.instance;
    }
    return relay.room(room)?.instance ?? '';
  };
  const make = (ops: SyncOp[], over: Partial<OpEnvelope> = {}): OpEnvelope => ({
    proto: MESH_PROTO_VERSION,
    instance: instance(),
    origin,
    writer: ctx.writer,
    version: ++version,
    hlc: { p: ++p, l: 0 },
    policyVersion: 0,
    ops,
    ...over,
  });
  return {
    origin,
    sent,
    state,
    conn,
    hello: (
      over: {
        seq?: number;
        schemaVersion?: number;
        policyVersion?: number;
        proto?: number;
      } = {},
    ) =>
      conn.receive({
        t: 'hello',
        room,
        origin,
        proto: MESH_PROTO_VERSION,
        policyVersion: 0,
        ...over,
      }),
    env: (ops: SyncOp[], over: Partial<OpEnvelope> = {}): OpEnvelope => {
      const e = make(ops, over);
      conn.receive({ t: 'env', room, env: e });
      return e;
    },
    raw: (env: unknown) =>
      conn.receive({ t: 'env', room, env: env as OpEnvelope }),
    presence: (data: unknown) => conn.receive({ t: 'presence', room, data }),
    compact: (ready: boolean) =>
      conn.receive({ t: 'compact', room, instance: instance(), ready }),
    of: <T extends ServerMsg['t']>(t: T) =>
      sent.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t),
    echoed: (v: number) =>
      sent.some(
        (m) => m.t === 'env' && m.env.origin === origin && m.env.version === v,
      ),
  };
}

const set = (
  path: (string | number)[],
  next: unknown,
  cites: SyncOp['cites'] = [],
): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites,
  epoch: 0,
});
const del = (
  path: (string | number)[],
  cites: SyncOp['cites'] = [],
): SyncOp => ({
  kind: 'delete',
  path,
  prev: undefined,
  cites,
  epoch: 0,
});
const sib = (
  kind: SyncSibling['kind'],
  origin: string,
  p: number,
  value?: unknown,
): SyncSibling => ({
  kind,
  writer: origin,
  origin,
  hlc: { p, l: 0 },
  epoch: 0,
  ...(kind === 'set' ? { value } : {}),
});
const rootSeed = (origin = 'z', p = 9): RegisterCheckpoint[] => [
  { path: [], siblings: [sib('set', origin, p, { k: 1 })], water: {} },
];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('relay bugs: hostile or stray input', () => {
  it('a null envelope from a member ejects it as malformed instead of throwing', () => {
    const violations: PolicyViolation[] = [];
    const relay = createRelay({ onViolation: (_r, v) => violations.push(v) });
    const a = peer(relay, 'a');
    a.hello();
    expect(() => a.raw(null)).not.toThrow();
    expect(violations).toEqual([
      { writer: 'wa', reason: 'malformed', detail: 'envelope' },
    ]);
    expect(a.of('eject')).toMatchObject([{ reason: 'malformed' }]);
  });

  it('a message other than hello for a room the connection never joined leaves no room behind', () => {
    const relay = createRelay();
    const a = peer(relay, 'a', { room: 'junk' });
    a.presence({ x: 1 });
    a.compact(true);
    a.env([set([], {})]);
    expect(relay.room('junk')).toBeUndefined();
  });

  it('a connection displaced by a same-origin hello can no longer write or set presence', () => {
    const relay = createRelay();
    const a1 = peer(relay, 'a', { writer: 'wa' });
    const a2 = peer(relay, 'a', { writer: 'wa' });
    const b = peer(relay, 'b');
    a1.hello();
    b.hello();
    a2.hello();
    expect(a1.state.closed).toBe(true);
    a2.presence('live');
    a1.presence('zombie');
    a1.env([set([], {})]);
    expect(relay.room('r')).toMatchObject({ seq: 0, members: 2 });
    expect(b.of('presence').map((m) => m.peer.data)).toEqual(['live']);
    const c = peer(relay, 'c');
    c.hello();
    expect(c.of('welcome')[0].peers.map((x) => x.data)).toEqual(['live']);
  });

  it('a stale-schema hello on a hydrated seq-0 room keeps the schema floor', () => {
    const relay = createRelay();
    expect(relay.hydrate('r', { seq: 0, schemaVersion: 2 })).toBe(true);
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello({ schemaVersion: 1 });
    b.hello({ schemaVersion: 1 });
    expect(a.of('reject')).toMatchObject([{ reason: 'schema', expected: 2 }]);
    expect(b.of('reject')).toMatchObject([{ reason: 'schema', expected: 2 }]);
    expect(b.of('welcome')).toEqual([]);
  });

  it('ejecting a writer under consensus cuts once, after all its connections are gone', () => {
    const rows: RelayRow[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true },
      onRow: (_r, row) => void rows.push(row),
    });
    const a = peer(relay, 'a');
    const x1 = peer(relay, 'x1', { writer: 'wx' });
    const x2 = peer(relay, 'x2', { writer: 'wx' });
    a.hello();
    x1.hello();
    x2.hello();
    a.env([set([], { k: 1 })]);
    a.compact(true);
    x1.compact(true);
    x1.env([set(['k'], 2)], { writer: 'someone-else' });
    expect(rows).toHaveLength(1);
    const ejectAt = x2.sent.findIndex((m) => m.t === 'eject');
    expect(ejectAt).toBeGreaterThanOrEqual(0);
    expect(x2.sent.slice(ejectAt).some((m) => m.t === 'welcome')).toBe(false);
    expect(a.of('welcome').at(-1)).toMatchObject({ members: [] });
  });
});

describe('relay: membership, presence and re-hello', () => {
  it('a seq-0 room with members left in it stays; the survivor seeds it and gets its echo', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.conn.disconnect();
    expect(relay.room('r')?.members).toBe(1);
    b.env([set([], {})]);
    expect(b.echoed(1)).toBe(true);
  });

  it('a seq-0 room that holds an ejection is never evicted: the writer stays refused', () => {
    const relay = createRelay();
    const w = peer(relay, 'w');
    w.hello();
    w.env([set([], {})], { writer: 'forged' });
    expect(w.of('eject')).toMatchObject([{ reason: 'writer-mismatch' }]);
    peer(relay, 'x').hello({ proto: MESH_PROTO_VERSION + 1 });
    const again = peer(relay, 'w2', { writer: 'ww' });
    again.hello();
    expect(again.of('reject')).toMatchObject([{ reason: 'unauthorized' }]);
  });

  it('an ejected member leaves the roster: others hear it gone, a joiner never sees it', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.presence('here');
    a.env([set([], {})], { writer: 'forged' });
    expect(b.of('presence').at(-1)).toMatchObject({
      gone: true,
      peer: { origin: 'a' },
    });
    const c = peer(relay, 'c');
    c.hello();
    expect(c.of('welcome')[0].peers).toEqual([]);
  });

  it('a socket without close can be ejected and displaced without a throw', () => {
    const relay = createRelay();
    const a = peer(relay, 'a', { closable: false });
    a.hello();
    expect(() => a.env([set([], {})], { writer: 'forged' })).not.toThrow();
    expect(a.of('eject')).toHaveLength(1);
    const b1 = peer(relay, 'b', { closable: false, writer: 'wb' });
    const b2 = peer(relay, 'b', { writer: 'wb' });
    b1.hello();
    expect(() => b2.hello()).not.toThrow();
    expect(b2.of('welcome')).toHaveLength(1);
  });

  it('a disconnect removes the presence entry, not only announces it', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    a.hello();
    a.presence('here');
    a.conn.disconnect();
    const c = peer(relay, 'c');
    c.hello();
    expect(c.of('welcome')[0].peers).toEqual([]);
  });

  it('the displaced connection closing later announces nothing for an origin that is live again', () => {
    const relay = createRelay();
    const a1 = peer(relay, 'a', { writer: 'wa' });
    const a2 = peer(relay, 'a', { writer: 'wa' });
    const b = peer(relay, 'b');
    b.hello();
    a1.hello();
    a2.hello();
    const before = b.sent.length;
    a1.conn.disconnect();
    expect(b.sent.slice(before)).toEqual([]);
    expect(relay.room('r')?.members).toBe(2);
  });

  it('after disconnect the connection writes nothing', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.conn.disconnect();
    a.env([set([], {})]);
    a.presence('late');
    expect(relay.room('r')?.seq).toBe(0);
    expect(b.of('presence')).toEqual([]);
  });

  it('a first-contact hello rejected on proto leaves no room behind', () => {
    const relay = createRelay();
    peer(relay, 'a', { room: 'ghost' }).hello({
      proto: MESH_PROTO_VERSION + 1,
    });
    expect(relay.room('ghost')).toBeUndefined();
  });

  it('a re-hello on the same socket keeps one member and the socket open', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    a.hello();
    a.hello();
    expect(a.state.closed).toBe(false);
    expect(a.of('welcome')).toHaveLength(2);
    expect(relay.room('r')?.members).toBe(1);
    a.env([set([], {})]);
    expect(a.of('env')).toHaveLength(1);
  });

  it("a re-hello on a new socket drops the old incarnation's presence", () => {
    const relay = createRelay();
    const a1 = peer(relay, 'a', { writer: 'wa' });
    const b = peer(relay, 'b');
    a1.hello();
    b.hello();
    a1.presence('old');
    peer(relay, 'a', { writer: 'wa' }).hello();
    expect(b.of('presence').at(-1)).toMatchObject({
      gone: true,
      peer: { origin: 'a' },
    });
    const c = peer(relay, 'c');
    c.hello();
    expect(c.of('welcome')[0].peers).toEqual([]);
  });

  it('a hydrated room nobody joined can be unloaded', () => {
    const relay = createRelay();
    relay.hydrate('r', { seq: 3 });
    expect(relay.unload('r')).toBe(true);
  });

  it('a compact message to a relay that arms no cuts is ignored', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    a.hello();
    const before = a.sent.length;
    expect(() => a.compact(true)).not.toThrow();
    expect(a.sent.length).toBe(before);
  });
});

describe('relay: the tripwire names its reason', () => {
  const tripped = (opt: RelayOptions, send: (a: Peer) => void) => {
    const violations: PolicyViolation[] = [];
    const relay = createRelay({
      ...opt,
      onViolation: (_r, v) => violations.push(v),
    });
    const a = peer(relay, 'a');
    a.hello({ policyVersion: opt.policyVersion ?? 0 });
    send(a);
    return { relay, a, violations };
  };

  it.each<[string, RelayOptions, (a: Peer) => void, Partial<PolicyViolation>]>([
    [
      'proto: another policy version',
      { policyVersion: 1 },
      (a) => a.env([set([], {})], { policyVersion: 0 }),
      { reason: 'proto' },
    ],
    [
      'proto: another protocol',
      {},
      (a) => a.env([set([], {})], { proto: MESH_PROTO_VERSION + 1 }),
      { reason: 'proto' },
    ],
    [
      'malformed',
      {},
      (a) => a.env([set([], {})], { version: 0 }),
      { reason: 'malformed', detail: 'version' },
    ],
    [
      'malformed root delete',
      {},
      (a) => a.env([del([])]),
      { reason: 'malformed', detail: 'root-op' },
    ],
    [
      'ops-limit',
      { limits: { maxOpsPerEnvelope: 1 } },
      (a) => a.env([set(['x'], 1), set(['y'], 1)]),
      { reason: 'ops-limit' },
    ],
    [
      'rate',
      { limits: { maxEnvelopesPerSecond: 1 }, now: () => 0 },
      (a) => {
        for (let i = 0; i < 3; i++) a.env([set(['k', i], 1)]);
      },
      { reason: 'rate' },
    ],
    [
      'writer-mismatch',
      {},
      (a) => a.env([set([], {})], { writer: 'forged' }),
      { reason: 'writer-mismatch' },
    ],
  ])('%s', (_, opt, send, want) => {
    const { relay, a, violations } = tripped(opt, send);
    expect(violations).toMatchObject([{ writer: 'wa', ...want }]);
    expect(a.of('eject')).toMatchObject([
      { writer: 'wa', reason: want.reason },
    ]);
    expect(a.of('drop')).toEqual([]);
    if (want.reason !== 'rate') expect(relay.room('r')?.seq).toBe(0);
  });

  it('a forged writer with a stale instance is ejected, never answered with a drop', () => {
    const { a } = tripped({}, (p) =>
      p.env([set([], {})], { writer: 'forged', instance: 'old' }),
    );
    expect(a.of('eject')).toMatchObject([{ reason: 'writer-mismatch' }]);
    expect(a.of('drop')).toEqual([]);
  });

  it('an envelope with exactly the op limit is admitted', () => {
    const relay = createRelay({ limits: { maxOpsPerEnvelope: 2 } });
    const a = peer(relay, 'a');
    a.hello();
    a.env([set(['x'], 1), set(['y'], 1)]);
    expect(a.echoed(1)).toBe(true);
    expect(a.of('eject')).toEqual([]);
  });
});

describe('relay: the per-writer token bucket', () => {
  const bucket = (start: number) => {
    let t = start;
    const relay = createRelay({
      limits: { maxEnvelopesPerSecond: 2 },
      now: () => t,
    });
    const a = peer(relay, 'a');
    a.hello();
    let k = 0;
    const write = () => a.env([set(['k', k++], 1)]);
    return { a, write, advance: (ms: number) => void (t += ms) };
  };

  it('bursts to twice the rate, and the next envelope ejects', () => {
    const { a, write } = bucket(0);
    for (let i = 0; i < 4; i++) write();
    expect(a.state.closed).toBe(false);
    expect([1, 2, 3, 4].every((v) => a.echoed(v))).toBe(true);
    write();
    expect(a.of('eject')).toMatchObject([{ reason: 'rate' }]);
  });

  it('refills at the rate: half a second buys exactly one more', () => {
    const { a, write, advance } = bucket(1000);
    for (let i = 0; i < 4; i++) write();
    advance(500);
    write();
    expect(a.echoed(5)).toBe(true);
    write();
    expect(a.of('eject')).toMatchObject([{ reason: 'rate' }]);
  });
});

const lastWelcome = (p: Peer) =>
  p.of('welcome').at(-1) as WelcomeMsg & Partial<SnapshotState>;

describe('relay.cut: answers, seeds and the record', () => {
  const setup = (opt: RelayOptions = {}) => {
    const rows: RelayRow[] = [];
    let state: RoomState | undefined;
    const relay = createRelay({
      onRow: (_r, row) => void rows.push(row),
      onCommit: (_r, _e, s) => void (state = s),
      ...opt,
    });
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], { k: 0 })]);
    return { relay, rows, a, b, state: () => state as RoomState };
  };

  it('false for a room this relay does not hold', () => {
    expect(
      createRelay().cut('nope', { reason: 'rollback', seed: rootSeed() }),
    ).toBe(false);
    expect(
      createRelay({ policy: { verifyCitations: true } }).cut('nope', {
        reason: 'compaction',
      }),
    ).toBe(false);
  });

  it('false for a stalled room, which keeps its instance', async () => {
    const { relay } = setup({
      policy: { verifyCitations: true },
      onCommit: () => Promise.reject(new Error('disk')),
      onDurabilityFailed: () => {},
    });
    await tick();
    expect(relay.room('r')?.stalled).toBe(true);
    const before = relay.room('r')?.instance;
    expect(relay.cut('r', { reason: 'compaction' })).toBe(false);
    expect(relay.cut('r', { reason: 'rollback', seed: rootSeed() })).toBe(
      false,
    );
    expect(relay.room('r')?.instance).toBe(before);
  });

  it('compaction and consensus throw without the citation gate; rollback does not need it', () => {
    const { relay } = setup();
    expect(() => relay.cut('r', { reason: 'compaction' })).toThrow(
      /verifyCitations/,
    );
    expect(() => relay.cut('r', { reason: 'consensus' })).toThrow(
      /verifyCitations/,
    );
    expect(relay.cut('r', { reason: 'rollback', seed: rootSeed() })).toBe(true);
  });

  it('consensus seeds from retained state and records its reason', () => {
    const { relay, rows } = setup({ policy: { verifyCitations: true } });
    expect(relay.cut('r', { reason: 'consensus' })).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'cut',
      record: { reason: 'consensus', policy: 'replay' },
    });
  });

  it('a supplied seed: rollback re-welcomes every member with it under discard', () => {
    const { relay, rows, a, b } = setup();
    const seed = rootSeed();
    expect(relay.cut('r', { reason: 'rollback', seed })).toBe(true);
    expect(rows).toMatchObject([
      { kind: 'cut', record: { reason: 'rollback', policy: 'discard', seed } },
    ]);
    for (const p of [a, b]) {
      expect(lastWelcome(p)).toMatchObject({
        mode: 'snapshot',
        reason: 'rollback',
        seed,
        instance: relay.room('r')?.instance,
      });
    }
    expect(lastWelcome(a).members).toEqual(['b']);
    expect(lastWelcome(b).members).toEqual(['a']);
  });

  it('false without a seed, or for a seed whose root holds no live set; nothing changes', () => {
    const { relay, rows } = setup();
    const before = relay.room('r')?.instance;
    expect(relay.cut('r', { reason: 'rollback' })).toBe(false);
    expect(
      relay.cut('r', {
        reason: 'rollback',
        seed: [{ path: ['x'], siblings: [sib('set', 'z', 9, 1)], water: {} }],
      }),
    ).toBe(false);
    expect(
      relay.cut('r', {
        reason: 'migration',
        seed: [{ path: [], siblings: [sib('delete', 'z', 9)], water: {} }],
      }),
    ).toBe(false);
    expect(rows).toEqual([]);
    expect(relay.room('r')?.instance).toBe(before);
  });

  it("a supplied seed's stamps join preCutMax and everMax", () => {
    const { relay, rows, a, state } = setup();
    relay.cut('r', { reason: 'rollback', seed: rootSeed('z', 9) });
    const record = (rows[0] as Extract<RelayRow, { kind: 'cut' }>).record;
    expect(record.preCutMax['z']).toEqual({ p: 9, l: 0 });
    expect(lastWelcome(a).preCutMax?.['z']).toEqual({
      p: 9,
      l: 0,
    });
    a.env([set(['k'], 1)]);
    expect(state().everMax['z']).toEqual({ p: 9, l: 0 });
  });

  it('a cut clears first stamps and journaled refusals, and starts an empty journal', () => {
    const { relay, b, state } = setup({ policy: { verifyCitations: true } });
    b.env([set(['k'], 1, [{ origin: 'ghost', hlc: { p: 9, l: 0 } }])]);
    expect(b.of('drop')).toMatchObject([{ reason: 'citation' }]);
    expect(relay.cut('r', { reason: 'compaction' })).toBe(true);
    expect(relay.room('r')?.journal).toBe(0);
    const cutSeq = relay.room('r')?.seq as number;
    b.env([set(['k'], 2)]);
    expect(Object.keys(state().generation.firstStamps)).toEqual(['b']);
    expect(state().refused).toEqual({});
    const late = peer(relay, 'a', { writer: 'wa' });
    late.hello({ seq: cutSeq });
    expect(late.of('welcome')[0]).toMatchObject({ mode: 'delta' });
  });

  it('a never-cut room answers a snapshot with the genesis record', () => {
    const { relay } = setup();
    const c = peer(relay, 'c');
    c.hello();
    expect(c.of('welcome')[0]).toMatchObject({
      mode: 'snapshot',
      reason: 'genesis',
      policy: 'discard',
      index: 0,
    });
  });

  it('the re-welcome carries the presence roster', () => {
    const { relay, a, b } = setup();
    a.presence('here');
    relay.cut('r', { reason: 'rollback', seed: rootSeed() });
    expect(lastWelcome(b).peers.map((p) => p.data)).toEqual(['here']);
  });

  it('the re-welcome waits for the cut row to be durable', async () => {
    let release = () => {};
    const { relay, a, b } = setup({
      onRow: () => new Promise<void>((r) => (release = r)),
    });
    const counts = () => [a.of('welcome').length, b.of('welcome').length];
    relay.cut('r', { reason: 'rollback', seed: rootSeed() });
    await tick();
    expect(counts()).toEqual([1, 1]);
    release();
    await tick();
    expect(counts()).toEqual([2, 2]);
  });
});

describe('relay: the tombstone budget', () => {
  const budgeted = (budget: {
    floor: number;
    factor: number;
    quietMs?: number;
  }) => {
    let t = 0;
    const rows: RelayRow[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { budget },
      now: () => t,
      onRow: (_r, row) => void rows.push(row),
    });
    const a = peer(relay, 'a');
    a.hello();
    a.env([set([], { k: 0 })]);
    return { relay, rows, a, advance: (ms: number) => void (t += ms) };
  };

  it('quiet commits under the soft budget never cut', () => {
    const { rows, a, advance } = budgeted({
      floor: 10,
      factor: 0,
      quietMs: 1000,
    });
    a.env([del(['x1'])]);
    advance(2000);
    a.env([set(['k'], 1)]);
    advance(2000);
    a.env([set(['k'], 2)]);
    expect(rows).toEqual([]);
  });

  it('exactly half the hard budget is not over the soft budget', () => {
    const { rows, a, advance } = budgeted({
      floor: 4,
      factor: 0,
      quietMs: 1000,
    });
    a.env([del(['x1'])]);
    a.env([del(['x2'])]);
    advance(2000);
    a.env([set(['k'], 1)]);
    expect(rows).toEqual([]);
    a.env([del(['x3'])]);
    advance(2000);
    a.env([set(['k'], 2)]);
    expect(rows).toHaveLength(1);
  });

  it('after a budget cut the next quiet commit with nothing to drop does not cut again', () => {
    const { rows, a, advance } = budgeted({
      floor: 1,
      factor: 0,
      quietMs: 1000,
    });
    a.env([del(['x1'])]);
    a.env([del(['x2'])]);
    expect(rows).toHaveLength(1);
    advance(2000);
    a.env([set(['k'], 1)]);
    expect(rows).toHaveLength(1);
  });

  it('a configured quietMs decides what is quiet; the default is 2000', () => {
    const short = budgeted({ floor: 4, factor: 0, quietMs: 500 });
    for (const x of ['x1', 'x2', 'x3']) short.a.env([del([x])]);
    short.advance(600);
    short.a.env([set(['k'], 1)]);
    expect(short.rows).toHaveLength(1);
    const dflt = budgeted({ floor: 4, factor: 0 });
    for (const x of ['x1', 'x2', 'x3']) dflt.a.env([del([x])]);
    dflt.advance(1999);
    dflt.a.env([set(['k'], 1)]);
    expect(dflt.rows).toEqual([]);
    dflt.advance(2000);
    dflt.a.env([set(['k'], 2)]);
    expect(dflt.rows).toHaveLength(1);
  });

  it('the hard budget is factor times the kept registers', () => {
    const { a } = budgeted({ floor: 0, factor: 4 });
    a.env([set(['x'], 1)]);
    a.env([set(['y'], 1)]);
    a.env([del(['z'])]);
    expect(a.of('compaction').at(-1)).toMatchObject({ budget: 12, count: 1 });
  });
});

describe('relay: consensus readiness and notices', () => {
  const consensus = (opt: RelayOptions = {}) => {
    const rows: RelayRow[] = [];
    const relay = createRelay({
      policy: { verifyCitations: true },
      compaction: { consensus: true },
      onRow: (_r, row) => void rows.push(row),
      ...opt,
    });
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], { k: 0 })]);
    return { relay, rows, a, b };
  };

  it('an ejection that makes the census unanimous cuts', () => {
    const { rows, a, b } = consensus();
    a.compact(true);
    b.env([set(['k'], 1)], { writer: 'forged' });
    expect(rows).toMatchObject([
      { kind: 'cut', record: { reason: 'consensus' } },
    ]);
  });

  it('a leave sends a notice without the leaver', () => {
    const { a, b } = consensus();
    b.compact(true);
    expect(a.of('compaction').at(-1)).toMatchObject({ ready: ['b'] });
    b.conn.disconnect();
    expect(a.of('compaction').at(-1)).toMatchObject({ ready: [] });
  });

  it('readiness resets with the generation: a join and a leave after a cut do not cut again', () => {
    const { relay, rows, a, b } = consensus();
    a.compact(true);
    b.compact(true);
    expect(rows).toHaveLength(1);
    const c = peer(relay, 'c');
    c.hello();
    c.conn.disconnect();
    expect(rows).toHaveLength(1);
    expect(a.of('compaction').at(-1)).toMatchObject({ ready: [] });
  });

  it('after a cut members hear count 0 and nobody ready, behind the re-welcome', () => {
    const { relay, a } = consensus();
    a.env([del(['gone'])]);
    relay.cut('r', { reason: 'consensus' });
    const at = a.sent.findLastIndex((m) => m.t === 'welcome');
    expect(a.sent.slice(at).find((m) => m.t === 'compaction')).toMatchObject({
      count: 0,
      ready: [],
    });
    const migrated = consensus();
    migrated.a.env([set([], { k: 1 })], { schemaVersion: 1 });
    const w = migrated.a.sent.findLastIndex((m) => m.t === 'welcome');
    expect(
      migrated.a.sent.slice(w).find((m) => m.t === 'compaction'),
    ).toMatchObject({ count: 0, ready: [] });
  });

  it('a stalled room is never cut by consensus', async () => {
    const { relay, rows, a, b } = consensus({
      onCommit: () => Promise.reject(new Error('disk')),
      onDurabilityFailed: () => {},
    });
    await tick();
    a.compact(true);
    b.compact(true);
    expect(rows).toEqual([]);
    expect(relay.room('r')?.stalled).toBe(true);
  });

  it('a joiner hears the compaction state after its welcome', () => {
    const { relay } = consensus();
    const c = peer(relay, 'c');
    c.hello();
    const w = c.sent.findIndex((m) => m.t === 'welcome');
    expect(c.sent.slice(w + 1).some((m) => m.t === 'compaction')).toBe(true);
  });

  it('a member can withdraw readiness', () => {
    const { rows, a, b } = consensus();
    b.compact(true);
    b.compact(false);
    a.compact(true);
    expect(rows).toEqual([]);
    expect(a.of('compaction').at(-1)).toMatchObject({ ready: ['a'] });
  });
});

const seqEnv = (
  origin: string,
  version: number,
  seq: number,
  instance: string,
) => ({
  proto: MESH_PROTO_VERSION,
  instance,
  origin,
  writer: origin,
  version,
  hlc: { p: seq, l: 0 },
  policyVersion: 0,
  ops: [set(['k', seq], seq)],
  seq,
});
const generation = (instance: string, seq: number) =>
  ({
    instance,
    seq,
    index: 1,
    reason: 'migration',
    policy: 'discard',
    extent: {},
    preCutMax: {},
    firstStamps: {},
    receipts: {},
  }) as const;

describe('relay.hydrate: what a checkpoint restores', () => {
  it('refuses a second hydrate once the room has state, even with an empty journal', () => {
    const relay = createRelay();
    expect(relay.hydrate('r', { seq: 3 })).toBe(true);
    expect(relay.hydrate('r', { seq: 5 })).toBe(false);
    expect(relay.room('r')?.seq).toBe(3);
  });

  it('a legacy zero high-water mark opens no range', () => {
    let state: RoomState | undefined;
    const relay = createRelay({ onCommit: (_r, _e, s) => void (state = s) });
    relay.hydrate('r', { seq: 2, wm: { o: 0, a: 2 }, registers: rootSeed() });
    const a = peer(relay, 'a');
    a.hello({ seq: 2 });
    a.env([set(['k'], 1)], { origin: 'a', writer: 'wa', version: 3 });
    expect(state?.ranges).toEqual({ a: [[1, 3]] });
  });

  it('restores everMax and the schema version, and defaults the schema to 0', () => {
    let state: RoomState | undefined;
    const relay = createRelay({ onCommit: (_r, _e, s) => void (state = s) });
    relay.hydrate('r', {
      seq: 1,
      registers: rootSeed(),
      everMax: { z: { p: 9, l: 0 } },
    });
    const a = peer(relay, 'a');
    a.hello();
    expect(a.of('welcome')[0]).toMatchObject({ schemaVersion: 0 });
    a.env([set(['k'], 1)]);
    expect(state?.everMax['z']).toEqual({ p: 9, l: 0 });
    const before = relay.room('r')?.instance;
    a.env([set([], { v: 1 })], { schemaVersion: 1 });
    expect(relay.room('r')?.instance).not.toBe(before);
  });

  it('serves the generation from its cut on: the migration envelope at its seq, nothing older', () => {
    const relay = createRelay();
    const journal = [
      seqEnv('a', 3, 3, 'g0'),
      seqEnv('a', 4, 4, 'g0'),
      seqEnv('a', 5, 5, 'g0'),
      seqEnv('a', 1, 6, 'g1'),
      seqEnv('a', 2, 7, 'g1'),
    ];
    expect(() =>
      relay.hydrate('r', {
        seq: 7,
        registers: rootSeed(),
        generation: generation('g1', 5),
        journal,
      }),
    ).not.toThrow();
    expect(relay.room('r')?.journal).toBe(3);
    const b = peer(relay, 'b');
    b.hello({ seq: 4 });
    const w = b.of('welcome')[0] as unknown as {
      mode: string;
      envs: { seq: number }[];
    };
    expect(w.mode).toBe('delta');
    expect(w.envs.map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it('a refused checkpoint leaves no half-loaded room behind', () => {
    const relay = createRelay();
    const bad = [seqEnv('a', 1, 6, 'g-other')];
    expect(() =>
      relay.hydrate('r', {
        seq: 6,
        generation: generation('g1', 5),
        journal: bad,
      }),
    ).toThrow(/inconsistent checkpoint/);
    expect(relay.room('r')).toBeUndefined();
    expect(
      relay.hydrate('r', { seq: 6, generation: generation('g1', 5) }),
    ).toBe(true);
  });

  it('an empty hydrated room is not reported uncuttable; an unrooted one needs no hook', () => {
    const uncuttable: string[] = [];
    const armed = {
      policy: { verifyCitations: true },
      compaction: { consensus: true },
    };
    const relay = createRelay({
      ...armed,
      onUncuttable: (r) => void uncuttable.push(r),
    });
    expect(relay.hydrate('r', { seq: 0 })).toBe(true);
    expect(uncuttable).toEqual([]);
    const silent = createRelay(armed);
    const tomb = [
      { path: ['k'], siblings: [sib('delete', 'z', 1)], water: {} },
    ];
    expect(silent.hydrate('r', { seq: 1, registers: tomb })).toBe(true);
  });
});

describe('relay: after a migration', () => {
  it('an envelope stamped with the current schema is admitted and cuts nothing', () => {
    const relay = createRelay();
    const a = peer(relay, 'a');
    a.hello();
    a.env([set([], { v: 0 })]);
    a.env([set([], { v: 1 })], { schemaVersion: 1 });
    const instance = relay.room('r')?.instance;
    const welcomes = a.of('welcome').length;
    a.env([set(['k'], 1)], { schemaVersion: 1 });
    expect(a.echoed(3)).toBe(true);
    expect(a.of('drop')).toEqual([]);
    expect(relay.room('r')?.instance).toBe(instance);
    expect(a.of('welcome')).toHaveLength(welcomes);
  });
});

describe('relay: the two citation regimes across a cut', () => {
  const gated = () => {
    const relay = createRelay({ policy: { verifyCitations: true } });
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    return { relay, a, b };
  };

  it('a pre-cut dot the seed kept is covered by the frozen extent', () => {
    const { relay, a, b } = gated();
    a.env([set([], { k: 0 })]);
    const x = a.env([set(['x'], 1)]);
    expect(relay.cut('r', { reason: 'compaction' })).toBe(true);
    b.env([set(['x'], 2, [{ origin: 'a', hlc: x.hlc }])]);
    expect(b.echoed(1)).toBe(true);
    expect(b.of('drop')).toEqual([]);
  });

  it('a pre-cut dot the cut dropped stays uncitable after its origin writes the path again', () => {
    const { relay, a, b } = gated();
    a.env([set([], { k: 0 })]);
    const gone = a.env([del(['g'])]);
    expect(relay.cut('r', { reason: 'compaction' })).toBe(true);
    a.env([set(['g'], 1)]);
    b.env([set(['g'], 2, [{ origin: 'a', hlc: gone.hlc }])]);
    expect(b.of('drop')).toMatchObject([{ reason: 'citation', version: 1 }]);
  });
});

describe('relay: held answers skip a connection that left while they waited', () => {
  const held = (opt: RelayOptions = {}) => {
    const pending: (() => void)[] = [];
    const later = () => new Promise<void>((r) => pending.push(r));
    const relay = createRelay({
      onCommit: later,
      onRow: later,
      ...opt,
    });
    const flush = async () => {
      while (pending.length) {
        pending.shift()?.();
        await tick();
      }
    };
    return { relay, flush };
  };

  it('an echo', async () => {
    const { relay, flush } = held();
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], {})]);
    b.conn.disconnect();
    await flush();
    expect(b.of('env')).toEqual([]);
    expect(a.echoed(1)).toBe(true);
  });

  it('a hello welcome, after a disconnect or a connection-scope ejection', async () => {
    const { relay, flush } = held({ ejection: 'connection' });
    const a = peer(relay, 'a');
    a.hello();
    a.env([set([], {})]);
    const c = peer(relay, 'c');
    const d = peer(relay, 'd');
    c.hello();
    d.hello();
    c.conn.disconnect();
    d.env([set(['k'], 1)], { writer: 'forged' });
    await flush();
    expect(c.of('welcome')).toEqual([]);
    expect(d.of('welcome')).toEqual([]);
    expect(a.of('welcome')).toHaveLength(1);
  });

  it('a journaled refusal', async () => {
    const { relay, flush } = held({ policy: { verifyCitations: true } });
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    await flush();
    b.env([set(['k'], 1, [{ origin: 'ghost', hlc: { p: 9, l: 0 } }])]);
    b.conn.disconnect();
    await flush();
    expect(b.of('drop')).toEqual([]);
  });

  it('a cut re-welcome', async () => {
    const { relay, flush } = held();
    const a = peer(relay, 'a');
    const b = peer(relay, 'b');
    a.hello();
    b.hello();
    a.env([set([], {})]);
    await flush();
    relay.cut('r', { reason: 'rollback', seed: rootSeed() });
    b.conn.disconnect();
    await flush();
    expect(b.of('welcome')).toHaveLength(1);
    expect(a.of('welcome')).toHaveLength(2);
  });
});

describe('relay: a failed row without a failure hook', () => {
  it('stalls the room without an unhandled error', async () => {
    const relay = createRelay({
      policy: { verifyCitations: true },
      onRow: () => Promise.reject(new Error('disk')),
    });
    const a = peer(relay, 'a');
    a.hello();
    a.env([set([], {})]);
    a.env([set(['k'], 1, [{ origin: 'ghost', hlc: { p: 9, l: 0 } }])]);
    await tick();
    expect(relay.room('r')?.stalled).toBe(true);
  });
});
