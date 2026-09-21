import { beforeEach, describe, expect, it } from 'vitest';
import type { Hlc } from './wire';

type Env = {
  readonly id: string;
  readonly instance: string;
  readonly origin: string;
  readonly version: number;
  readonly hlc: Hlc;
  readonly path: string;
  readonly epoch: number;
};
type SeqEnv = Env & { readonly seq: number };

type Msg =
  | {
      t: 'welcome';
      instance: string;
      mode: 'delta';
      envs: readonly SeqEnv[];
      seq: number;
    }
  | {
      t: 'welcome';
      instance: string;
      mode: 'snapshot';
      retained: ReadonlySet<string>;
      seq: number;
    }
  | { t: 'env'; instance: string; env: SeqEnv }
  | {
      t: 'drop';
      instance: string;
      id: string;
      reason: 'duplicate' | 'generation';
    };

function relayModel(journalLimit: number) {
  let instance = 'g1';
  let seq = 0;
  let journal: SeqEnv[] = [];
  let retained = new Set<string>();
  let ranges = new Map<string, Set<number>>();
  const inboxes = new Map<string, Msg[]>();
  const retainedBy = new Map<string, string>(); // id → generation that retained it

  return {
    get instance() {
      return instance;
    },
    get seq() {
      return seq;
    },
    retained: () => retained,
    retainedBy,
    inbox: (m: string) => inboxes.get(m),
    connect: (m: string) => void inboxes.set(m, []),
    disconnect: (m: string) => void inboxes.delete(m),
    cut: () => {
      instance = `g${Number(instance.slice(1)) + 1}`;
      seq = 0;
      journal = [];
      retained = new Set();
      ranges = new Map();
      // C6: every member is re-welcomed under the new nonce; the welcome is the client's fence
      for (const inbox of inboxes.values()) {
        inbox.push({
          t: 'welcome',
          instance,
          mode: 'snapshot',
          retained: new Set(),
          seq: 0,
        });
      }
    },
    hello: (
      m: string,
      known: { instance: string; seq: number } | undefined,
    ) => {
      const inbox = inboxes.get(m);
      if (!inbox) throw new Error('hello without a connection');
      const sameGen = known?.instance === instance;
      if (sameGen && known && (seq === 0 || known.seq === seq)) {
        inbox.push({ t: 'welcome', instance, mode: 'delta', envs: [], seq });
      } else if (
        sameGen &&
        known &&
        known.seq > 0 &&
        journal.length > 0 &&
        known.seq >= journal[0].seq - 1
      ) {
        inbox.push({
          t: 'welcome',
          instance,
          mode: 'delta',
          envs: journal.filter((e) => e.seq > known.seq),
          seq,
        });
      } else {
        inbox.push({
          t: 'welcome',
          instance,
          mode: 'snapshot',
          retained: new Set(retained),
          seq,
        });
      }
    },
    ingest: (m: string, env: Env) => {
      const reply = (msg: Msg) => inboxes.get(m)?.push(msg);
      if (env.instance !== instance)
        return reply({ t: 'drop', instance, id: env.id, reason: 'generation' });
      const set = ranges.get(env.origin) ?? new Set<number>();
      if (set.has(env.version))
        return reply({ t: 'drop', instance, id: env.id, reason: 'duplicate' });
      set.add(env.version);
      ranges.set(env.origin, set);
      const s: SeqEnv = { ...env, seq: ++seq };
      journal.push(s);
      if (journal.length > journalLimit) journal.shift();
      retained.add(env.id);
      retainedBy.set(env.id, instance);
      for (const inbox of inboxes.values())
        inbox.push({ t: 'env', instance, env: s });
    },
  };
}

type Relay = ReturnType<typeof relayModel>;

/** What the outbox persists: the generation, the tail, the floors, and the version and clock
 *  high-water marks — an empty tail says nothing about the last identity minted. */
type Persisted = {
  instance: string;
  tail: Env[];
  floors: Map<string, number>;
  version: number;
  p: number;
};

/** Identity registry: one id never denotes two different envelopes (I). */
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

function sessionModel(
  relay: Relay,
  origin: string,
  disk: { current?: Persisted },
) {
  let instance: string | undefined; // unknown until the first welcome
  let version = 0;
  let p = 0;
  let lastSeq = 0;
  let connected = false;
  let live = false;
  const unacked = new Map<string, Env>();
  const acked = new Map<string, string>(); // id → generation that acknowledged
  const refused = new Set<string>();
  const applied = new Set<string>();
  const floors = new Map<string, number>();
  // whenAcked: armed by a write, settles when every awaited write is STORED, rejects when any is
  // refused — a refusal is a classification, not an acknowledgement
  const awaited = new Set<string>();
  let rejectedAwait = false;
  let rehydrate = false;

  const persist = () => {
    if (instance)
      disk.current = {
        instance,
        tail: [...unacked.values()],
        floors: new Map(floors),
        version,
        p,
      };
  };
  const refuse = (e: Env) => {
    unacked.delete(e.id);
    applied.delete(e.id);
    refused.add(e.id);
    if (awaited.has(e.id)) rejectedAwait = true;
  };
  const ack = (id: string, gen: string) => {
    if (!unacked.delete(id)) return;
    acked.set(id, gen);
    awaited.delete(id);
  };

  const m = {
    origin,
    get instance() {
      return instance;
    },
    get connected() {
      return connected;
    },
    get live() {
      return live;
    },
    unacked,
    acked,
    refused,
    applied,
    floors,
    ackState: (): 'pending' | 'settled' | 'rejected' =>
      rejectedAwait ? 'rejected' : awaited.size ? 'pending' : 'settled',
    write: (path: string, epoch: number) => {
      if (!instance) return; // nothing is written before the first welcome names the generation
      p += 1;
      const e = mint({
        id: `${instance}:${origin}#${++version}`,
        instance,
        origin,
        version,
        hlc: { p, l: 0 },
        path,
        epoch,
      });
      unacked.set(e.id, e);
      applied.add(e.id);
      floors.set(path, Math.max(floors.get(path) ?? 0, epoch));
      awaited.add(e.id);
      if (live) relay.ingest(origin, e);
      persist();
    },
    connect: () => {
      if (connected) return;
      connected = true;
      relay.connect(origin);
      relay.hello(origin, instance ? { instance, seq: lastSeq } : undefined);
    },
    disconnect: () => {
      if (!connected) return;
      connected = false;
      live = false;
      relay.disconnect(origin);
    },
    writeLost: (path: string, epoch: number) => {
      m.write(path, epoch);
      m.disconnect();
    },
    /** A new boot: memory gone, the persisted outbox (instance, tail, floors) read back. */
    reboot: () => {
      m.disconnect();
      applied.clear();
      unacked.clear();
      floors.clear();
      awaited.clear();
      rejectedAwait = false;
      lastSeq = 0;
      instance = undefined;
      version = 0;
      p = 0; // the clock high-water is memory too: after a real restart only the disk knows it
      const kept = disk.current;
      if (kept) {
        // adopt the persisted generation until a welcome says otherwise; the welcome decides
        instance = kept.instance;
        version = kept.version;
        p = kept.p;
        for (const e of kept.tail) {
          unacked.set(e.id, e);
          applied.add(e.id);
          awaited.add(e.id);
        }
        for (const [k, v] of kept.floors) floors.set(k, v);
      }
    },
    drain: (): boolean => {
      const inbox = relay.inbox(origin);
      if (!inbox || inbox.length === 0) return false;
      while (inbox.length) {
        const msg = inbox.shift() as Msg;
        if (msg.t === 'welcome') {
          if (instance !== undefined && msg.instance !== instance) {
            // the boundary: the old tail is refused loudly, applied state is the new generation's
            for (const e of [...unacked.values()]) refuse(e);
            applied.clear();
            floors.clear();
            version = 0;
            lastSeq = 0;
          }
          instance = msg.instance;
          if (msg.mode === 'delta') {
            for (const e of msg.envs) m.fold(e);
          } else {
            applied.clear();
            for (const id of msg.retained) applied.add(id);
            for (const e of unacked.values()) applied.add(e.id); // hydrate replays the pending tail
          }
          lastSeq = Math.max(lastSeq, msg.seq);
          live = true;
          // invariant: nothing from another generation is applied once the welcome named this one
          // (the primary fence; the relay's `generation` reply is defence in depth, and would only
          // remove the entry one round trip later, after it had been shown locally again)
          for (const id of applied) {
            if (!id.startsWith(`${instance}:`))
              throw new Error(`${origin} applies ${id} in ${instance}`);
          }
          for (const e of [...unacked.values()].sort(
            (a, b) => a.version - b.version,
          ))
            relay.ingest(origin, e);
          persist();
          continue;
        }
        if (msg.instance !== instance) continue; // an old generation's message is inert
        if (msg.t === 'env') {
          m.fold(msg.env);
        } else if (msg.reason === 'duplicate') {
          ack(msg.id, msg.instance);
        } else {
          const e = unacked.get(msg.id);
          if (e) {
            refuse(e);
            rehydrate = true;
          }
        }
        persist();
      }
      if (rehydrate) {
        rehydrate = false;
        lastSeq = 0;
        relay.hello(origin, { instance: instance as string, seq: 0 });
      }
      return true;
    },
    fold: (e: SeqEnv) => {
      lastSeq = Math.max(lastSeq, e.seq);
      if (e.origin === origin) {
        ack(e.id, e.instance);
        return;
      }
      applied.add(e.id);
    },
  };
  return m;
}

type Session = ReturnType<typeof sessionModel>;

const settle = (sessions: readonly Session[]) => {
  let again = true;
  let guard = 0;
  while (again) {
    again = false;
    for (const s of sessions) if (s.connected && s.drain()) again = true;
    if (++guard > 10_000) throw new Error('settle did not converge');
  }
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

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

function check(
  relay: Relay,
  sessions: readonly Session[],
  where: string,
): string | null {
  for (const s of sessions) {
    for (const [id, gen] of s.acked) {
      if (relay.retainedBy.get(id) !== gen)
        return `${where}: ${s.origin} acked ${id} which ${gen} never retained`; // S1
    }
    for (const id of s.refused) {
      if (relay.retained().has(id))
        return `${where}: ${s.origin} refused ${id} which the current generation retains`; // S2
    }
    if (s.connected && s.live && s.instance === relay.instance) {
      if (s.unacked.size !== 0)
        return `${where}: ${s.origin} still has ${s.unacked.size} unacked after settling`; // L
      if (s.ackState() === 'pending')
        return `${where}: ${s.origin} whenAcked pending with an empty tail`; // L
      if (
        s.ackState() === 'settled' &&
        [...s.refused].some((id) => s.acked.has(id))
      )
        return `${where}: refused and acked`;
      if (!same(s.applied, relay.retained()))
        return `${where}: ${s.origin} applies {${[...s.applied]}} vs relay {${[...relay.retained()]}}`; // S3
    }
  }
  return null;
}

describe('session model: pinned', () => {
  beforeEach(() => identities.clear());

  it('L: a lost echo is classified one round trip after the next welcome, and whenAcked settles', () => {
    const relay = relayModel(3);
    const disk: { current?: Persisted } = {};
    const a = sessionModel(relay, 'A', disk);
    a.connect();
    settle([a]);
    a.writeLost('x', 0);
    expect(a.ackState()).toBe('pending');
    a.connect();
    settle([a]);
    expect(a.unacked.size).toBe(0);
    expect(a.ackState()).toBe('settled');
    expect(a.acked.get('g1:A#1')).toBe('g1');
  });

  it('F: floors survive a reboot within a generation and are empty after a cut', () => {
    const relay = relayModel(3);
    const disk: { current?: Persisted } = {};
    const a = sessionModel(relay, 'A', disk);
    a.connect();
    settle([a]);
    a.write('x', 4);
    settle([a]);
    a.reboot();
    expect(a.floors.get('x')).toBe(4);
    a.connect();
    settle([a]);
    expect(a.floors.get('x')).toBe(4);
    relay.cut();
    a.disconnect();
    a.connect();
    settle([a]);
    expect(a.floors.size).toBe(0);
    expect(a.instance).toBe('g2');
  });

  it('I: an empty outbox keeps the version high-water — a write after a reboot never reuses an acknowledged id', () => {
    const relay = relayModel(3);
    const disk: { current?: Persisted } = {};
    const a = sessionModel(relay, 'A', disk);
    a.connect();
    settle([a]);
    a.write('x', 0);
    settle([a]);
    expect(a.acked.has('g1:A#1')).toBe(true);
    a.reboot(); // tail is empty; only the persisted high-water knows #1 was minted
    a.connect();
    settle([a]);
    a.write('y', 0); // must be g1:A#2, else the relay answers "duplicate" and y is "acknowledged" without landing
    settle([a]);
    expect(a.acked.has('g1:A#2')).toBe(true);
    expect(relay.retained().has('g1:A#2')).toBe(true);
  });

  it('L: a refusal rejects the acknowledgement barrier instead of settling it', () => {
    const relay = relayModel(3);
    const disk: { current?: Persisted } = {};
    const a = sessionModel(relay, 'A', disk);
    a.connect();
    settle([a]);
    a.disconnect();
    a.write('x', 0); // offline
    expect(a.ackState()).toBe('pending');
    relay.cut();
    a.connect();
    settle([a]);
    expect(a.unacked.size).toBe(0);
    expect(a.refused.has('g1:A#1')).toBe(true);
    expect(a.ackState()).toBe('rejected');
  });

  it('a persisted tail from an old generation is refused on the first welcome, never acknowledged', () => {
    const relay = relayModel(3);
    const disk: { current?: Persisted } = {};
    const a = sessionModel(relay, 'A', disk);
    a.connect();
    settle([a]);
    a.writeLost('x', 0); // g1:A#1 retained, echo lost, persisted
    a.reboot();
    relay.cut();
    a.connect(); // hello names g1; the welcome names g2
    settle([a]);
    expect(a.refused.has('g1:A#1')).toBe(true);
    expect(a.acked.size).toBe(0);
    expect(a.applied.size).toBe(0);
    expect(relay.retained().size).toBe(0);
  });

  it('a peer that hands on its own unacknowledged write leaves the receiver apart from the room', () => {
    const relay = relayModel(3);
    const a = sessionModel(relay, 'A', {});
    const b = sessionModel(relay, 'B', {});
    a.connect();
    b.connect();
    settle([a, b]);
    a.disconnect();
    a.write('x', 0); // never reaches the relay, and A does not come back
    const own = [...a.unacked.values()][0];
    b.fold({ ...own, seq: 0 }); // handed over a peer channel, unsequenced
    settle([b]);
    // B shows a write the room never took, and nothing the relay will ever send corrects it
    expect(check(relay, [b], 'forwarded own write')).toContain(
      'B applies {g1:A#1} vs relay {}',
    );
  });

  it('a sequenced envelope handed on by a peer is the relay delivery arriving early, nothing more', () => {
    const relay = relayModel(3);
    const a = sessionModel(relay, 'A', {});
    const b = sessionModel(relay, 'B', {});
    a.connect();
    b.connect();
    settle([a, b]);
    a.write('x', 0); // sequenced: the echo is in A's inbox, B's copy is still in flight
    const echo = relay.inbox('A')?.find((msg) => msg.t === 'env');
    if (echo?.t !== 'env') throw new Error('no echo');
    b.fold(echo.env); // the peer channel wins the race
    expect(check(relay, [b], 'early')).toBeNull();
    settle([a, b]); // the relay copy lands on top of it
    expect(check(relay, [a, b], 'settled')).toBeNull();
    expect([...b.applied]).toEqual(['g1:A#1']);
  });
});

describe('session model: random schedules', () => {
  it('L, I, S1, S2, S3 and F hold across 1500 seeds', () => {
    for (let seed = 0; seed < 1500; seed++) {
      identities.clear();
      const rnd = mulberry32(seed);
      const relay = relayModel(1 + Math.floor(rnd() * 3));
      const disks: { current?: Persisted }[] = [{}, {}];
      const sessions = ['A', 'B'].map((o, i) =>
        sessionModel(relay, o, disks[i]),
      );
      for (const s of sessions) s.connect();
      settle(sessions);
      for (let step = 0; step < 40; step++) {
        const s = sessions[Math.floor(rnd() * 2)];
        const r = rnd();
        const path = ['x', 'y'][Math.floor(rnd() * 2)];
        const epoch = Math.floor(rnd() * 3);
        if (r < 0.3) s.write(path, epoch);
        else if (r < 0.45) s.writeLost(path, epoch);
        else if (r < 0.55) s.disconnect();
        else if (r < 0.65) {
          const before = new Map(s.floors);
          const gen = s.instance;
          s.reboot();
          if (gen === disks[sessions.indexOf(s)].current?.instance) {
            expect(
              new Map(s.floors),
              `seed ${seed} step ${step}: floors after reboot`,
            ).toEqual(before); // F
          }
        } else if (r < 0.72) relay.cut();
        else s.connect();
        settle(sessions);
        const v = check(relay, sessions, `seed ${seed} step ${step}`);
        expect(v).toBeNull();
      }
    }
  });
});
