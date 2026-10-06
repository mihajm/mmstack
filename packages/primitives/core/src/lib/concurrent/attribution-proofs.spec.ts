/**
 * PURE MODEL + property proofs for transaction-attributed pending.
 *
 * Ground truth is a ledger of flights: each resource goes in flight (start), settles, or is aborted
 * and restarted (one flight ends, the next begins, its status never leaves loading). A transaction
 * start drops a marker. The ATTRIBUTED set at any moment is the set of resources whose current
 * flight started at or after the marker.
 *
 * Honest extent: this is "started since the checkpoint", not "caused by this writer". A flight
 * another writer starts after the marker is attributed too; only a synchronous slice can say who
 * started a flight.
 *
 * The attributor under proof reads a monotone flight counter (`loads`) per resource: attributed iff
 * loading AND (not in flight at the marker OR loads > loads at the marker). A counter is cumulative,
 * so a read that misses an intermediate state loses nothing. The killed alternative samples status
 * transitions (a pre-existing flight is excluded until a read sees it settled), which cannot see a
 * state that no read observed: an abort+restart, or a settle and refire between two reads.
 *
 * The model uses no Angular; the last describe blocks re-run the generators against the real
 * `createAttributedPending` and the slice claims.
 */
import {
  computed,
  type ResourceStatus,
  type Signal,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  claimLoads,
  createAttributedPending,
  createTransitionScope,
  releaseClaims,
  type ResourceLike,
  snapshotLoads,
} from './transition-scope';

export type Status = 'idle' | 'loading' | 'resolved';

/** What an attributor may read: status and (optionally) the counter, per resource. */
export type World = {
  readonly size: number;
  status(i: number): Status;
  loads(i: number): number | undefined;
};

export type Attributor = { attributed(): boolean[] };
export type AttributorFactory = (w: World) => Attributor;

const isLoading = (s: Status) => s === 'loading';

/**
 * The rule under proof. A resource without a counter keeps the transition sampler (best-effort:
 * a pre-existing flight is excluded until a read sees it settled).
 */
export const counterAttributor: AttributorFactory = (w) => {
  const loads0 = Array.from({ length: w.size }, (_, i) => w.loads(i));
  const pre = Array.from({ length: w.size }, (_, i) => isLoading(w.status(i)));
  const sampled = new Set(pre.flatMap((p, i) => (p ? [i] : [])));
  return {
    attributed: () =>
      Array.from({ length: w.size }, (_, i) => {
        const loading = isLoading(w.status(i));
        const l = w.loads(i);
        if (l === undefined) {
          if (sampled.has(i)) {
            if (!loading) sampled.delete(i);
            return false;
          }
          return loading;
        }
        if (!loading) return false;
        if (!pre[i]) return true;
        const l0 = loads0[i];
        return l0 !== undefined && l > l0;
      }),
  };
};

/** The killed alternative: today's transition sampler. */
export const samplerAttributor: AttributorFactory = (w) => {
  const pre = new Set(
    Array.from({ length: w.size }, (_, i) => i).filter((i) =>
      isLoading(w.status(i)),
    ),
  );
  return {
    attributed: () =>
      Array.from({ length: w.size }, (_, i) => {
        const loading = isLoading(w.status(i));
        if (pre.has(i)) {
          if (!loading) pre.delete(i);
          return false;
        }
        return loading;
      }),
  };
};

export const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export type Ev =
  | { readonly e: 'start' | 'settle' | 'restart'; readonly i: number }
  | { readonly e: 'mark' }
  | { readonly e: 'read' };

/** The ledger: the truth the attributor is checked against. */
export class FlightLedger implements World {
  readonly st: Status[];
  readonly count: number[];
  /** Logical time each resource's current flight started, or -1. */
  readonly startedAt: number[];
  marker = -1;
  time = 0;
  constructor(
    readonly size: number,
    initial: readonly Status[],
    readonly counted: boolean,
  ) {
    this.st = [...initial];
    this.count = initial.map((s) => (s === 'loading' ? 1 : 0));
    this.startedAt = initial.map((s) => (s === 'loading' ? 0 : -1));
    this.time = 1;
  }
  status(i: number) {
    return this.st[i];
  }
  loads(i: number) {
    return this.counted ? this.count[i] : undefined;
  }
  apply(ev: Ev) {
    const t = this.time++;
    if (ev.e === 'mark') this.marker = t;
    else if (ev.e === 'start' || ev.e === 'restart') {
      this.st[ev.i] = 'loading';
      this.count[ev.i]++;
      this.startedAt[ev.i] = t;
    } else if (ev.e === 'settle') {
      this.st[ev.i] = 'resolved';
      this.startedAt[ev.i] = -1;
    }
  }
  truth(): boolean[] {
    return this.startedAt.map(
      (s, i) => isLoading(this.st[i]) && this.marker >= 0 && s >= this.marker,
    );
  }
}

export type Trace = { readonly initial: Status[]; readonly events: Ev[] };

export function genAttributionTrace(
  seed: number,
  size = 3,
  length = 30,
): Trace {
  const r = mulberry32(seed);
  const initial: Status[] = Array.from({ length: size }, () =>
    r() < 0.5 ? 'loading' : r() < 0.5 ? 'resolved' : 'idle',
  );
  const st = [...initial];
  const events: Ev[] = [];
  const markAt = Math.floor(r() * (length / 3));
  for (let k = 0; k < length; k++) {
    if (k === markAt) {
      events.push({ e: 'mark' }, { e: 'read' });
      continue;
    }
    if (r() < 0.35) {
      events.push({ e: 'read' });
      continue;
    }
    const i = Math.floor(r() * size);
    if (st[i] === 'loading') {
      const e = r() < 0.5 ? 'settle' : 'restart';
      events.push({ e, i });
      if (e === 'settle') st[i] = 'resolved';
    } else {
      events.push({ e: 'start', i });
      st[i] = 'loading';
    }
  }
  events.push({ e: 'read' });
  return { initial, events };
}

/** Drives a trace against any implementation. `pending` is read only at `read` events. */
export type Env = {
  apply(ev: Exclude<Ev, { e: 'mark' | 'read' }>): void;
  mark(): void;
  /** Aggregate attributed pending, and per-resource when the implementation exposes it. */
  read(): { pending: boolean; each?: boolean[] };
};

export type Mismatch = {
  readonly at: number;
  readonly truth: boolean[];
  readonly got: boolean;
  readonly each?: boolean[];
};

export function runAttribution(
  trace: Trace,
  env: Env,
  ledger: FlightLedger,
): Mismatch[] {
  const out: Mismatch[] = [];
  trace.events.forEach((ev, at) => {
    ledger.apply(ev);
    if (ev.e === 'mark') return env.mark();
    if (ev.e !== 'read') return env.apply(ev);
    if (ledger.marker < 0) return;
    const truth = ledger.truth();
    const got = env.read();
    const sameEach = !got.each || got.each.every((b, i) => b === truth[i]);
    if (got.pending !== truth.some(Boolean) || !sameEach)
      out.push({ at, truth, got: got.pending, each: got.each });
  });
  return out;
}

/** A pure env: a mutable world the attributor reads directly. */
export function modelEnv(
  trace: Trace,
  make: AttributorFactory,
  counted: boolean,
): { env: Env; ledger: FlightLedger } {
  const world = new FlightLedger(trace.initial.length, trace.initial, counted);
  let att: Attributor | undefined;
  const env: Env = {
    apply: (ev) => world.apply(ev),
    mark: () => (att = make(world)),
    read: () => {
      const each = (att as Attributor).attributed();
      return { pending: each.some(Boolean), each };
    },
  };
  return {
    env,
    ledger: new FlightLedger(trace.initial.length, trace.initial, counted),
  };
}

/** Abort+restart: the transaction's write changes an in-flight request; status never leaves loading. */
export const ABORT_RESTART: Trace = {
  initial: ['loading'],
  events: [{ e: 'mark' }, { e: 'read' }, { e: 'restart', i: 0 }, { e: 'read' }],
};
/** Same-tick settle + refire: the settled state exists only between two reads. */
export const SETTLE_REFIRE: Trace = {
  initial: ['loading'],
  events: [
    { e: 'mark' },
    { e: 'read' },
    { e: 'settle', i: 0 },
    { e: 'start', i: 0 },
    { e: 'read' },
  ],
};
/** A pre-existing flight that settles is not the transaction's; a later start is. */
export const PREEXISTING_SETTLES: Trace = {
  initial: ['loading', 'resolved'],
  events: [
    { e: 'mark' },
    { e: 'read' },
    { e: 'start', i: 1 },
    { e: 'settle', i: 0 },
    { e: 'read' },
    { e: 'settle', i: 1 },
    { e: 'read' },
  ],
};

/** Runs every property and pin against an env factory, so the real function reuses them. */
export function defineAttributionProofs(
  makeEnv: (
    trace: Trace,
    counted: boolean,
  ) => { env: Env; ledger: FlightLedger },
  seeds: number,
) {
  it('counter rule: attributed == flights started at-or-after the marker, under generated interleavings', () => {
    let reads = 0;
    let restarts = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const trace = genAttributionTrace(seed);
      const { env, ledger } = makeEnv(trace, true);
      expect([seed, runAttribution(trace, env, ledger)]).toEqual([seed, []]);
      reads += trace.events.filter((e) => e.e === 'read').length;
      restarts += trace.events.filter((e) => e.e === 'restart').length;
    }
    expect(reads).toBeGreaterThan(seeds * 5);
    expect(restarts).toBeGreaterThan(seeds);
  });

  it('pinned: abort+restart is attributed', () => {
    const { env, ledger } = makeEnv(ABORT_RESTART, true);
    expect(runAttribution(ABORT_RESTART, env, ledger)).toEqual([]);
  });

  it('pinned: same-tick settle+refire is attributed', () => {
    const { env, ledger } = makeEnv(SETTLE_REFIRE, true);
    expect(runAttribution(SETTLE_REFIRE, env, ledger)).toEqual([]);
  });

  it('pinned: a pre-existing flight is excluded; a flight started after the marker counts', () => {
    const { env, ledger } = makeEnv(PREEXISTING_SETTLES, true);
    expect(runAttribution(PREEXISTING_SETTLES, env, ledger)).toEqual([]);
  });

  it('without a counter the sampler is best-effort: never attributes a pre-marker flight, may miss a restart', () => {
    let misses = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const trace = genAttributionTrace(seed);
      const { env, ledger } = makeEnv(trace, false);
      for (const m of runAttribution(trace, env, ledger)) {
        // a false negative, never a false positive
        if (m.each)
          m.each.forEach((b, i) => b && expect(m.truth[i]).toBe(true));
        else expect(m.got).toBe(false);
        misses++;
      }
    }
    expect(misses).toBeGreaterThan(0);
  });
}

describe('attribution model: counter rule', () => {
  defineAttributionProofs(
    (trace, counted) => modelEnv(trace, counterAttributor, counted),
    3000,
  );
});

describe('attribution model: the transition sampler is killed', () => {
  const sampler = (t: Trace) => modelEnv(t, samplerAttributor, true);
  it('fails abort+restart', () => {
    const { env, ledger } = sampler(ABORT_RESTART);
    expect(runAttribution(ABORT_RESTART, env, ledger)).toEqual([
      expect.objectContaining({ got: false }),
    ]);
  });
  it('fails same-tick settle+refire', () => {
    const { env, ledger } = sampler(SETTLE_REFIRE);
    expect(runAttribution(SETTLE_REFIRE, env, ledger)).toEqual([
      expect.objectContaining({ got: false }),
    ]);
  });
  it('fails under the generators', () => {
    let failing = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const trace = genAttributionTrace(seed);
      const { env, ledger } = sampler(trace);
      if (runAttribution(trace, env, ledger).length) failing++;
    }
    expect(failing).toBeGreaterThan(100);
  });
});

// ─── two overlapping transactions: flights started inside a slice are claimed ────────────

export type Owner = 'A' | 'B';
export type FlightOp = {
  readonly e: 'start' | 'restart' | 'settle';
  readonly i: number;
};
export type Ev2 =
  | FlightOp
  | { readonly e: 'mark'; readonly owner: Owner }
  | {
      readonly e: 'slice';
      readonly owner: Owner;
      readonly ops: readonly FlightOp[];
    }
  | { readonly e: 'read' };
export type Trace2 = { readonly initial: Status[]; readonly events: Ev2[] };

/** Drives two owners at once. */
export type Env2 = {
  apply(op: FlightOp): void;
  mark(owner: Owner): void;
  slice(owner: Owner, run: () => void): void;
  read(owner: Owner): boolean;
};

export function genTwoBodies(seed: number, size = 3, length = 36): Trace2 {
  const r = mulberry32(seed);
  const initial: Status[] = Array.from({ length: size }, () =>
    r() < 0.5 ? 'loading' : 'resolved',
  );
  const st = [...initial];
  const marked = new Set<Owner>();
  const events: Ev2[] = [];
  const op = (): FlightOp => {
    const i = Math.floor(r() * size);
    if (st[i] !== 'loading') {
      st[i] = 'loading';
      return { e: 'start', i };
    }
    if (r() < 0.5) {
      st[i] = 'resolved';
      return { e: 'settle', i };
    }
    return { e: 'restart', i };
  };
  for (let k = 0; k < length; k++) {
    const x = r();
    const unmarked = (['A', 'B'] as const).filter((o) => !marked.has(o));
    if (unmarked.length && (x < 0.12 || marked.size === 0)) {
      const owner = unmarked[Math.floor(r() * unmarked.length)];
      marked.add(owner);
      events.push({ e: 'mark', owner });
    } else if (x < 0.45 && marked.size) {
      const owners = [...marked];
      const owner = owners[Math.floor(r() * owners.length)];
      const ops = Array.from({ length: 1 + Math.floor(r() * 2) }, () => {
        const o = op();
        return o.e === 'settle' ? { e: 'restart' as const, i: o.i } : o; // a slice starts work
      });
      ops.forEach((o) => (st[o.i] = 'loading'));
      events.push({ e: 'slice', owner, ops });
    } else if (x < 0.7) {
      events.push(op());
    } else {
      events.push({ e: 'read' });
    }
  }
  events.push({ e: 'read' });
  return { initial, events };
}

/** Truth: a flight is X's iff started in X's slice, or outside any slice at-or-after X's mark. */
export function runTwoBodies(trace: Trace2, env: Env2): string[] {
  const size = trace.initial.length;
  const loading = trace.initial.map((s) => s === 'loading');
  const startedAt = trace.initial.map(() => 0);
  const startedBy: (Owner | undefined)[] = trace.initial.map(() => undefined);
  const markAt = new Map<Owner, number>();
  const out: string[] = [];
  let time = 1;
  const doOp = (o: FlightOp, by: Owner | undefined) => {
    env.apply(o);
    if (o.e === 'settle') loading[o.i] = false;
    else {
      loading[o.i] = true;
      startedAt[o.i] = time;
      startedBy[o.i] = by;
    }
  };
  trace.events.forEach((ev, at) => {
    time++;
    if (ev.e === 'mark') {
      markAt.set(ev.owner, time);
      env.mark(ev.owner);
    } else if (ev.e === 'slice')
      env.slice(ev.owner, () => ev.ops.forEach((o) => doOp(o, ev.owner)));
    else if (ev.e === 'read') {
      for (const [owner, m] of markAt) {
        let truth = false;
        for (let i = 0; i < size; i++) {
          if (!loading[i]) continue;
          const by = startedBy[i];
          if (by === owner || (by === undefined && startedAt[i] >= m))
            truth = true;
        }
        const got = env.read(owner);
        if (got !== truth)
          out.push(`event ${at}: ${owner} got ${got}, truth ${truth}`);
      }
    } else doOp(ev, undefined);
  });
  return out;
}

/** The claims rule as a pure function over a world with counters. */
export function claimsEnv(trace: Trace2, useClaims: boolean): Env2 {
  const world = new FlightLedger(trace.initial.length, trace.initial, true);
  const claims = new Map<number, Map<number, Owner>>();
  const marks = new Map<Owner, { loads0: number[]; pre: boolean[] }>();
  const snap = () =>
    Array.from({ length: world.size }, (_, i) => world.count[i]);
  return {
    apply: (op) => world.apply(op),
    mark: (owner) =>
      marks.set(owner, {
        loads0: snap(),
        pre: world.st.map((s) => s === 'loading'),
      }),
    slice: (owner, run) => {
      const before = snap();
      run();
      if (!useClaims) return;
      snap().forEach((after, i) => {
        const byCount = claims.get(i) ?? new Map<number, Owner>();
        claims.set(i, byCount);
        for (let n = before[i] + 1; n <= after; n++)
          if (!byCount.has(n)) byCount.set(n, owner);
      });
    },
    read: (owner) => {
      const m = marks.get(owner) as { loads0: number[]; pre: boolean[] };
      return world.st.some((s, i) => {
        if (s !== 'loading') return false;
        const claimedBy = claims.get(i)?.get(world.count[i]);
        if (claimedBy !== undefined) return claimedBy === owner;
        return !m.pre[i] || world.count[i] > m.loads0[i];
      });
    },
  };
}

/** A's slice starts a flight while B is open: it is A's, never B's. */
export const KICKOFF_IN_A_SLICE: Trace2 = {
  initial: ['resolved'],
  events: [
    { e: 'mark', owner: 'B' },
    { e: 'mark', owner: 'A' },
    { e: 'slice', owner: 'A', ops: [{ e: 'start', i: 0 }] },
    { e: 'read' },
  ],
};

export function defineClaimProofs(make: (t: Trace2) => Env2, seeds: number) {
  it('pinned: a kickoff inside A slice is attributed to A and not to B', () => {
    expect(runTwoBodies(KICKOFF_IN_A_SLICE, make(KICKOFF_IN_A_SLICE))).toEqual(
      [],
    );
  });
  it('two overlapping bodies: slice flights are exact, outside flights are window-attributed', () => {
    let slices = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const t = genTwoBodies(seed);
      expect([seed, runTwoBodies(t, make(t))]).toEqual([seed, []]);
      slices += t.events.filter((e) => e.e === 'slice').length;
    }
    expect(slices).toBeGreaterThan(seeds * 3);
  });
}

describe('attribution model: claims under two overlapping transactions', () => {
  defineClaimProofs((t) => claimsEnv(t, true), 3000);

  it('killed: window-only gives B the flight A started', () => {
    expect(
      runTwoBodies(KICKOFF_IN_A_SLICE, claimsEnv(KICKOFF_IN_A_SLICE, false)),
    ).toEqual([expect.stringContaining('B got true, truth false')]);
    let failing = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const t = genTwoBodies(seed);
      if (runTwoBodies(t, claimsEnv(t, false)).length) failing++;
    }
    expect(failing).toBeGreaterThan(100);
  });
});

// ─── the same generators against the real createAttributedPending ───────────────────────

type FakeRes = ResourceLike & {
  readonly st: WritableSignal<ResourceStatus>;
  readonly count?: WritableSignal<number>;
};

function realWorld(initial: readonly Status[], counted: boolean) {
  const scope = TestBed.runInInjectionContext(() => createTransitionScope());
  const refs: FakeRes[] = initial.map((s) => {
    const st = signal<ResourceStatus>(s);
    const count = counted ? signal(s === 'loading' ? 1 : 0) : undefined;
    return {
      st,
      count,
      status: st,
      isLoading: computed(() => st() === 'loading'),
      hasValue: () => true,
      ...(count ? { loads: count.asReadonly() } : {}),
    };
  });
  for (const r of refs) scope.add(r, { suspends: false });
  const apply = (op: FlightOp) => {
    const r = refs[op.i];
    if (op.e === 'settle') return r.st.set('resolved');
    r.st.set('loading');
    r.count?.update((n) => n + 1);
  };
  return { scope, apply };
}

describe('real createAttributedPending: single transaction', () => {
  defineAttributionProofs((trace, counted) => {
    const { scope, apply } = realWorld(trace.initial, counted);
    let pending: Signal<boolean> | undefined;
    const env: Env = {
      apply: (ev) => apply(ev as FlightOp),
      mark: () => (pending = createAttributedPending(scope)),
      read: () => ({ pending: (pending as Signal<boolean>)() }),
    };
    return {
      env,
      ledger: new FlightLedger(trace.initial.length, trace.initial, counted),
    };
  }, 1000);

  it('killed on the real function too: without loads the July pins stay excluded', () => {
    for (const t of [ABORT_RESTART, SETTLE_REFIRE]) {
      const { scope, apply } = realWorld(t.initial, false);
      let pending: Signal<boolean> | undefined;
      const env: Env = {
        apply: (ev) => apply(ev as FlightOp),
        mark: () => (pending = createAttributedPending(scope)),
        read: () => ({ pending: (pending as Signal<boolean>)() }),
      };
      const ledger = new FlightLedger(t.initial.length, t.initial, false);
      expect(runAttribution(t, env, ledger)).toEqual([
        expect.objectContaining({ got: false }),
      ]);
    }
  });
});

describe('real claims: two overlapping transactions', () => {
  const realEnv = (t: Trace2): Env2 => {
    const { scope, apply } = realWorld(t.initial, true);
    const owners = { A: {}, B: {} };
    const pending = new Map<Owner, Signal<boolean>>();
    return {
      apply,
      mark: (o) => pending.set(o, createAttributedPending(scope, owners[o])),
      slice: (o, run) => {
        const before = snapshotLoads(scope);
        run();
        claimLoads(scope, owners[o], before);
      },
      read: (o) => (pending.get(o) as Signal<boolean>)(),
    };
  };
  defineClaimProofs(realEnv, 1000);

  it('settled claims: once A settles, its in-flight load stays unadopted by B; the next start is B-window again', () => {
    const { scope, apply } = realWorld(['resolved'], true);
    const a = {};
    const b = {};
    const pb = createAttributedPending(scope, b);
    const before = snapshotLoads(scope);
    apply({ e: 'start', i: 0 });
    claimLoads(scope, a, before);
    expect(pb()).toBe(false);
    releaseClaims(scope, a);
    expect(pb()).toBe(false); // A's load keeps a settled owner; B's window does not adopt it
    apply({ e: 'settle', i: 0 });
    apply({ e: 'start', i: 0 });
    expect(pb()).toBe(true); // a fresh start after B's checkpoint, claimed by nobody
  });
});
