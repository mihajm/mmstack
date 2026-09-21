import { describe, expect, it } from 'vitest';
import { createRelay } from './relay';
import { MESH_PROTO_VERSION, type Hlc } from './wire';

type Env = {
  readonly id: string;
  readonly instance: string;
  readonly origin: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly path: string;
  readonly epoch: number;
};

type Msg =
  | { t: 'welcome'; instance: string; retained: ReadonlySet<string> }
  | { t: 'echo'; instance: string; env: Env }
  | {
      t: 'drop';
      instance: string;
      id: string;
      reason: 'duplicate' | 'generation';
    }
  | { t: 'settled'; instance: string; settled: Readonly<Record<string, Hlc>> };

const later = (a: Hlc | undefined, b: Hlc): Hlc =>
  !a || b.p > a.p || (b.p === a.p && b.l > a.l) ? b : a;

function relayModel() {
  let instance = 'g1';
  let retained = new Set<string>();
  let ranges = new Map<string, Set<number>>();
  let settled: Record<string, Hlc> = {};
  let baselines = new Map<string, number>();
  const inboxes = new Map<string, Msg[]>();
  const retainedBy = new Map<string, string>();
  const log: Msg[] = [];

  const admitted = (origin: string) => ranges.get(origin) ?? new Set<number>();
  const contiguousMax = (origin: string): number => {
    let v = 0;
    const set = admitted(origin);
    while (set.has(v + 1)) v += 1;
    return v;
  };
  const broadcast = (m: Msg) => {
    log.push(m);
    for (const inbox of inboxes.values()) inbox.push(m);
  };

  return {
    get instance() {
      return instance;
    },
    log,
    retainedBy,
    retained: () => retained,
    inbox: (m: string) => inboxes.get(m),
    connect: (m: string) => {
      inboxes.set(m, [{ t: 'welcome', instance, retained: new Set(retained) }]);
    },
    disconnect: (m: string) => void inboxes.delete(m),
    state: () => ({
      instance,
      retained: [...retained].sort(),
      ranges: [...ranges].map(
        ([o, s]) => [o, [...s].sort((a, b) => a - b)] as const,
      ),
      settled,
      baselines: [...baselines].sort(),
    }),
    /** The explicit boundary: a new nonce, every piece of evidence dropped, members re-welcomed. */
    cut: (next: string) => {
      instance = next;
      retained = new Set();
      ranges = new Map();
      settled = {};
      baselines = new Map();
      broadcast({ t: 'welcome', instance, retained: new Set() });
    },
    ingest: (member: string, env: Env, stamps: ReadonlyMap<string, Hlc>) => {
      const reply = (m: Msg) => {
        log.push(m);
        inboxes.get(member)?.push(m);
      };
      // the fence comes FIRST: instance decides before ranges or anything else can answer
      if (env.instance !== instance)
        return reply({ t: 'drop', instance, id: env.id, reason: 'generation' });
      const set = admitted(env.origin);
      if (set.has(env.version))
        return reply({ t: 'drop', instance, id: env.id, reason: 'duplicate' });
      set.add(env.version);
      ranges.set(env.origin, set);
      retained.add(env.id);
      retainedBy.set(env.id, instance);
      baselines.set(
        env.path,
        Math.max(baselines.get(env.path) ?? 0, env.epoch),
      );
      const prefix = contiguousMax(env.origin);
      if (prefix > 0) {
        const stamp = stamps.get(`${instance}:${env.origin}#${prefix}`);
        if (stamp)
          settled = {
            ...settled,
            [env.origin]: later(settled[env.origin], stamp),
          };
      }
      broadcast({ t: 'echo', instance, env });
      broadcast({ t: 'settled', instance, settled });
    },
  };
}

type Relay = ReturnType<typeof relayModel>;

/** Identity registry: one id never denotes two different envelopes. */
const identities = new Map<string, string>();
const mint = (env: Env): Env => {
  const body = JSON.stringify({
    hlc: env.hlc,
    path: env.path,
    epoch: env.epoch,
  });
  const seen = identities.get(env.id);
  if (seen !== undefined && seen !== body)
    throw new Error(`id ${env.id} reused for a different envelope`);
  identities.set(env.id, body);
  return env;
};

type Persisted = { instance: string; tail: Env[]; version: number; p: number };

function clientModel(relay: Relay, origin: string) {
  let instance: string | undefined;
  let version = 0;
  let p = 0;
  let connected = false;
  const unacked = new Map<string, Env>();
  const acked = new Map<string, string>(); // id → generation that acknowledged
  const refused = new Set<string>();
  let applied = new Set<string>();
  let settledSeen: Record<string, Hlc> = {};
  const floors = new Map<string, number>();
  let onRefused: (e: Env) => void = () => void 0;

  const refuse = (e: Env) => {
    unacked.delete(e.id);
    applied.delete(e.id);
    refused.add(e.id);
    onRefused(e);
  };

  const m = {
    origin,
    get instance() {
      return instance;
    },
    get connected() {
      return connected;
    },
    unacked,
    acked,
    refused,
    applied: () => applied,
    floors,
    settledSeen: () => settledSeen,
    onRefused: (cb: (e: Env) => void) => void (onRefused = cb),
    persist: (): Persisted | undefined =>
      instance
        ? { instance, tail: [...unacked.values()], version, p }
        : undefined,
    write: (path: string, epoch = 0): Env | undefined => {
      if (!instance) return undefined;
      p += 1;
      const env = mint({
        id: `${instance}:${origin}#${++version}`,
        instance,
        origin,
        version,
        hlc: { p, l: 0 },
        path,
        epoch,
      });
      unacked.set(env.id, env);
      applied.add(env.id);
      floors.set(path, Math.max(floors.get(path) ?? 0, epoch));
      if (connected) relay.ingest(origin, env, stamps);
      return env;
    },
    connect: () => {
      if (connected) return;
      connected = true;
      relay.connect(origin);
    },
    disconnect: () => {
      if (!connected) return;
      connected = false;
      relay.disconnect(origin);
    },
    /** A persisted outbox restored on a fresh boot: the generation, the tail, and the version and
     *  clock high-water marks — the tail alone cannot say what the last minted identity was. */
    restore: (kept: Persisted) => {
      instance = kept.instance;
      version = Math.max(version, kept.version);
      p = Math.max(p, kept.p);
      for (const e of kept.tail) {
        unacked.set(e.id, e);
        applied.add(e.id);
      }
    },
    drain: (): boolean => {
      const inbox = relay.inbox(origin);
      if (!inbox || inbox.length === 0) return false;
      while (inbox.length) {
        const msg = inbox.shift() as Msg;
        if (msg.t === 'welcome') {
          if (instance !== undefined && msg.instance !== instance) {
            // the boundary on the client: the old tail is refused loudly, and the new generation's
            // snapshot replaces the ENTIRE applied state, acknowledged content included
            for (const e of [...unacked.values()]) refuse(e);
            version = 0;
            settledSeen = {};
            floors.clear();
          }
          instance = msg.instance;
          applied = new Set(msg.retained);
          for (const e of unacked.values()) applied.add(e.id);
          for (const e of [...unacked.values()].sort(
            (a, b) => a.version - b.version,
          ))
            relay.ingest(origin, e, stamps);
          continue;
        }
        if (msg.instance !== instance) continue; // old-generation replies and notices are inert
        if (msg.t === 'settled') settledSeen = msg.settled;
        else if (msg.t === 'echo') {
          if (msg.env.origin === origin) {
            if (unacked.delete(msg.env.id)) acked.set(msg.env.id, msg.instance);
          } else applied.add(msg.env.id);
        } else if (msg.reason === 'duplicate') {
          if (unacked.delete(msg.id)) acked.set(msg.id, msg.instance);
        } else {
          const e = unacked.get(msg.id);
          if (e) refuse(e);
        }
      }
      return true;
    },
  };
  return m;
}

type Client = ReturnType<typeof clientModel>;
const stamps = new Map<string, Hlc>();
const remember = (e: Env | undefined) => {
  if (e) stamps.set(e.id, e.hlc);
  return e as Env;
};

const settle = (clients: readonly Client[]) => {
  let again = true;
  let guard = 0;
  while (again) {
    again = false;
    for (const c of clients) if (c.connected && c.drain()) again = true;
    if (++guard > 10_000) throw new Error('settle did not converge');
  }
};

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

describe('generation model: pinned schedules after the cut', () => {
  const setup = () => {
    stamps.clear();
    identities.clear();
    const relay = relayModel();
    const a = clientModel(relay, 'A');
    a.connect();
    settle([a]);
    return { relay, a };
  };

  it('an old-generation envelope in flight is refused "generation": no state, no acknowledgement', () => {
    const { relay, a } = setup();
    remember(a.write('x'));
    settle([a]);
    a.disconnect();
    const straggler = remember(a.write('y')); // written offline before the cut
    relay.cut('g2');
    const before = JSON.stringify(relay.state());
    a.connect(); // hello → welcome g2 → the client drops its tail; but the envelope was also sent on
    relay.ingest('A', straggler, stamps); // an older path that races the welcome
    expect(JSON.stringify(relay.state())).toBe(before);
    settle([a]);
    expect(a.acked.has(straggler.id)).toBe(false);
    expect(a.applied().has(straggler.id)).toBe(false);
    expect(a.refused.has(straggler.id)).toBe(true);
  });

  it('acknowledged old content does not survive the cut: the new snapshot replaces the applied state', () => {
    const { relay, a } = setup();
    const old = remember(a.write('x'));
    settle([a]);
    expect(a.acked.get(old.id)).toBe('g1');
    expect(a.applied().has(old.id)).toBe(true);
    relay.cut('g2');
    settle([a]);
    expect(a.instance).toBe('g2');
    expect(a.applied().size).toBe(0);
    expect(relay.retained().size).toBe(0);
  });

  it('a resend of something the old generation admitted is refused "generation" even when its version number collides', () => {
    const { relay, a } = setup();
    a.disconnect();
    const admittedBefore = remember(a.write('x'));
    relay.ingest('A', admittedBefore, stamps); // admitted in g1; the echo is never delivered
    relay.cut('g2');
    a.connect();
    settle([a]); // welcome g2: the tail is refused at the fence
    const fresh = remember(a.write('x')); // g2:A#1 — the same version number
    settle([a]);
    relay.ingest('A', admittedBefore, stamps); // and the old one arrives once more
    settle([a]);
    expect(relay.retained().has(fresh.id)).toBe(true);
    expect(relay.retained().size).toBe(1);
    expect(a.acked.get(fresh.id)).toBe('g2');
    expect(a.acked.has(admittedBefore.id)).toBe(false);
    expect(a.refused.has(admittedBefore.id)).toBe(true);
  });

  it('a settled notice from the old generation is inert on a client that moved on', () => {
    const { relay, a } = setup();
    remember(a.write('x'));
    settle([a]);
    const oldNotice = relay.log.find((m) => m.t === 'settled') as Msg;
    relay.cut('g2');
    settle([a]);
    relay.inbox('A')?.push(oldNotice);
    settle([a]);
    expect(a.settledSeen()).toEqual({});
  });

  it('a persisted outbox from the old generation restored after the cut is refused loudly, never applied, never acknowledged', () => {
    const { relay, a } = setup();
    a.disconnect();
    remember(a.write('x', 3));
    remember(a.write('y', 1));
    const kept = a.persist() as Persisted;
    relay.cut('g2');
    const boot = clientModel(relay, 'A');
    const refused: Env[] = [];
    boot.onRefused((e) => refused.push(e));
    boot.restore(kept);
    boot.connect();
    settle([boot]);
    expect(refused.map((e) => e.id)).toEqual(kept.tail.map((e) => e.id));
    expect(boot.unacked.size).toBe(0);
    expect(boot.applied().size).toBe(0);
    expect(boot.acked.size).toBe(0);
    expect(boot.floors.size).toBe(0);
    expect(relay.retained().size).toBe(0);
  });

  it('a same-generation outbox restored on boot continues the identity sequence, never reusing an id', () => {
    const { relay, a } = setup();
    a.disconnect();
    remember(a.write('x'));
    const kept = a.persist() as Persisted;
    const boot = clientModel(relay, 'A');
    boot.restore(kept);
    const next = remember(boot.write('y')); // would be g1:A#1 again if only the tail were restored
    expect(next.id).toBe('g1:A#2');
    boot.connect();
    settle([boot]);
    expect(boot.acked.get('g1:A#1')).toBe('g1');
    expect(boot.acked.get('g1:A#2')).toBe('g1');
  });
});

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('generation model: twin property (both sides)', () => {
  it('relay state and client acknowledgements are a function of new-generation messages only (1500 seeds)', () => {
    for (let seed = 0; seed < 1500; seed++) {
      stamps.clear();
      identities.clear();
      const rnd = mulberry32(seed);
      const relay = relayModel();
      const clients = ['A', 'B'].map((o) => clientModel(relay, o));
      const disks = new Map<string, Persisted>();
      for (const c of clients) c.connect();
      settle(clients);
      let gen = 1;
      for (let step = 0; step < 40; step++) {
        const c = clients[Math.floor(rnd() * 2)];
        const r = rnd();
        if (r < 0.35)
          remember(
            c.write(
              ['x', 'y', 'z'][Math.floor(rnd() * 3)],
              Math.floor(rnd() * 3),
            ),
          );
        else if (r < 0.5) c.disconnect();
        else if (r < 0.6) {
          // a reboot with the persisted outbox, from whatever generation it was written in
          const kept = c.persist();
          if (kept) disks.set(c.origin, kept);
          c.disconnect();
          const fresh = clientModel(relay, c.origin);
          const stored = disks.get(c.origin);
          if (stored) fresh.restore(stored);
          clients[clients.indexOf(c)] = fresh;
          fresh.connect();
        } else if (r < 0.7) {
          gen += 1;
          relay.cut(`g${gen}`);
        } else if (r < 0.8 && c.connected) {
          // a straggler: resend something already sent, maybe from an old generation
          const all = [...stamps.keys()];
          if (all.length) {
            const id = all[Math.floor(rnd() * all.length)];
            const [inst, rest] = id.split(':');
            const [origin, v] = rest.split('#');
            if (origin === c.origin) {
              relay.ingest(
                c.origin,
                {
                  id,
                  instance: inst,
                  origin,
                  version: Number(v),
                  hlc: stamps.get(id) as Hlc,
                  path: 'x',
                  epoch: 0,
                },
                stamps,
              );
            }
          }
        } else c.connect();
        settle(clients);
        // S1/S2 on every client: acknowledged ⇒ retained by that generation; refused ⇒ not retained now
        for (const k of clients) {
          for (const [id, g] of k.acked) {
            expect(
              relay.retainedBy.get(id),
              `seed ${seed} step ${step}: ${k.origin} acked ${id} in ${g}`,
            ).toBe(g);
          }
          for (const id of k.refused) {
            expect(
              relay.retained().has(id),
              `seed ${seed} step ${step}: ${k.origin} refused a retained ${id}`,
            ).toBe(false);
          }
          // nothing applied from another generation than the one the client is in
          if (k.instance) {
            for (const id of k.applied()) {
              expect(
                id.startsWith(`${k.instance}:`),
                `seed ${seed} step ${step}: ${k.origin} applies ${id} in ${k.instance}`,
              ).toBe(true);
            }
          }
          // a connected, current client applies exactly what the relay retains (plus nothing)
          if (
            k.connected &&
            k.instance === relay.instance &&
            k.unacked.size === 0
          ) {
            expect(
              same(k.applied(), relay.retained()),
              `seed ${seed} step ${step}: ${k.origin} applied set`,
            ).toBe(true);
          }
        }
        // relay: nothing retained from another generation
        for (const id of relay.retained())
          expect(id.startsWith(`${relay.instance}:`)).toBe(true);
      }
    }
  });
});

describe('generation: the real relay', () => {
  it('refuses an old-generation envelope after a cut (hydrate under a new instance), answering the writer "generation"', () => {
    const relay = createRelay();
    const sent: unknown[] = [];
    const conn = relay.connect({ send: (m) => sent.push(m), close: () => void 0 }, { writer: 'w' });
    conn.receive({ t: 'hello', room: 'r', origin: 'o', proto: MESH_PROTO_VERSION, policyVersion: 0 });
    const env = {
      proto: MESH_PROTO_VERSION,
      instance: relay.room('r')?.instance ?? '',
      policyVersion: 0,
      origin: 'o',
      writer: 'w',
      version: 1,
      hlc: { p: 5, l: 0 },
      ops: [{ kind: 'set' as const, path: ['x'], next: 1, cites: [], epoch: 0 }],
    };
    conn.receive({ t: 'env', room: 'r', env });
    expect(relay.room('r')?.seq).toBe(1);
    // a cut: the room comes back under a new instance at seq 0
    const relay2 = createRelay();
    expect(relay2.hydrate('r', { seq: 0, registers: [], wm: {}, instance: 'g2' })).toBe(true);
    const sent2: { t: string; reason?: string }[] = [];
    const conn2 = relay2.connect({ send: (m) => sent2.push(m as { t: string }), close: () => void 0 }, { writer: 'w' });
    conn2.receive({ t: 'hello', room: 'r', origin: 'o', proto: MESH_PROTO_VERSION, policyVersion: 0 });
    conn2.receive({ t: 'env', room: 'r', env }); // the old-generation envelope, byte for byte
    expect(relay2.room('r')?.seq).toBe(0);
    expect(sent2.filter((m) => m.t === 'drop')).toEqual([
      { t: 'drop', room: 'r', origin: 'o', version: 1, reason: 'generation' },
    ]);
  });
});
