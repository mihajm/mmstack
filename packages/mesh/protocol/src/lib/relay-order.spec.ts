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
  const write = (origin: string, ops?: SyncOp[]): void => {
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
      },
    });
  };
  return { relay, peers, admitted, join, write };
}

const docSeq = (msg: ServerMsg): number | undefined =>
  msg.t === 'welcome' ? msg.seq : msg.t === 'env' ? msg.env.seq : undefined;

/** Property R and C over everything the peers received; the first violation, or null. */
function violation(
  peers: Iterable<Peer>,
  admitted: readonly { seq: number }[],
): string | null {
  for (const peer of peers) {
    const seqs = peer.got
      .map(docSeq)
      .filter((s): s is number => s !== undefined);
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] <= seqs[i - 1])
        return `${peer.origin} read seq ${seqs[i]} after ${seqs[i - 1]}: [${seqs.join(', ')}]`;
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

  it('holds R and C over random re-entrant schedules (2000 seeds)', () => {
    let failures = 0;
    let first: string | null = null;
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
        else r.write(pick([...r.peers.keys()]));
      }
      const v = violation(r.peers.values(), r.admitted);
      if (v) {
        failures++;
        first ??= `seed ${seed}: ${v}`;
      }
    }
    expect(first).toBeNull();
    expect(failures).toBe(0);
  });
});
