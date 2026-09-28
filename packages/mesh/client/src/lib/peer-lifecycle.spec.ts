import { describe, expect, it } from 'vitest';
import {
  closedLifecycle,
  emptyLifecycle,
  retryDelay,
  step,
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleStep,
} from './peer-lifecycle';
import { prng, type Prng } from './sim/prng';

// The reducer is checked against the world its effects build: a set of peers and one timer
// slot per origin, changed only by executing effects in order. The generator picks events
// from the reducer's own state, as `peerLinks` would see them; the stale reports a timer or a
// duplicate callback can deliver are probed at every step without being applied.

const ORIGINS = ['a', 'b', 'c'] as const;
const SEEDS = 250;
const STEPS = 80;

type Reducer = (s: Lifecycle, e: LifecycleEvent) => LifecycleStep;

type World = {
  readonly peers: Set<string>;
  readonly timers: Map<string, 'open' | 'retry'>;
  listed: Set<string>;
  closed: boolean;
};

const apply = (w: World, effects: readonly LifecycleEffect[]): void => {
  for (const f of effects) {
    switch (f.t) {
      case 'build':
        if (w.peers.has(f.origin))
          throw new Error(`second build for ${f.origin}`);
        w.peers.add(f.origin);
        break;
      case 'drop':
        if (!w.peers.has(f.origin))
          throw new Error(`drop without a peer: ${f.origin}`);
        w.peers.delete(f.origin);
        break;
      case 'armOpen':
        w.timers.set(f.origin, 'open');
        break;
      case 'armRetry':
        w.timers.set(f.origin, 'retry');
        break;
      case 'disarm':
        w.timers.delete(f.origin);
        break;
    }
  }
};

const fail = (msg: string): never => {
  throw new Error(msg);
};

/** Stale reports that must change nothing: I4. */
type Probe = Extract<LifecycleEvent, { t: 'opened' | 'lost' | 'due' }>;

const probes = (s: Lifecycle): Probe[] => {
  const out: Probe[] = [];
  for (const origin of ORIGINS) {
    const st = s.get(origin)?.state;
    if (st === 'open') out.push({ t: 'opened', origin });
    if (st === 'waiting' || st === undefined) out.push({ t: 'lost', origin });
    if (st !== 'waiting') out.push({ t: 'due', origin });
    if (st !== 'linking') out.push({ t: 'opened', origin });
  }
  return out;
};

function checkStep(
  reduce: Reducer,
  w: World,
  s: Lifecycle,
  e: LifecycleEvent,
  r: LifecycleStep,
): void {
  const before = { peers: new Set(w.peers), timers: new Map(w.timers) };
  const wasListed = new Set(w.listed);
  if (w.closed) {
    if (r.effects.length) fail(`I3: effects after close for ${e.t}`);
    return;
  }
  apply(w, r.effects);
  const s2 = r.next;

  if (e.t === 'close') {
    // I3
    if (s2.size !== 0) fail('I3: state left after close');
    const drops = r.effects.filter((f) => f.t === 'drop').length;
    const disarms = r.effects.filter((f) => f.t === 'disarm').length;
    if (drops !== before.peers.size || disarms !== before.timers.size)
      fail(
        'I3: close must drop every peer and disarm every timer exactly once',
      );
    if (r.effects.length !== drops + disarms)
      fail('I3: close emitted a build or arm');
    if (w.peers.size || w.timers.size) fail('I3: world not empty after close');
    w.closed = true;
    return;
  }

  if (e.t === 'welcome') w.listed = new Set(e.members);
  else if (e.t === 'listed') w.listed.add(e.origin);
  else if (e.t === 'gone') w.listed.delete(e.origin);

  for (const origin of ORIGINS) {
    const cur = s2.get(origin);
    const peer = w.peers.has(origin);
    const timer = w.timers.get(origin);
    if (w.listed.has(origin)) {
      // I1
      if (!cur) fail(`I1: listed ${origin} has no state`);
      else if (cur.state === 'linking' && !(peer && timer === 'open'))
        fail(`I1: linking ${origin} needs a peer and an open timer`);
      else if (cur.state === 'open' && !(peer && timer === undefined))
        fail(`I1: open ${origin} needs a peer and no timer`);
      else if (cur.state === 'waiting' && !(!peer && timer === 'retry'))
        fail(`I1: waiting ${origin} needs no peer and a retry timer`);
    } else {
      // I2
      if (cur || peer || timer) fail(`I2: unlisted ${origin} still has state`);
      if (wasListed.has(origin)) {
        const mine = r.effects.filter((f) => f.origin === origin);
        if (before.peers.has(origin) && !mine.some((f) => f.t === 'drop'))
          fail(`I2: unlisting ${origin} did not drop its peer`);
        if (!mine.some((f) => f.t === 'disarm'))
          fail(`I2: unlisting ${origin} did not disarm`);
      }
    }
    if (cur) {
      // I6
      const prev = s.get(origin);
      if (cur.state === 'open' && cur.attempt !== 0)
        fail(`I6: open ${origin} with attempt`);
      const lostHere =
        e.t === 'lost' &&
        e.origin === origin &&
        prev &&
        prev.state !== 'waiting';
      if (lostHere && cur.attempt !== prev.attempt + 1)
        fail(`I6: lost must add exactly one attempt for ${origin}`);
      if (
        !lostHere &&
        prev &&
        cur.state !== 'open' &&
        cur.attempt !== prev.attempt
      )
        fail(`I6: attempt of ${origin} moved without a loss`);
      if (cur.stalled !== (cur.attempt > 0 || cur.state === 'waiting'))
        fail(`I6: stalled of ${origin} disagrees with attempt/state`);
    }
  }

  if (e.t === 'welcome') {
    // I7
    const builds = r.effects
      .filter((f) => f.t === 'build')
      .map((f) => f.origin);
    const want = e.members.filter((o) => !before.peers.has(o));
    if ([...builds].sort().join() !== [...new Set(want)].sort().join())
      fail('I7: welcome must build exactly the listed origins without a peer');
    for (const o of want)
      if (
        before.timers.get(o) === 'retry' &&
        !r.effects.some((f) => f.t === 'disarm' && f.origin === o)
      )
        fail(`I7: welcome did not cancel the retry of ${o}`);
  }

  // I4
  for (const p of probes(s2)) {
    const got = reduce(s2, p);
    if (got.effects.length || got.next !== s2)
      fail(
        `I4: stale ${p.t} on ${p.origin} (${s2.get(p.origin)?.state ?? 'unlisted'}) was not a no-op`,
      );
  }
}

function nextEvent(
  r: Prng,
  s: Lifecycle,
  i: number,
  closed: boolean,
): LifecycleEvent {
  if (!closed && i >= STEPS - 6 && r.bool(0.15)) return { t: 'close' };
  const origin = r.pick(ORIGINS);
  const st = s.get(origin)?.state;
  const roll = r.int(100);
  if (roll < 12) return { t: 'listed', origin };
  if (roll < 20) return { t: 'gone', origin };
  if (roll < 28)
    return { t: 'welcome', members: ORIGINS.filter(() => r.bool(0.6)) };
  if (st === 'linking' && roll < 55) return { t: 'opened', origin };
  if ((st === 'linking' || st === 'open') && roll < 85)
    return { t: 'lost', origin };
  if (st === 'waiting') return { t: 'due', origin };
  return { t: 'listed', origin };
}

/** Runs one seed; throws with the seed and step on the first broken rule. */
function run(seed: number, reduce: Reducer = step): LifecycleEvent[] {
  const r = prng(seed);
  const w: World = {
    peers: new Set(),
    timers: new Map(),
    listed: new Set(),
    closed: false,
  };
  let s: Lifecycle = emptyLifecycle;
  const seen: LifecycleEvent[] = [];
  for (let i = 0; i < STEPS; i++) {
    const e =
      w.closed && r.bool(0.5)
        ? { t: 'listed' as const, origin: 'a' }
        : nextEvent(r, s, i, w.closed);
    seen.push(e);
    const res = reduce(s, e);
    try {
      checkStep(reduce, w, s, e, res);
    } catch (err) {
      throw new Error(
        `seed ${seed} step ${i} (${JSON.stringify(e)}): ${(err as Error).message}`,
        { cause: err },
      );
    }
    s = res.next;
  }
  return seen;
}

/** How many seeds a reducer fails, and the rule named by the first failure. */
const failuresOf = (reduce: Reducer): { count: number; first: string } => {
  let count = 0;
  let first = '';
  for (let seed = 1; seed <= SEEDS; seed++) {
    try {
      run(seed, reduce);
    } catch (err) {
      if (!count) first = (err as Error).message;
      count++;
    }
  }
  return { count, first };
};

// The mistakes kept to show the harness has teeth, each a copy of the reducer with one rule
// taken out.
const skipRetryOnLost: Reducer = (s, e) => {
  const r = step(s, e);
  return e.t === 'lost'
    ? { ...r, effects: r.effects.filter((f) => f.t !== 'armRetry') }
    : r;
};
const keepTimerOnGone: Reducer = (s, e) => {
  const r = step(s, e);
  return e.t === 'gone'
    ? { ...r, effects: r.effects.filter((f) => f.t !== 'disarm') }
    : r;
};
const dueBuildsOverPeer: Reducer = (s, e) => {
  const st = e.t === 'due' ? s.get(e.origin)?.state : undefined;
  if (e.t === 'due' && (st === 'linking' || st === 'open')) {
    return {
      next: s,
      effects: [
        { t: 'armOpen', origin: e.origin },
        { t: 'build', origin: e.origin },
      ],
    };
  }
  return step(s, e);
};

describe('peer link lifecycle (pure)', () => {
  it(`I1-I4, I6, I7 hold across ${SEEDS} seeds x ${STEPS} steps over ${ORIGINS.length} origins`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) run(seed);
  });

  it('the generator covers every event kind, a close, and events after it', () => {
    const all = Array.from({ length: SEEDS }, (_, i) => run(i + 1));
    const flat = all.flat();
    for (const t of [
      'listed',
      'welcome',
      'gone',
      'opened',
      'lost',
      'due',
      'close',
    ] as const) {
      expect(flat.some((e) => e.t === t)).toBe(true);
    }
    const afterClose = all.filter((evs) => {
      const i = evs.findIndex((e) => e.t === 'close');
      return i >= 0 && i < evs.length - 1;
    });
    expect(afterClose.length).toBeGreaterThan(0);
    // a loss that is followed by a rebuild and a second loss before any open: backoff grows
    let deep = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      let s: Lifecycle = emptyLifecycle;
      for (const e of all[seed - 1]) {
        s = step(s, e).next;
        for (const v of s.values()) if (v.attempt >= 2) deep++;
      }
    }
    expect(deep).toBeGreaterThan(0);
  });

  it('I5: retryDelay lies in [base/2, base), base doubles to maxMs and stays there', () => {
    const bounds = { minMs: 1000, maxMs: 30000 };
    const r = prng(7);
    let lastBase = 0;
    for (let attempt = 0; attempt < 64; attempt++) {
      // the floor is half the base, so the impl's own floor tells the base
      const base = 2 * retryDelay(attempt, bounds, () => 0);
      expect(base).toBe(Math.min(1000 * 2 ** attempt, 30000));
      expect(base).toBeGreaterThanOrEqual(lastBase);
      lastBase = base;
      // the seeded source's largest draw is 1 - 2^-32; Math.random's last ulp below 1 may
      // round the sum to exactly `base`, which is still inside the bound the rate proof uses
      for (const x of [0, 0.5, 1 - 2 ** -32, r.float(), r.float()]) {
        const d = retryDelay(attempt, bounds, () => x);
        expect(d).toBeGreaterThanOrEqual(base / 2);
        expect(d).toBeLessThan(base);
      }
      expect(
        retryDelay(attempt, bounds, () => 1 - 2 ** -53),
      ).toBeLessThanOrEqual(base);
    }
    expect(retryDelay(5, bounds, () => 0)).toBe(15000);
    expect(retryDelay(1000, bounds, () => 0)).toBe(15000);
    expect(retryDelay(0, bounds, () => 0)).toBe(500);
    expect(retryDelay(4, bounds, () => 0)).toBe(8000);
  });

  it('I5: across any 300 000 ms after the fifth attempt there are at most 21 attempts', () => {
    const bounds = { minMs: 1000, maxMs: 30000 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = prng(seed);
      // attempt times: the delays alone, the fastest a pair can retry (a link that fails
      // instantly); a window starting anywhere after the fifth attempt
      const times: number[] = [];
      let t = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        t += retryDelay(attempt, bounds, r.float);
        times.push(t);
      }
      for (let i = 5; i < times.length; i++) {
        const inWindow = times.filter(
          (x) => x >= times[i] && x < times[i] + 300_000,
        );
        expect(inWindow.length).toBeLessThanOrEqual(21);
      }
    }
  });

  it('after close every event is ignored', () => {
    let s: Lifecycle = step(emptyLifecycle, {
      t: 'welcome',
      members: ['a', 'b'],
    }).next;
    s = step(s, { t: 'lost', origin: 'a' }).next;
    const closed = step(s, { t: 'close' });
    expect(closed.next).toBe(closedLifecycle);
    expect(closed.effects).toEqual([
      { t: 'disarm', origin: 'a' },
      { t: 'drop', origin: 'b' },
      { t: 'disarm', origin: 'b' },
    ]);
    for (const e of [
      { t: 'listed', origin: 'a' },
      { t: 'welcome', members: ['a'] },
      { t: 'due', origin: 'a' },
      { t: 'close' },
    ] as const) {
      expect(step(closedLifecycle, e)).toEqual({
        next: closedLifecycle,
        effects: [],
      });
    }
  });

  it('a loss arms a retry from the attempt before it; an open starts the count again', () => {
    let s: Lifecycle = step(emptyLifecycle, { t: 'listed', origin: 'a' }).next;
    let r = step(s, { t: 'lost', origin: 'a' });
    expect(r.effects).toEqual([
      { t: 'drop', origin: 'a' },
      { t: 'armRetry', origin: 'a', attempt: 0 },
    ]);
    s = step(r.next, { t: 'due', origin: 'a' }).next;
    r = step(s, { t: 'lost', origin: 'a' });
    expect(r.effects[1]).toEqual({ t: 'armRetry', origin: 'a', attempt: 1 });
    s = step(r.next, { t: 'due', origin: 'a' }).next;
    expect(s.get('a')).toEqual({ state: 'linking', attempt: 2, stalled: true });
    s = step(s, { t: 'opened', origin: 'a' }).next;
    expect(s.get('a')).toEqual({ state: 'open', attempt: 0, stalled: false });
    r = step(s, { t: 'lost', origin: 'a' });
    expect(r.effects[1]).toEqual({ t: 'armRetry', origin: 'a', attempt: 0 });
  });

  it('a join or a welcome while waiting cancels the retry and builds now, keeping the count', () => {
    let s: Lifecycle = step(emptyLifecycle, { t: 'listed', origin: 'a' }).next;
    s = step(s, { t: 'lost', origin: 'a' }).next;
    for (const e of [
      { t: 'listed', origin: 'a' },
      { t: 'welcome', members: ['a'] },
    ] as const) {
      const r = step(s, e);
      expect(r.effects).toEqual([
        { t: 'disarm', origin: 'a' },
        { t: 'armOpen', origin: 'a' },
        { t: 'build', origin: 'a' },
      ]);
      expect(r.next.get('a')).toEqual({
        state: 'linking',
        attempt: 1,
        stalled: true,
      });
    }
  });

  it('the reducer itself fails no seed', () => {
    expect(failuresOf(step)).toEqual({ count: 0, first: '' });
  });

  it('teeth: a loss that arms no retry is caught (I1)', () => {
    const got = failuresOf(skipRetryOnLost);
    expect(got.count).toBeGreaterThan(0);
    expect(got.first).toMatch(/I1: waiting \w needs no peer and a retry timer/);
  });

  it('teeth: a gone that leaves the timer armed is caught (I2)', () => {
    const got = failuresOf(keepTimerOnGone);
    expect(got.count).toBeGreaterThan(0);
    expect(got.first).toMatch(/I2: /);
  });

  it('teeth: a due that builds over an existing peer is caught (I4)', () => {
    const got = failuresOf(dueBuildsOverPeer);
    expect(got.count).toBeGreaterThan(0);
    expect(got.first).toMatch(/I4: stale due/);
  });
});
