/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  createEnvironmentInjector,
  DestroyRef,
  effect,
  EnvironmentInjector,
  Injector,
  untracked,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createRelay, type Relay } from '@mmstack/mesh-protocol';
import { store, throttled } from '@mmstack/primitives/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  peerLinks,
  type DataChannelLike,
  type PeerConnector,
  type PeerLinks,
} from './peer-links';
import {
  presenceChannel,
  rtcPresence,
  type RtcPresenceRef,
} from './rtc-presence';
import { directTransport } from './transport';
import { webRtcMesh } from './webrtc-mesh';

// The receiver rules for ephemeral per-peer values, first as a pure model, then (below) the
// real `rtcPresence` driven by the same event generator. Order comes only from causality the
// receiver observes; no clocks, no numbers chosen by different senders compared:
//   1. a value is held only for an origin in the roster; a frame from anyone else is dropped,
//      and leaving the roster drops the held value at once;
//   2. within one link the highest seq wins and a frame at or below it is dropped: one counter
//      stamps every frame sent on that link in send order, so a lower seq was sent earlier;
//   3. the link is the epoch: a link that opens or closes starts its origin fresh, and a frame
//      of an old link cannot arrive on a new one (peer-links.spec.ts asserts that part);
//   4. the counter belongs to the links, not the sender: a sender closed and recreated on the
//      same links continues it, so its first frame is heard instead of refused as stale.

type Ev =
  | { readonly t: 'join'; readonly o: string }
  | { readonly t: 'gone'; readonly o: string }
  /** The receiver's link to `o` is replaced: a new tab or device, whose counter starts at 0. */
  | { readonly t: 'relink'; readonly o: string }
  /** The sender at `o` is closed and recreated on the same links; the counter carries on. */
  | { readonly t: 'recreate'; readonly o: string }
  | {
      readonly t: 'frame';
      readonly o: string;
      readonly seq: number;
      readonly value: string;
    };

type Model = {
  readonly roster: ReadonlySet<string>;
  readonly held: ReadonlyMap<string, string>;
  readonly mark: ReadonlyMap<string, number>;
};

const empty: Model = { roster: new Set(), held: new Map(), mark: new Map() };

const without = <K, V>(m: ReadonlyMap<K, V>, k: K): Map<K, V> => {
  const next = new Map(m);
  next.delete(k);
  return next;
};

/** The mistake kept to show the harness has teeth: a receiver that ignores the link boundary. */
type Variant = { readonly resetOnRelink?: boolean };

/** The receiver as a reducer. A recreate is invisible to it: only frames tell it anything. */
function reduce(m: Model, ev: Ev, v: Variant = {}): Model {
  switch (ev.t) {
    case 'join':
      return { ...m, roster: new Set(m.roster).add(ev.o) };
    case 'gone': {
      const roster = new Set(m.roster);
      roster.delete(ev.o);
      return {
        roster,
        held: without(m.held, ev.o),
        mark: without(m.mark, ev.o),
      };
    }
    case 'relink':
      return v.resetOnRelink === false
        ? m
        : {
            roster: m.roster,
            held: without(m.held, ev.o),
            mark: without(m.mark, ev.o),
          };
    case 'recreate':
      return m;
    case 'frame': {
      if (!m.roster.has(ev.o)) return m;
      const prev = m.mark.get(ev.o);
      if (prev !== undefined && ev.seq <= prev) return m;
      return {
        roster: m.roster,
        held: new Map(m.held).set(ev.o, ev.value),
        mark: new Map(m.mark).set(ev.o, ev.seq),
      };
    }
  }
}

const mulberry32 = (seed: number): (() => number) => {
  let a = (seed + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ORIGINS = ['a', 'b', 'c'] as const;
const SEEDS = 400;
const STEPS = 80;

function rosterSource(initial: readonly string[] = []) {
  let members = initial;
  const listeners = new Set<(members: readonly string[]) => void>();
  return {
    subscribe: (cb: (members: readonly string[]) => void) => {
      listeners.add(cb);
      cb(members);
      return () => {
        listeners.delete(cb);
      };
    },
    update: (fn: (members: readonly string[]) => readonly string[]) => {
      members = fn(members);
      for (const cb of [...listeners]) cb(members);
    },
    listeners,
  };
}

/**
 * The sender side, as the generator models it: one counter per origin's links. `restartOnRecreate`
 * is the mistake of a counter owned by the sender instance (what the design had before).
 */
type SenderVariant = { readonly restartOnRecreate?: boolean };

/**
 * A random interleaving: joins, leaves, relinks, sender recreates, and frames whose seq runs
 * ahead with jitter (lossy, unordered delivery within one link), from origins in and out of
 * the roster. The first frame after a relink or recreate is always a fresh one, so the
 * property "it is heard" is about the rules and not about jitter. Every frame value is unique,
 * so a held value names the frame it came from.
 */
function events(seed: number, sv: SenderVariant = {}, steps = STEPS): Ev[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const inRoster = new Set<string>();
  const next = new Map<string, number>(ORIGINS.map((o) => [o, 0]));
  const mustBeFresh = new Set<string>();
  const out: Ev[] = [];
  for (let i = 0; i < steps; i++) {
    const o = pick(ORIGINS);
    const r = rnd();
    if (r < 0.15) {
      if (inRoster.has(o)) {
        out.push({ t: 'gone', o });
        inRoster.delete(o);
      } else {
        out.push({ t: 'join', o });
        inRoster.add(o);
      }
    } else if (r < 0.22) {
      out.push({ t: 'relink', o });
      next.set(o, 0);
      mustBeFresh.add(o);
    } else if (r < 0.29) {
      out.push({ t: 'recreate', o });
      if (sv.restartOnRecreate) next.set(o, 0);
      mustBeFresh.add(o);
    } else {
      const n = next.get(o)!;
      const late = n > 0 && !mustBeFresh.has(o) && rnd() < 0.3;
      const seq = late ? n - 1 - Math.floor(rnd() * Math.min(n, 4)) : n;
      if (!late) next.set(o, n + 1);
      mustBeFresh.delete(o);
      out.push({ t: 'frame', o, seq, value: `${o}#${i}` });
    }
  }
  return out;
}

type Check = (step: number, ev: Ev, held: ReadonlyMap<string, string>) => void;

/**
 * The properties, checked against the reference trace of what happened (not against the
 * reducer). At every step: what is held is in the roster and is the highest-seq frame heard
 * from that origin since it last joined or was relinked. On top of that, stated directly: the
 * first frame after a relink, and after a recreate, is held.
 */
function properties(): Check {
  const roster = new Set<string>();
  const best = new Map<string, { seq: number; value: string }>();
  const awaited = new Set<string>();
  return (step, ev, held) => {
    const where = `step ${step} (${JSON.stringify(ev)})`;
    if (ev.t === 'join') {
      roster.add(ev.o);
    } else if (ev.t === 'gone') {
      roster.delete(ev.o);
      best.delete(ev.o);
    } else if (ev.t === 'relink') {
      best.delete(ev.o);
      awaited.add(ev.o);
    } else if (ev.t === 'recreate') {
      awaited.add(ev.o);
    } else if (roster.has(ev.o)) {
      const b = best.get(ev.o);
      if (!b || ev.seq > b.seq)
        best.set(ev.o, { seq: ev.seq, value: ev.value });
      if (awaited.delete(ev.o)) {
        expect(
          held.get(ev.o),
          `${where}: the first frame after a relink or recreate was dropped`,
        ).toBe(ev.value);
      }
    } else {
      awaited.delete(ev.o);
    }
    for (const o of held.keys()) {
      expect(roster.has(o), `${where}: ${o} held while out of the roster`).toBe(
        true,
      );
    }
    for (const o of roster) {
      expect(held.get(o), `${where}: ${o} holds the wrong frame`).toBe(
        best.get(o)?.value,
      );
    }
  };
}

function runModel(evs: readonly Ev[], v: Variant = {}): void {
  const check = properties();
  let m = empty;
  evs.forEach((ev, i) => {
    m = reduce(m, ev, v);
    check(i, ev, m.held);
  });
}

/** A new link whose counter starts at 0: without the reset every later frame is refused. */
const relinkCounterexample: readonly Ev[] = [
  { t: 'join', o: 'a' },
  { t: 'frame', o: 'a', seq: 0, value: 'a0' },
  { t: 'frame', o: 'a', seq: 1, value: 'a1' },
  { t: 'frame', o: 'a', seq: 2, value: 'a2' },
  { t: 'relink', o: 'a' },
  { t: 'frame', o: 'a', seq: 0, value: 'fresh0' },
  { t: 'frame', o: 'a', seq: 1, value: 'fresh1' },
  { t: 'frame', o: 'a', seq: 0, value: 'late-dup' },
];

/** A sender recreated on the same links carries the counter on, so it is heard at once. */
const recreateCounterexample: readonly Ev[] = [
  { t: 'join', o: 'a' },
  { t: 'frame', o: 'a', seq: 0, value: 'a0' },
  { t: 'frame', o: 'a', seq: 1, value: 'a1' },
  { t: 'recreate', o: 'a' },
  { t: 'frame', o: 'a', seq: 2, value: 'after' },
];

/**
 * The same trace with a counter owned by the sender instance: its seq is back at 0 while the
 * receiver holds 1, and no receiver rule can tell this from a late frame. That is why the
 * counter belongs to the links.
 */
const recreateRestartMistake: readonly Ev[] = [
  { t: 'join', o: 'a' },
  { t: 'frame', o: 'a', seq: 0, value: 'a0' },
  { t: 'frame', o: 'a', seq: 1, value: 'a1' },
  { t: 'recreate', o: 'a' },
  { t: 'frame', o: 'a', seq: 0, value: 'after' },
];

const failuresOf = (v: Variant, sv: SenderVariant = {}): number => {
  let failures = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    try {
      runModel(events(seed, sv), v);
    } catch {
      failures++;
    }
  }
  return failures;
};

describe('presence receiver model', () => {
  it(`holds the rules across ${SEEDS} seeds x ${STEPS} steps`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) runModel(events(seed));
  });

  it('the relink counterexample passes with the link as the epoch and fails without it', () => {
    expect(() => runModel(relinkCounterexample)).not.toThrow();
    expect(() =>
      runModel(relinkCounterexample, { resetOnRelink: false }),
    ).toThrow(/holds the wrong frame|first frame after a relink/);
  });

  it('a recreated sender is heard only because the counter belongs to the links', () => {
    expect(() => runModel(recreateCounterexample)).not.toThrow();
    expect(() => runModel(recreateRestartMistake)).toThrow(
      /first frame after a relink or recreate was dropped/,
    );
  });

  it('the random harness finds each mistake on its own (it has teeth)', () => {
    expect(failuresOf({ resetOnRelink: false })).toBeGreaterThan(0);
    expect(failuresOf({}, { restartOnRecreate: true })).toBeGreaterThan(0);
  });

  it('the generator covers every event kind, late frames and outsiders', () => {
    const all = Array.from({ length: SEEDS }, (_, i) => events(i + 1));
    const flat = all.flat();
    for (const t of ['join', 'gone', 'relink', 'recreate', 'frame'] as const) {
      expect(flat.some((e) => e.t === t)).toBe(true);
    }
    let outside = 0;
    let late = 0;
    for (const evs of all) {
      const roster = new Set<string>();
      const top = new Map<string, number>();
      for (const e of evs) {
        if (e.t === 'join') roster.add(e.o);
        else if (e.t === 'gone') roster.delete(e.o);
        else if (e.t === 'relink') top.delete(e.o);
        else if (e.t === 'frame') {
          if (!roster.has(e.o)) outside++;
          if (e.seq < (top.get(e.o) ?? -1)) late++;
          top.set(e.o, Math.max(top.get(e.o) ?? -1, e.seq));
        }
      }
    }
    expect(outside).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });
});

/**
 * An in-memory channel hub for peer links, derived from the `fakeHub()` in
 * `webrtc-mesh.spec.ts`: it pairs the two ends of a link by (local, remote) origin rather than
 * by call order, so rooms with more than two peers link correctly, and it gives every link one
 * half per requested channel label.
 */
function pairHub() {
  type Half = {
    channel: DataChannelLike;
    deliver(frame: string): void;
    fireOpen(): void;
    fireClose(): void;
    link(other: Half): void;
  };
  const parked = new Map<string, Record<string, Half>>();

  const makeHalf = (): Half => {
    const messageCbs = new Set<(f: string) => void>();
    const openCbs = new Set<() => void>();
    const closeCbs = new Set<() => void>();
    const buffered: string[] = [];
    const inbound: string[] = [];
    let remote: Half | null = null;
    let open = false;
    const half: Half = {
      channel: {
        send: (frame) => {
          if (open && remote) remote.deliver(frame);
          else buffered.push(frame);
        },
        onMessage: (cb) => {
          for (const frame of inbound.splice(0)) cb(frame);
          messageCbs.add(cb);
          return () => messageCbs.delete(cb);
        },
        onOpen: (cb) => {
          if (open) cb();
          openCbs.add(cb);
          return () => openCbs.delete(cb);
        },
        onClose: (cb) => (closeCbs.add(cb), () => closeCbs.delete(cb)),
        close: () => {
          if (!open) return;
          open = false;
          remote?.fireClose();
          half.fireClose();
        },
      },
      deliver: (frame) => {
        if (messageCbs.size === 0) inbound.push(frame);
        else for (const cb of [...messageCbs]) cb(frame);
      },
      fireOpen: () => {
        open = true;
        const frames = buffered.splice(0);
        for (const cb of [...openCbs]) cb();
        for (const frame of frames) remote?.deliver(frame);
      },
      fireClose: () => {
        open = false;
        for (const cb of [...closeCbs]) cb();
      },
      link: (other) => {
        remote = other;
      },
    };
    return half;
  };

  const connectorFor =
    (local: string): PeerConnector =>
    ({ remote, channels }) => {
      const key = `${local}|${remote}`;
      const mine: Record<string, Half> = {};
      for (const c of channels) mine[c.label] = makeHalf();
      const theirs = parked.get(`${remote}|${local}`);
      if (theirs) {
        parked.delete(`${remote}|${local}`);
        for (const c of channels) {
          mine[c.label].link(theirs[c.label]);
          theirs[c.label].link(mine[c.label]);
        }
        for (const c of channels) mine[c.label].fireOpen();
        for (const c of channels) theirs[c.label].fireOpen();
      } else {
        parked.set(key, mine);
      }
      const byLabel: Record<string, DataChannelLike> = {};
      for (const c of channels) byLabel[c.label] = mine[c.label].channel;
      return {
        channel: byLabel[channels[0].label],
        channels: byLabel,
        signal: () => undefined,
        close: () => {
          if (parked.get(key) === mine) parked.delete(key);
          for (const half of Object.values(mine)) half.channel.close();
        },
      };
    };

  return { connectorFor };
}

describe('rtcPresence over peer links', () => {
  const label = presenceChannel.label;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function node(
    relay: Relay,
    hub: ReturnType<typeof pairHub>,
    origin: string,
  ): PeerLinks {
    return TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'presence',
        origin,
        signaling: directTransport(relay, { writer: origin }),
        connector: hub.connectorFor(origin),
        channels: [presenceChannel],
      }),
    );
  }

  function presence<T>(
    links: PeerLinks,
    roster: () => readonly string[],
    throttleMs?: number,
  ): RtcPresenceRef<T> {
    return TestBed.runInInjectionContext(() =>
      rtcPresence<T>(links, {
        roster: rosterSource(roster()).subscribe,
        throttleMs,
      }),
    );
  }

  const publish = <T>(ref: RtcPresenceRef<T>, value: T): void => {
    ref.set(value);
    vi.advanceTimersByTime(40);
    TestBed.tick();
  };

  /**
   * The real receiver against the same generator. Fresh frames go through a real sender's
   * `set`, so the seq the wire carries is the sender's own; the harness asserts it is the one
   * the model expected, which is how the "counter belongs to the links" rule is checked on
   * the implementation. Late frames are replayed raw with an earlier seq.
   */
  async function runImpl(evs: readonly Ev[]): Promise<void> {
    const relay = createRelay();
    const hub = pairHub();
    const receiver = node(relay, hub, 'r');
    const senders = new Map(
      ORIGINS.map((o) => [o as string, node(relay, hub, o)]),
    );
    const roster = rosterSource();
    const p = TestBed.runInInjectionContext(() =>
      rtcPresence<string>(receiver, { roster: roster.subscribe }),
    );
    const onWire = new Map<string, { seq: number; value: string }>();
    receiver.onMessage((origin, frame, channel) => {
      if (channel === label) onWire.set(origin, JSON.parse(frame));
    });
    const current = new Map(
      [...senders].map(([o, l]) => [o, presence<string>(l, () => [])]),
    );
    // the generator's own count per origin: a frame at it is fresh, anything below is late
    const next = new Map<string, number>(ORIGINS.map((o) => [o, 0]));
    const check = properties();
    let m = empty;
    for (const [i, ev] of evs.entries()) {
      // Angular stays on its microtask scheduler after a tick until a microtask runs, and
      // counts notifications until then; a synchronous loop would never let one run
      await Promise.resolve();
      if (ev.t === 'join') roster.update((r) => [...r, ev.o]);
      else if (ev.t === 'gone')
        roster.update((r) => r.filter((o) => o !== ev.o));
      else if (ev.t === 'relink') {
        // a new tab: new links, so a new link at the receiver and a counter at 0
        current.get(ev.o)!.close();
        senders.get(ev.o)!.close();
        const links = node(relay, hub, ev.o);
        senders.set(ev.o, links);
        current.set(
          ev.o,
          presence<string>(links, () => []),
        );
        next.set(ev.o, 0);
      } else if (ev.t === 'recreate') {
        current.get(ev.o)!.close();
        current.set(
          ev.o,
          presence<string>(senders.get(ev.o)!, () => []),
        );
      } else if (ev.seq === next.get(ev.o)) {
        next.set(ev.o, ev.seq + 1);
        publish(current.get(ev.o)!, ev.value);
        expect(onWire.get(ev.o), `step ${i}: the sender's seq`).toEqual({
          seq: ev.seq,
          value: ev.value,
        });
      } else {
        senders
          .get(ev.o)!
          .send('r', JSON.stringify({ seq: ev.seq, value: ev.value }), label);
      }
      m = reduce(m, ev);
      const got = p.peers();
      check(i, ev, got);
      expect([...got].sort()).toEqual([...m.held].sort());
    }
    p.close();
    for (const ref of current.values()) ref.close();
    receiver.close();
    for (const s of senders.values()) s.close();
  }

  it(`the real receiver holds the rules across ${SEEDS} seeds x ${STEPS} steps`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runImpl(events(seed));
  });

  it('the real receiver passes the relink counterexample', async () => {
    await runImpl(relinkCounterexample);
  });

  it('the real receiver passes the recreate counterexample', async () => {
    await runImpl(recreateCounterexample);
  });

  it('consumes an external leave and rejoin without reads or a link change', () => {
    const relay = createRelay();
    const hub = pairHub();
    const receiver = node(relay, hub, 'r');
    const sender = node(relay, hub, 'a');
    const roster = rosterSource(['a']);
    const p = TestBed.runInInjectionContext(() =>
      rtcPresence<string>(receiver, { roster: roster.subscribe }),
    );
    const send = (seq: number, value: string) =>
      sender.send('r', JSON.stringify({ seq, value }), label);

    send(5, 'old');
    expect(p.peers().get('a')).toBe('old');
    roster.update(() => []);
    roster.update(() => ['a']);
    expect(receiver.peers()).toEqual(['a']);
    expect(p.peers().size).toBe(0);
    send(6, 'fresh');
    expect(p.peers().get('a')).toBe('fresh');

    // Membership changes are consumed even without a prior read of the held value.
    send(9, 'before-leave');
    roster.update(() => []);
    send(10, 'outside');
    roster.update(() => ['a']);
    send(11, 'after-rejoin');
    expect(p.peers().get('a')).toBe('after-rejoin');

    p.close();
    expect(roster.listeners.size).toBe(0);
  });

  it('uses relay membership notifications and unsubscribes on close', () => {
    const relay = createRelay();
    const hub = pairHub();
    const receiver = node(relay, hub, 'r');
    const first = node(relay, hub, 'a');
    const p = TestBed.runInInjectionContext(() =>
      rtcPresence<string>(receiver, { roster: receiver.onMembers }),
    );
    first.send('r', JSON.stringify({ seq: 5, value: 'old' }), label);
    expect(p.peers().get('a')).toBe('old');
    first.close();
    const second = node(relay, hub, 'a');
    expect(p.peers().size).toBe(0);
    second.send('r', JSON.stringify({ seq: 0, value: 'new' }), label);
    expect(p.peers().get('a')).toBe('new');
    receiver.close();
    expect(p.peers().size).toBe(0);
  });

  it('a sender recreated on the same links continues the count and is heard at once', () => {
    const relay = createRelay();
    const hub = pairHub();
    const rLinks = node(relay, hub, 'r');
    const seqs: number[] = [];
    rLinks.onMessage(
      (_, frame, channel) =>
        channel === label && seqs.push(JSON.parse(frame).seq),
    );
    const r = presence<string>(rLinks, () => ['a']);
    const links = node(relay, hub, 'a');
    const a1 = presence<string>(links, () => ['r']);
    for (const v of ['x1', 'x2', 'x3', 'x4']) publish(a1, v);
    expect(r.peers().get('a')).toBe('x4');

    // same links, same roster, no link change: nothing but the count tells the sender apart
    a1.close();
    const a2 = presence<string>(links, () => ['r']);
    publish(a2, 'fresh');
    expect(r.peers().get('a')).toBe('fresh');
    expect(seqs).toEqual([0, 1, 2, 3, 4]);

    // a late duplicate of an earlier frame on the same link changes nothing
    links.send('r', JSON.stringify({ seq: 2, value: 'late' }), label);
    expect(r.peers().get('a')).toBe('fresh');
  });

  it('a second seat with the same origin replaces the link and starts fresh', () => {
    const relay = createRelay();
    const hub = pairHub();
    const rLinks = node(relay, hub, 'r');
    const r = TestBed.runInInjectionContext(() =>
      rtcPresence<string>(rLinks, { roster: rLinks.onMembers }),
    );
    const b1 = node(relay, hub, 'b');
    b1.send('r', JSON.stringify({ seq: 7, value: 'first-tab' }), label);
    expect(r.peers().get('b')).toBe('first-tab');

    // the relay reports a takeover as a plain join; the link instance tells them apart
    const b2 = node(relay, hub, 'b');
    expect(rLinks.peers()).toEqual(['b']);
    expect(b2.peers()).toEqual(['r']);
    expect(b1.peers()).toEqual([]);
    expect(r.peers().size).toBe(0);
    b2.send('r', JSON.stringify({ seq: 0, value: 'second-tab' }), label);
    expect(r.peers().get('b')).toBe('second-tab');
    b1.send('r', JSON.stringify({ seq: 8, value: 'stale' }), label);
    expect(r.peers().get('b')).toBe('second-tab');
    b1.close();
    b2.close();
  });

  it('a leave and rejoin between two roster samples still starts the sender fresh', () => {
    const relay = createRelay();
    const hub = pairHub();
    const r = presence<string>(node(relay, hub, 'r'), () => ['a']);
    const first = node(relay, hub, 'a');
    const a1 = presence<string>(first, () => ['r']);
    for (const v of ['x1', 'x2', 'x3']) publish(a1, v);
    expect(r.peers().get('a')).toBe('x3');

    // the sender goes away and a fresh one takes its origin; nobody reads peers in between
    first.close();
    const a2 = presence<string>(node(relay, hub, 'a'), () => ['r']);
    publish(a2, 'fresh');
    expect(r.peers().get('a')).toBe('fresh');
  });

  it('throttles a burst: the first value goes out at once, the last one lands', () => {
    const relay = createRelay();
    const hub = pairHub();
    const rLinks = node(relay, hub, 'r');
    const frames: string[] = [];
    rLinks.onMessage(
      (_, frame, channel) => channel === label && frames.push(frame),
    );
    const r = presence<number>(rLinks, () => ['a']);
    const a = presence<number>(node(relay, hub, 'a'), () => ['r'], 50);

    for (let i = 1; i <= 10; i++) {
      a.set(i);
      vi.advanceTimersByTime(4);
      TestBed.tick();
    }
    expect(frames.length).toBeLessThan(10);
    expect(JSON.parse(frames[0]).value).toBe(1);
    vi.advanceTimersByTime(100);
    TestBed.tick();
    expect(r.peers().get('a')).toBe(10);
    expect(frames.map((f) => JSON.parse(f).value).at(-1)).toBe(10);
    expect(frames.map((f) => JSON.parse(f).seq)).toEqual(
      frames.map((_, i) => i),
    );
  });

  it('sends nothing to a new link until the next set', () => {
    const relay = createRelay();
    const hub = pairHub();
    const a = presence<string>(node(relay, hub, 'a'), () => ['r']);
    publish(a, 'before');
    const r = presence<string>(node(relay, hub, 'r'), () => ['a']);
    TestBed.tick();
    expect(r.peers().size).toBe(0);
    publish(a, 'after');
    expect(r.peers().get('a')).toBe('after');
  });

  it('close() stops sending and empties peers', () => {
    const relay = createRelay();
    const hub = pairHub();
    const r = presence<string>(node(relay, hub, 'r'), () => ['a', 'b']);
    const a = presence<string>(node(relay, hub, 'a'), () => ['r']);
    const b = presence<string>(node(relay, hub, 'b'), () => ['r']);
    publish(a, 'a1');
    publish(b, 'b1');
    expect(r.peers().size).toBe(2);

    a.close();
    publish(a, 'a2');
    expect(r.peers().get('a')).toBe('a1');

    r.close();
    expect(r.peers().size).toBe(0);
    publish(b, 'b2');
    expect(r.peers().size).toBe(0);
  });

  it('drops malformed frames and frames on other channels', () => {
    const relay = createRelay();
    const hub = pairHub();
    const r = presence<string>(node(relay, hub, 'r'), () => ['a']);
    const a = node(relay, hub, 'a');
    for (const junk of [
      'not json',
      'null',
      '{"seq":"1","value":"x"}',
      '{"seq":1}',
      '{"value":"x"}',
      '{"seq":null,"value":"x"}',
    ]) {
      a.send('r', junk, label);
    }
    expect(r.peers().size).toBe(0);
    a.send('r', JSON.stringify({ seq: 0, value: 'ok' }), label);
    expect(r.peers().get('a')).toBe('ok');
  });

  it('refuses links that do not carry its channel', () => {
    const relay = createRelay();
    const links = TestBed.runInInjectionContext(() =>
      peerLinks({
        room: 'presence',
        origin: 'x',
        signaling: directTransport(relay, { writer: 'x' }),
        connector: pairHub().connectorFor('x'),
      }),
    );
    expect(() => presence(links, () => [])).toThrow(/mmstack-presence/);
  });

  it('shares the links of a webRtcMesh: one peer connection carries both', () => {
    const relay = createRelay();
    const hub = pairHub();
    const peer = (writer: string) =>
      TestBed.runInInjectionContext(() => {
        const s = store<{ title: string }>({ title: 'init' });
        const mesh = webRtcMesh(s, {
          room: 'presence',
          writer,
          origin: writer,
          signaling: directTransport(relay, { writer }),
          connector: hub.connectorFor(writer),
          channels: [presenceChannel],
        });
        const pointers = rtcPresence<number>(mesh.links, {
          roster: mesh.links.onMembers,
        });
        return { s, mesh, pointers };
      });
    const a = peer('a');
    const b = peer('b');
    expect(a.mesh.links.channels).toEqual(['mmstack-mesh', label]);
    expect(a.mesh.origin).toBe('a');
    expect(a.mesh.peers()).toEqual(['b']);

    a.s.title.set('shared');
    TestBed.tick();
    expect(b.s().title).toBe('shared');
    publish(a.pointers, 42);
    expect(b.pointers.peers().get('a')).toBe(42);
    expect(b.s().title).toBe('shared');

    a.mesh.close();
    expect(b.pointers.peers().size).toBe(0);
    expect(b.mesh.peers()).toEqual([]);
  });
});

// A sender alone mints nothing: no frame, no sequence number, no timer. The gate is the set of
// links whose presence channel is open, which is exactly who `broadcast` reaches, so what any
// receiver sees is the same as with an unconditional sender. The stub below plays the links: it
// opens channels one at a time and records every delivery per channel, so the gate can be told
// apart from `links.peers()` (every channel open), which would withhold deliverable frames.
describe('rtcPresence alone', () => {
  const label = presenceChannel.label;
  const none = Symbol('none');

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function stubLinks(labels: readonly string[] = [label, 'other']) {
    const openCbs = new Set<(origin: string, channel: string) => void>();
    const closeCbs = new Set<(origin: string) => void>();
    const opened = new Map<string, Set<string>>();
    const delivered = new Map<string, string[]>();
    const stats = { mints: 0, reached: 0 };
    const links = {
      channels: labels,
      onOpen: (cb: (origin: string, channel: string) => void) => {
        openCbs.add(cb);
        for (const [origin, channels] of opened)
          for (const channel of channels) cb(origin, channel);
        return () => openCbs.delete(cb);
      },
      onClose: (cb: (origin: string) => void) => (
        closeCbs.add(cb),
        () => closeCbs.delete(cb)
      ),
      onEnd: () => () => undefined,
      onMessage: () => () => undefined,
      broadcast: (frame: string, channel = labels[0]) => {
        stats.mints++;
        let any = false;
        for (const [origin, channels] of opened) {
          if (!channels.has(channel)) continue;
          any = true;
          (
            delivered.get(origin) ?? delivered.set(origin, []).get(origin)!
          ).push(frame);
        }
        if (any) stats.reached++;
      },
    } as unknown as PeerLinks;
    return {
      links,
      delivered,
      stats,
      open: (origin: string, channel: string) => {
        (opened.get(origin) ?? opened.set(origin, new Set()).get(origin)!).add(
          channel,
        );
        for (const cb of [...openCbs]) cb(origin, channel);
      },
      close: (origin: string) => {
        opened.delete(origin);
        for (const cb of [...closeCbs]) cb(origin);
      },
    };
  }

  const values = (frames: readonly string[]): unknown[] =>
    frames.map((f) => (JSON.parse(f) as { value: unknown }).value);

  function sender<T>(
    links: PeerLinks,
    throttleMs = 33,
    injector: Injector = TestBed.inject(Injector),
  ): RtcPresenceRef<T> {
    return rtcPresence<T>(links, {
      roster: rosterSource([]).subscribe,
      throttleMs,
      injector,
    });
  }

  /**
   * The publisher as it was, every throttled value a frame whoever is there, behind the same
   * gate on `set`. Against the old publisher without that gate the deliveries are not equal,
   * and rightly so: it burnt throttle edges on nobody, which coalesced later real values away,
   * and it leaked a value set while alone to a link that opened inside the throttle window,
   * which the contract forbids. Both are pinned by their own cases; this oracle isolates the
   * publisher gate, whose only job is to skip frames nobody could receive.
   */
  function unconditionalSender<T>(
    links: PeerLinks,
    injector: Injector,
    throttleMs = 33,
  ): { set(value: T): void } {
    {
      const open = new Set<string>();
      links.onOpen((origin, channel) => {
        if (channel === label) open.add(origin);
      });
      links.onClose((origin) => open.delete(origin));
      let seq = 0;
      const outgoing = throttled<T | typeof none>(none, {
        ms: throttleMs,
        leading: true,
        trailing: true,
        destroyRef: injector.get(DestroyRef),
      });
      effect(
        () => {
          const value = outgoing();
          if (value === none) return;
          untracked(() =>
            links.broadcast(JSON.stringify({ seq: seq++, value }), label),
          );
        },
        { injector },
      );
      return {
        set: (value: T) => {
          if (open.size > 0) outgoing.set(value);
        },
      };
    }
  }

  it('costs no frame, no number and no timer while no link carries the channel', () => {
    const stub = stubLinks();
    const a = sender<number>(stub.links);
    for (let i = 0; i < 30; i++) {
      const timers = vi.getTimerCount();
      a.set(i);
      expect(vi.getTimerCount()).toBe(timers);
      vi.advanceTimersByTime(33);
      TestBed.tick();
    }
    expect(stub.stats.mints).toBe(0);

    stub.open('r', label);
    a.set(100);
    TestBed.tick();
    expect(values(stub.delivered.get('r')!)).toEqual([100]);
    expect(JSON.parse(stub.delivered.get('r')![0]!).seq).toBe(0);
  });

  it('goes out at once after solitude, and the count carries on across a close', () => {
    const stub = stubLinks();
    const a = sender<string>(stub.links);
    stub.open('r', label);
    a.set('one');
    TestBed.tick();
    stub.close('r');
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 10; i++) {
      a.set(`alone ${i}`);
      vi.advanceTimersByTime(33);
      TestBed.tick();
    }
    expect(stub.stats.mints).toBe(1);

    stub.open('r', label);
    a.set('two');
    TestBed.tick();
    const frames = stub.delivered.get('r')!;
    expect(values(frames)).toEqual(['one', 'two']);
    expect(frames.map((f) => (JSON.parse(f) as { seq: number }).seq)).toEqual([
      0, 1,
    ]);
  });

  it('mints nothing for a trailing value whose link closed inside the throttle window', () => {
    const stub = stubLinks();
    const a = sender<number>(stub.links, 50);
    stub.open('r', label);
    a.set(1);
    TestBed.tick();
    a.set(2);
    stub.close('r');
    vi.advanceTimersByTime(100);
    TestBed.tick();
    expect(stub.stats.mints).toBe(1);
    expect(values(stub.delivered.get('r')!)).toEqual([1]);
  });

  it('gates on the presence channel of a link, not on every channel being open', () => {
    const stub = stubLinks();
    const a = sender<number>(stub.links);
    stub.open('r', 'other');
    a.set(1);
    TestBed.tick();
    expect(stub.stats.mints).toBe(0);

    stub.open('s', label);
    a.set(2);
    TestBed.tick();
    expect(values(stub.delivered.get('s')!)).toEqual([2]);
    expect(stub.delivered.has('r')).toBe(false);
  });

  it('a link opening does not replay the value set while alone', () => {
    const stub = stubLinks();
    const a = sender<string>(stub.links);
    a.set('before');
    vi.advanceTimersByTime(100);
    TestBed.tick();
    stub.open('r', label);
    vi.advanceTimersByTime(100);
    TestBed.tick();
    expect(stub.stats.mints).toBe(0);
    a.set('after');
    TestBed.tick();
    expect(values(stub.delivered.get('r')!)).toEqual(['after']);
  });

  it('delivers exactly what an unconditional publisher delivers, over random link churn', async () => {
    const ORIGINS = ['a', 'b'];
    const CHANNELS = [label, 'other'];
    const GAPS = [5, 20, 40, 100];
    for (let seed = 0; seed < 200; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rnd() * xs.length)]!;
      const scope = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const gated = stubLinks();
      const plain = stubLinks();
      const a = sender<number>(gated.links, 33, scope);
      const o = unconditionalSender<number>(plain.links, scope);
      let value = 0;
      for (let step = 0; step < 60; step++) {
        // Angular counts notifications until a microtask runs after a tick (see runImpl)
        await Promise.resolve();
        const roll = rnd();
        if (roll < 0.45) {
          value++;
          a.set(value);
          o.set(value);
        } else if (roll < 0.65) {
          const origin = pick(ORIGINS);
          const channel = pick(CHANNELS);
          gated.open(origin, channel);
          plain.open(origin, channel);
        } else if (roll < 0.75) {
          const origin = pick(ORIGINS);
          gated.close(origin);
          plain.close(origin);
        } else {
          const ms = pick(GAPS);
          vi.advanceTimersByTime(ms);
        }
        TestBed.tick();
      }
      vi.advanceTimersByTime(200);
      TestBed.tick();
      for (const origin of ORIGINS) {
        expect(
          values(gated.delivered.get(origin) ?? []),
          `seed ${seed}, origin ${origin}`,
        ).toEqual(values(plain.delivered.get(origin) ?? []));
      }
      expect(gated.stats.mints, `seed ${seed} mints`).toBe(plain.stats.reached);
      expect(gated.stats.reached, `seed ${seed} reached`).toBe(
        gated.stats.mints,
      );
      scope.destroy();
    }
  });
});
