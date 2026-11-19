import { describe, expect, it } from 'vitest';
import { createRelay, type RelayConnection } from './relay';
import { MESH_PROTO_VERSION, type ServerMsg, type SyncOp } from './wire';

// The relay is a sequencer: each member reads the room's log as a prefix, in seq order, the way
// the session model's relay pushes one admitted envelope into every inbox at once. These specs
// hold the real relay to that under sockets whose `send` re-enters the relay synchronously (an
// in-process transport whose listener writes, joins, or replays during a fan-out).

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Peer = {
  readonly origin: string;
  readonly got: ServerMsg[];
  conn: RelayConnection;
  instance: string;
  version: number;
  react?: (msg: ServerMsg) => void;
};

const set = (path: (string | number)[], next: unknown): SyncOp => ({
  kind: 'set',
  path,
  next,
  cites: [],
  epoch: 0,
});

function room() {
  const admitted: { seq: number; origin: string; version: number }[] = [];
  const relay = createRelay({
    policy: { verifyCitations: true },
    onCommit: (_, env) =>
      void admitted.push({
        seq: env.seq,
        origin: env.origin,
        version: env.version,
      }),
  });
  const peers = new Map<string, Peer>();
  let clock = 0;
  let key = 0;
  const join = (origin: string): Peer => {
    const peer = {
      origin,
      got: [],
      instance: 'unwelcomed',
      version: 0,
    } as unknown as Peer;
    peer.conn = relay.connect(
      {
        send: (msg) => {
          peer.got.push(msg);
          if (msg.t === 'welcome') peer.instance = msg.instance;
          peer.react?.(msg);
        },
      },
      { writer: origin },
    );
    peers.set(origin, peer);
    peer.conn.receive({
      t: 'hello',
      room: 'r',
      origin,
      proto: MESH_PROTO_VERSION,
      policyVersion: 0,
    });
    return peer;
  };
  const write = (
    origin: string,
    ops?: SyncOp[],
    schemaVersion?: number,
  ): void => {
    const peer = peers.get(origin) as Peer;
    peer.conn.receive({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: peer.instance,
        origin,
        writer: origin,
        version: ++peer.version,
        hlc: { p: ++clock, l: 0 },
        policyVersion: 0,
        ops: ops ?? [set(['k', key++], key)],
        schemaVersion,
      },
    });
  };
  let schema = 0;
  /** A root replace that raises the schema: a cut whose row is this envelope. */
  const migrate = (origin: string): void =>
    write(origin, [set([], { k: {}, schema: schema + 1 })], ++schema);
  return { relay, peers, admitted, join, write, migrate };
}

const docSeq = (msg: ServerMsg): number | undefined =>
  msg.t === 'welcome' ? msg.seq : msg.t === 'env' ? msg.env.seq : undefined;

/**
 * Property R on one connection: envelope seqs strictly increase, and a welcome's seq is at or
 * above every seq before it, equal only to the migration envelope whose cut it announces (that
 * re-welcome carries the envelope's own seq). The first breach, or null.
 */
function breachOfR(got: readonly ServerMsg[]): string | null {
  let prev: ServerMsg | undefined;
  for (const msg of got) {
    const seq = docSeq(msg);
    if (seq === undefined) continue;
    const last = prev && docSeq(prev);
    const announces =
      msg.t === 'welcome' &&
      msg.mode === 'snapshot' &&
      msg.reason === 'migration' &&
      prev?.t === 'env' &&
      prev.env.instance !== msg.instance;
    if (last !== undefined && (seq < last || (seq === last && !announces)))
      return `read ${msg.t} seq ${seq} after ${last}`;
    prev = msg;
  }
  return null;
}

/** Property R and C over everything the peers received; the first violation, or null. */
function violation(
  peers: Iterable<Peer>,
  admitted: readonly { seq: number }[],
): string | null {
  for (const peer of peers) {
    const r = breachOfR(peer.got);
    if (r) {
      const seqs = peer.got.map(docSeq).filter((s) => s !== undefined);
      return `${peer.origin} ${r}: [${seqs.join(', ')}]`;
    }
    const first = peer.got.find((m) => m.t === 'welcome');
    if (!first || first.t !== 'welcome') return `${peer.origin} never welcomed`;
    const want = admitted
      .map((a) => a.seq)
      .filter((s) => s > first.seq)
      .sort((x, y) => x - y);
    const echoes = peer.got
      .flatMap((m) => (m.t === 'env' ? [m.env.seq] : []))
      .sort((x, y) => x - y);
    if (JSON.stringify(echoes) !== JSON.stringify(want))
      return `${peer.origin} echoes [${echoes.join(', ')}], want [${want.join(', ')}]`;
  }
  return null;
}

describe('relay: delivery order under re-entrant sockets', () => {
  it('an envelope submitted from inside a send is echoed after the one in flight', () => {
    const r = room();
    const a = r.join('a');
    const b = r.join('b');
    let once = false;
    a.react = (msg) => {
      if (msg.t !== 'env' || once) return;
      once = true;
      r.write('a');
    };
    r.write('a', [set([], { k: {} })]);
    const seqs = (p: Peer) =>
      p.got.flatMap((m) => (m.t === 'env' ? [m.env.seq] : []));
    expect(seqs(a)).toEqual([1, 2]);
    expect(seqs(b)).toEqual([1, 2]);
  });

  it('a write made on another connection from inside a fan-out keeps per-origin order for later members', () => {
    const r = room();
    r.join('a');
    const b = r.join('b');
    const c = r.join('c');
    r.write('a', [set([], { k: {} })]);
    let once = false;
    b.react = (msg) => {
      if (msg.t !== 'env' || msg.env.version !== 2 || once) return;
      once = true;
      r.write('a');
    };
    r.write('a');
    const versions = c.got.flatMap((m) =>
      m.t === 'env' && m.env.origin === 'a' ? [m.env.version] : [],
    );
    expect(versions).toEqual([1, 2, 3]);
  });

  it('a tail replayed from inside a cut re-welcome reaches later members after their re-welcome', () => {
    const r = room();
    const a = r.join('a');
    const b = r.join('b');
    r.write('a', [set([], { k: {} })]);
    let replayed = false;
    a.react = (msg) => {
      if (msg.t !== 'welcome' || replayed) return;
      replayed = true;
      r.write('a');
    };
    expect(r.relay.cut('r', { reason: 'compaction' })).toBe(true);
    expect(replayed).toBe(true);
    const welcomes = b.got.flatMap((m, i) => (m.t === 'welcome' ? [i] : []));
    expect(welcomes).toHaveLength(2);
    const rewelcome = welcomes[1];
    const echo = b.got.findIndex(
      (m) => m.t === 'env' && m.env.origin === 'a' && m.env.version === 2,
    );
    expect(echo).toBeGreaterThan(rewelcome);
    expect(violation(r.peers.values(), r.admitted)).toBeNull();
  });

  it('a migration re-welcomes at its own seq: R as stated holds, a strictly increasing welcome seq would not', () => {
    const r = room();
    r.join('a');
    const b = r.join('b');
    r.write('a', [set([], { k: {} })]);
    let wrote = false;
    b.react = (msg) => {
      if (msg.t !== 'welcome' || wrote) return;
      wrote = true;
      r.write('b');
    };
    r.migrate('a');
    const seqs = b.got.map(docSeq).filter((s) => s !== undefined);
    expect(seqs).toEqual([0, 1, 2, 2, 3]);
    expect(b.got.filter((m) => m.t === 'welcome')[1]).toMatchObject({
      mode: 'snapshot',
      reason: 'migration',
    });
    expect(violation(r.peers.values(), r.admitted)).toBeNull();
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(false);
  });

  it('a welcome at an envelope seq that is not a migration breaks R', () => {
    const at = (seq: number, instance: string): ServerMsg => ({
      t: 'welcome',
      room: 'r',
      seq,
      instance,
      schemaVersion: 0,
      mode: 'up-to-date',
      peers: [],
      members: [],
    });
    const env = (seq: number): ServerMsg => ({
      t: 'env',
      room: 'r',
      env: {
        proto: MESH_PROTO_VERSION,
        instance: 'g0',
        origin: 'a',
        writer: 'a',
        version: seq,
        hlc: { p: seq, l: 0 },
        policyVersion: 0,
        ops: [],
        seq,
      },
    });
    expect(breachOfR([at(0, 'g0'), env(1), at(1, 'g1')])).toBe(
      'read welcome seq 1 after 1',
    );
    expect(breachOfR([at(0, 'g0'), env(1), env(1)])).toBe(
      'read env seq 1 after 1',
    );
    expect(breachOfR([at(0, 'g0'), env(2), at(1, 'g0')])).toBe(
      'read welcome seq 1 after 2',
    );
  });

  it('holds R and C over random re-entrant schedules with cuts and migrations (2000 seeds)', () => {
    let failures = 0;
    let first: string | null = null;
    let announced = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const rnd = mulberry32(seed);
      const r = room();
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rnd() * xs.length)];
      let budget = 3 + Math.floor(rnd() * 10);
      let joined = 0;
      const arm = (peer: Peer) => {
        const q = rnd();
        peer.react = (msg) => {
          if (docSeq(msg) === undefined || budget <= 0 || rnd() >= q) return;
          budget--;
          const roll = rnd();
          if (roll < 0.15 && joined < 5) arm(r.join(`j${joined++}`));
          else if (roll < 0.25) r.migrate(pick([...r.peers.keys()]));
          else r.write(pick([...r.peers.keys()]));
        };
      };
      const n = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) arm(r.join(`m${i}`));
      r.write('m0', [set([], { k: {} })]);
      const steps = 2 + Math.floor(rnd() * 8);
      for (let s = 0; s < steps; s++) {
        const roll = rnd();
        if (roll < 0.15) r.relay.cut('r', { reason: 'compaction' });
        else if (roll < 0.25 && joined < 5) arm(r.join(`j${joined++}`));
        else if (roll < 0.35) r.migrate(pick([...r.peers.keys()]));
        else r.write(pick([...r.peers.keys()]));
      }
      for (const peer of r.peers.values()) {
        const seqs = peer.got.map(docSeq).filter((s) => s !== undefined);
        if (seqs.some((s, i) => i > 0 && s === seqs[i - 1])) announced++;
      }
      const v = violation(r.peers.values(), r.admitted);
      if (v) {
        failures++;
        first ??= `seed ${seed}: ${v}`;
      }
    }
    expect(first).toBeNull();
    expect(failures).toBe(0);
    // the schedules reach the re-welcome a migration sends at its own seq
    expect(announced).toBeGreaterThan(500);
  });
});
