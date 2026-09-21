import {
  createRegisterStore,
  MESH_PROTO_VERSION,
  type Dot,
  type Hlc,
  type Key,
  type OpEnvelope,
  type SyncOp,
} from '@mmstack/mesh-protocol';
import { createConvergingApply } from '@mmstack/primitives/core';
import { describe, expect, it } from 'vitest';
// The twin proof lives here because it needs both halves: the relay's register store and the
// client fold. The protocol package stays dependency-free.

// ─────────────────────────────────────────────────────────────────────────────
// Compaction proof — "garbage collection may remove representation, but must preserve every
// distinction that a future valid operation can observe" (`_mesh-frontier-design.md` §0).
//
// Subjects are the REAL relay register store and the REAL client fold. Each replica runs as a
// twin: U never collects garbage, C collects with the candidate rule at random points. Both
// receive the same envelopes, per-origin FIFO, arbitrary interleaving across origins (no
// cross-origin causal delivery), with duplicates and snapshot round trips. Observations are
// compared after every step: materialization, the stamp a future op would get (cites + epoch),
// the relay's admission answers (`covers` modulo the settled exemption, `maxEpoch`), and what a
// joiner seeded from each checkpoint materializes.
//
// Teeth: the same harness is run with an over-eager collection (every origin taken as settled at
// every stamp), which is the old frontier rule's mistake in one line; it must be observable.
// ─────────────────────────────────────────────────────────────────────────────

type Fold = ReturnType<typeof createConvergingApply>;
type Store = ReturnType<typeof createRegisterStore>;

const compareHlc = (a: Hlc, b: Hlc): number => (a.p !== b.p ? a.p - b.p : a.l - b.l);

const env = (
  origin: string,
  version: number,
  hlc: Hlc,
  ops: readonly SyncOp[],
): OpEnvelope => ({
  proto: MESH_PROTO_VERSION,
  instance: 'g',
  policyVersion: 0,
  origin,
  writer: origin,
  version,
  hlc,
  ops,
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

// ─── pinned counterexamples against the old rule ─────────────────────────────

describe('compaction proof: pinned', () => {
  it("Miha's schedule: B clears x citing A; a replica folds B, collects too eagerly, then A arrives — x resurrects", () => {
    const aDot: Dot = { origin: 'A', hlc: { p: 10, l: 0 } };
    const A = env('A', 1, aDot.hlc, [{ kind: 'set', path: ['x'], next: 'value', cites: [], epoch: 0 }]);
    const B = env('B', 1, { p: 20, l: 0 }, [{ kind: 'clear', path: ['x'], cites: [aDot], epoch: 0 }]);

    const plain = createConvergingApply();
    plain.ingest(B);
    plain.ingest(A);
    expect(plain.materialize()).toBeUndefined(); // A stays suppressed by B's citation

    const eager = createConvergingApply();
    eager.ingest(B);
    eager.settle({ A: { p: 20, l: 0 }, B: { p: 20, l: 0 } }); // A taken as settled before it was received
    eager.ingest(A);
    expect(eager.materialize()).toEqual({ x: 'value' }); // resurrected

    // the candidate keeps the watermark: A has not been received, so settled[A] is absent
    const settled = createConvergingApply();
    settled.ingest(B);
    settled.settle({ B: { p: 20, l: 0 } });
    settled.ingest(A);
    expect(settled.materialize()).toBeUndefined();
  });

  it('tombstone: a delayed older set under a tombstone stays suppressed; settle never drops one', () => {
    const D = env('D', 1, { p: 20, l: 0 }, [{ kind: 'delete', path: ['k'], prev: 1, cites: [], epoch: 0 }]);
    const S = env('S', 1, { p: 10, l: 0 }, [{ kind: 'set', path: ['k'], next: 1, cites: [], epoch: 0 }]);
    const plain = createConvergingApply();
    plain.ingest(D);
    plain.ingest(S);
    expect(plain.materialize()).toEqual({}); // k stays deleted (the root vivifies)

    // no settled vector can drop a tombstone: settle keeps it whatever it is told
    const eager = createConvergingApply();
    eager.ingest(D);
    eager.settle({ D: { p: 20, l: 0 }, S: { p: 20, l: 0 } });
    eager.ingest(S);
    expect(eager.materialize()).toEqual({});

    const settled = createConvergingApply();
    settled.ingest(D);
    settled.settle({ D: { p: 20, l: 0 } });
    settled.ingest(S);
    expect(settled.materialize()).toEqual({});
  });

  it("Miha's epoch schedule: a citing op need not carry the epoch it supersedes, so collecting the cited sibling lowers the relay's baseline", () => {
    const aDot: Dot = { origin: 'A', hlc: { p: 10, l: 0 } };
    const A = env('A', 1, aDot.hlc, [{ kind: 'set', path: ['x'], next: 1, cites: [], epoch: 5 }]);
    const B = env('B', 1, { p: 20, l: 0 }, [{ kind: 'clear', path: ['x'], cites: [aDot], epoch: 0 }]);
    const plain = createRegisterStore();
    plain.ingest(A);
    plain.ingest(B);
    const collected = createRegisterStore();
    collected.ingest(A);
    collected.ingest(B);
    collected.settle({ A: aDot.hlc, B: { p: 20, l: 0 } });
    // A's covered sibling is gone; the baseline is not
    expect(collected.checkpoint().find((r) => r.path[0] === 'x')?.siblings.map((s) => s.origin)).toEqual(['B']);
    expect(plain.maxEpoch(['x'])).toBe(5);
    expect(collected.maxEpoch(['x'])).toBe(5);
    // and it survives a checkpoint round trip on its own
    const reloaded = createRegisterStore();
    reloaded.load(collected.checkpoint());
    expect(reloaded.maxEpoch(['x'])).toBe(5);
  });

  it('C5 is load-bearing: a duplicate ingested after settle re-admits collected evidence and is observable', () => {
    // A sets x; B supersedes it citing A; both settled; A's sibling and watermark are collected.
    const aDot: Dot = { origin: 'A', hlc: { p: 10, l: 0 } };
    const A = env('A', 1, aDot.hlc, [{ kind: 'set', path: ['x'], next: 'old', cites: [], epoch: 0 }]);
    const B = env('B', 1, { p: 20, l: 0 }, [{ kind: 'set', path: ['x'], next: 'new', cites: [aDot], epoch: 0 }]);
    const fold = createConvergingApply();
    fold.ingest(A);
    fold.ingest(B);
    fold.settle({ A: aDot.hlc, B: { p: 20, l: 0 } });
    expect(fold.liveAt(['x']).map((s) => s.origin)).toEqual(['B']);
    // a resend of A that slips past the duplicate gate would come back as a LIVE concurrent sibling
    fold.ingest(A);
    expect(fold.liveAt(['x']).map((s) => s.origin)).toEqual(['A', 'B']);
    // so the relay's per-origin admitted ranges (C5) are a precondition of the rule, not a nicety
  });
});

// ─── the harness ─────────────────────────────────────────────────────────────

type Replica = {
  readonly origin: string;
  /** Delivered-contiguously stamp per origin (the local settled vector). */
  readonly settled: Record<string, Hlc>;
  readonly nextVersion: Map<string, number>;
  readonly admitted: Set<string>;
  u: Fold;
  c: Fold;
};

type Admission = { settled: Record<string, Hlc>; nextVersion: Map<string, number>; admitted: Set<string> };

/** What the run varies about the admission rule, to show which parts of it the theorem rests on. */
type Rule = { readonly orderGate: boolean };
const RELAY_RULE: Rule = { orderGate: true };

type RelayPair = Admission & {
  u: Store;
  c: Store;
  /** Every envelope admitted, in sequence order: the journal recovery replays. */
  readonly log: OpEnvelope[];
  /** A checkpoint taken earlier: registers of the collecting twin + admission evidence at that point. */
  checkpoint?: { at: number; registers: ReturnType<Store['checkpoint']>; admission: Admission };
  /** The recovered twin: rebuilt from `checkpoint` + replay, then kept in step with the live pair. */
  r?: { store: Store; admission: Admission };
};
const cloneAdmission = (a: Admission): Admission => ({
  settled: { ...a.settled },
  nextVersion: new Map(a.nextVersion),
  admitted: new Set(a.admitted),
});

const keyOfEnv = (e: OpEnvelope) => `${e.origin}#${e.version}`;

/** The highest version of an origin this side has admitted, 0 when none. */
const maxOf = (r: Admission, origin: string): number => {
  let max = 0;
  for (const key of r.admitted) {
    const [o, v] = key.split('#');
    if (o === origin) max = Math.max(max, Number(v));
  }
  return max;
};

/**
 * Deliver with the relay's rule. A duplicate is refused; a version below the origin's maximum is
 * refused as out of order; anything else is admitted. The settled stamp follows the origin's FIRST
 * contiguous run of admitted versions, wherever that run starts: an origin that enters a
 * generation at version n (it lived through a cut, or its first envelope was the cut) settles
 * from n, not from 1. That anchor is sound only because of the order gate — nothing below an
 * admitted version is ever admitted later — and `rule.orderGate: false` exists to show it.
 * Returns whether the envelope was admitted.
 */
const admit = (r: Admission, e: OpEnvelope, rule: Rule = RELAY_RULE): boolean => {
  if (r.admitted.has(keyOfEnv(e))) return false;
  if (rule.orderGate && e.version < maxOf(r, e.origin)) return false;
  r.admitted.add(keyOfEnv(e));
  const next = r.nextVersion.get(e.origin);
  if (next === undefined || e.version === next) {
    r.nextVersion.set(e.origin, e.version + 1);
    r.settled[e.origin] = e.hlc;
  }
  return true;
};
const stamps = new Map<string, Hlc>();

const PATHS: readonly (readonly Key[])[] = [['a'], ['b'], ['b', 'c'], ['d'], ['d', 'e'], ['d', 'e', 'f']];

const materializeFrom = (regs: ReturnType<Store['checkpoint']>): unknown => {
  const fold = createConvergingApply();
  fold.load(regs);
  return fold.materialize();
};

const stampOf = (fold: Fold): unknown =>
  PATHS.map((path) => fold.stamp([{ kind: 'set', path, next: 0 }]).map((op) => ({ cites: op.cites, epoch: op.epoch, kind: op.kind, path: op.path })));

/** Retained representation: siblings + watermarks across every register (what GC removes). */
const sizeOf = (regs: ReturnType<Store['checkpoint']>): number =>
  regs.reduce((n, r) => n + r.siblings.length + Object.keys(r.water).length, 0);
const collected = { u: 0, c: 0, recovered: 0, stale: 0, lateEntries: 0 };

function run(seed: number, steps: number, withSettle: boolean, rule: Rule = RELAY_RULE): string | null {
  const rnd = mulberry32(seed);
  stamps.clear();
  const origins = ['A', 'B', 'C'];
  const replicas = new Map<string, Replica>();
  for (const o of origins) {
    replicas.set(o, {
      origin: o,
      settled: {},
      nextVersion: new Map(),
      admitted: new Set(),
      u: createConvergingApply({ origin: o }),
      c: createConvergingApply({ origin: o }),
    });
  }
  const relay: RelayPair = { settled: {}, nextVersion: new Map(), admitted: new Set(), u: createRegisterStore(), c: createRegisterStore(), log: [] };
  /** Every authored envelope, in per-origin order; delivery queues per (origin → target). */
  const authored = new Map<string, OpEnvelope[]>(origins.map((o) => [o, []]));
  const cursor = new Map<string, number>(); // `${from}>${to}` → next index to deliver
  const allDots: { path: readonly Key[]; dot: Dot }[] = [];
  let clock = 100;
  // an origin need not enter the generation at version 1: one that lived through a cut carries its
  // counter on, and a room's creator enters at 2 because its first envelope was the cut
  const entry = (): number => [0, 0, 1, 4, 9][Math.floor(rnd() * 5)];
  const versions = new Map<string, number>(origins.map((o) => [o, entry()]));
  // a writer with no fold of its own, whose configuration breaks per-origin order: now and then it
  // sends a version BELOW the one it entered at, stamped older than everything it sent since
  const GHOST = 'G';
  const ghostEntry = 5 + Math.floor(rnd() * 4);
  let ghostVersion = ghostEntry;
  let ghostStale = 0;
  authored.set(GHOST, []);

  const observe = (): string | null => {
    for (const r of replicas.values()) {
      const mu = JSON.stringify(r.u.materialize());
      const mc = JSON.stringify(r.c.materialize());
      if (mu !== mc) return `seed ${seed}: ${r.origin} materializes ${mu} vs compacted ${mc}`;
      const su = JSON.stringify(stampOf(r.u));
      const sc = JSON.stringify(stampOf(r.c));
      if (su !== sc) return `seed ${seed}: ${r.origin} stamps ${su} vs compacted ${sc}`;
      // snapshot round trip: a joiner seeded from each checkpoint sees the same document
      const ju = JSON.stringify(materializeFrom(r.u.checkpoint()));
      const jc = JSON.stringify(materializeFrom(r.c.checkpoint()));
      if (ju !== jc) return `seed ${seed}: joiner from ${r.origin} sees ${ju} vs ${jc}`;
    }
    for (const path of PATHS) {
      if (relay.u.maxEpoch(path) !== relay.c.maxEpoch(path)) {
        return `seed ${seed}: relay maxEpoch(${path}) ${relay.u.maxEpoch(path)} vs ${relay.c.maxEpoch(path)}`;
      }
    }
    for (const { path, dot } of allDots) {
      const exempt = !!relay.settled[dot.origin] && compareHlc(dot.hlc, relay.settled[dot.origin]) <= 0;
      const au = relay.u.covers(path, dot) || exempt;
      const ac = relay.c.covers(path, dot) || exempt;
      if (au !== ac) return `seed ${seed}: relay admission for ${dot.origin}@${dot.hlc.p} on ${path}: ${au} vs ${ac}`;
    }
    const ru = JSON.stringify(materializeFrom(relay.u.checkpoint()));
    const rc = JSON.stringify(materializeFrom(relay.c.checkpoint()));
    if (ru !== rc) return `seed ${seed}: joiner from relay sees ${ru} vs ${rc}`;
    if (relay.r) {
      const rr = JSON.stringify(materializeFrom(relay.r.store.checkpoint()));
      if (rr !== ru) return `seed ${seed}: joiner from RECOVERED relay sees ${rr} vs ${ru}`;
      for (const path of PATHS) {
        if (relay.r.store.maxEpoch(path) !== relay.u.maxEpoch(path)) {
          return `seed ${seed}: recovered maxEpoch(${path}) ${relay.r.store.maxEpoch(path)} vs ${relay.u.maxEpoch(path)}`;
        }
      }
      for (const { path, dot } of allDots) {
        const exempt = !!relay.settled[dot.origin] && compareHlc(dot.hlc, relay.settled[dot.origin]) <= 0;
        const au = relay.u.covers(path, dot) || exempt;
        const ar = relay.r.store.covers(path, dot) || exempt;
        if (au !== ar) return `seed ${seed}: recovered admission for ${dot.origin}@${dot.hlc.p} on ${path}: ${ar} vs ${au}`;
      }
      if (JSON.stringify(relay.r.admission.settled) !== JSON.stringify(relay.settled)) {
        return `seed ${seed}: recovered settled ${JSON.stringify(relay.r.admission.settled)} vs ${JSON.stringify(relay.settled)}`;
      }
      if ([...relay.r.admission.admitted].sort().join() !== [...relay.admitted].sort().join()) {
        return `seed ${seed}: recovered admission ranges differ`;
      }
    }
    return null;
  };

  const deliver = (e: OpEnvelope, to: Replica | RelayPair) => {
    if (!('origin' in to) && to.r && admit(to.r.admission, e, rule)) to.r.store.ingest(e); // C8: the recovered twin keeps pace
    if (!admit(to, e, rule)) return; // C5: duplicate or out-of-order refused, never ingested
    to.u.ingest(e);
    to.c.ingest(e);
    if (!('origin' in to)) to.log.push(e);
  };

  for (let step = 0; step < steps; step++) {
    const r = rnd();
    if (r < 0.35) {
      // author: cites and epoch come from the replica's own (uncompacted) fold
      const o = origins[Math.floor(rnd() * origins.length)];
      const rep = replicas.get(o) as Replica;
      const path = PATHS[Math.floor(rnd() * PATHS.length)];
      const k = rnd();
      const base =
        k < 0.6
          ? ({ kind: 'set', path, next: Math.floor(rnd() * 5) } as const)
          : k < 0.85
            ? ({ kind: 'delete', path, prev: undefined } as const)
            : ({ kind: 'clear', path } as const);
      let ops = rep.u.stamp([base], { bump: rnd() < 0.15 });
      // the protocol does not enforce epoch carry: a citing op may carry a LOWER epoch than the
      // sibling it supersedes (the relay only gates upward bumps). Generate what is admissible,
      // not what a well-behaved client emits.
      if (rnd() < 0.25) ops = ops.map((op) => ({ ...op, epoch: Math.floor(rnd() * (op.epoch + 1)) }));
      clock += 1 + Math.floor(rnd() * 3);
      const v = (versions.get(o) as number) + 1;
      versions.set(o, v);
      const hlc = { p: clock, l: 0 };
      const e = env(o, v, hlc, ops);
      stamps.set(keyOfEnv(e), hlc);
      (authored.get(o) as OpEnvelope[]).push(e);
      for (const op of ops) allDots.push({ path: op.path, dot: { origin: o, hlc } });
      // local ingest on both twins (the author applies its own write at once)
      rep.admitted.add(keyOfEnv(e));
      rep.u.ingest(e, { local: true });
      rep.c.ingest(e, { local: true });
      const next = rep.nextVersion.get(o);
      if (next === undefined || v === next) {
        rep.nextVersion.set(o, v + 1);
        rep.settled[o] = hlc;
      }
    } else if (r < 0.42) {
      // the ghost writes: usually its next version, sometimes a stale one from below its entry
      const path = PATHS[Math.floor(rnd() * PATHS.length)];
      const stale = ghostVersion > ghostEntry && ghostStale < ghostEntry - 1 && rnd() < 0.3;
      clock += 1;
      const v = stale ? ++ghostStale : ++ghostVersion;
      const hlc = stale ? { p: 1 + ghostStale, l: 0 } : { p: clock, l: 0 };
      const ops: SyncOp[] = [{ kind: 'set', path, next: `ghost-${v}`, cites: [], epoch: 0 }];
      const e = env(GHOST, v, hlc, ops);
      stamps.set(keyOfEnv(e), hlc);
      (authored.get(GHOST) as OpEnvelope[]).push(e);
      allDots.push({ path, dot: { origin: GHOST, hlc } });
    } else if (r < 0.8) {
      // deliver the next envelope from one origin to one target (per-origin FIFO, arbitrary across origins)
      const senders = [...origins, GHOST];
      const from = senders[Math.floor(rnd() * senders.length)];
      const targets: (Replica | RelayPair)[] = [...replicas.values()].filter((x) => x.origin !== from);
      targets.push(relay);
      const to = targets[Math.floor(rnd() * targets.length)];
      const key = `${from}>${'origin' in to ? to.origin : 'relay'}`;
      const i = cursor.get(key) ?? 0;
      const queue = authored.get(from) as OpEnvelope[];
      if (i < queue.length) {
        deliver(queue[i], to);
        cursor.set(key, i + 1);
      }
      // sometimes re-deliver an older one (a duplicate)
      if (rnd() < 0.2 && i > 0) deliver(queue[Math.floor(rnd() * i)], to);
    } else if (r < 0.93) {
      // collect garbage on one C twin with the candidate rule (or the old rule, to show teeth)
      const targets: (Replica | RelayPair)[] = [...replicas.values(), relay];
      const to = targets[Math.floor(rnd() * targets.length)];
      if (withSettle) {
        to.c.settle(to.settled);
        if (!('origin' in to) && to.r && rnd() < 0.5) to.r.store.settle(to.r.admission.settled);
      } else {
        // over-eager: every origin taken as settled at the latest stamp seen, received or not
        const latest = [...stamps.values()].reduce<Hlc>((m, h) => (compareHlc(h, m) > 0 ? h : m), { p: 0, l: 0 });
        to.c.settle({ A: latest, B: latest, C: latest, G: latest });
      }
    } else if (r < 0.975) {
      // C8: checkpoint the collecting relay twin now, or recover from an earlier checkpoint by
      // replaying the envelopes admitted since (in sequence order, through the same admission
      // rule, collecting at its own points) — the recovered twin then runs alongside
      if (!relay.checkpoint || rnd() < 0.5) {
        relay.checkpoint = { at: relay.log.length, registers: relay.c.checkpoint(), admission: cloneAdmission(relay) };
      } else {
        const store = createRegisterStore();
        store.load(relay.checkpoint.registers);
        const admission = cloneAdmission(relay.checkpoint.admission);
        for (const e of relay.log.slice(relay.checkpoint.at)) {
          if (admit(admission, e, rule)) store.ingest(e);
          if (rnd() < 0.3) store.settle(admission.settled);
        }
        relay.r = { store, admission };
      }
    } else {
      // snapshot round trip on one replica's C twin (and U, symmetrically)
      const rep = [...replicas.values()][Math.floor(rnd() * replicas.size)];
      // a reload: registers from the snapshot, and the replica's own emission floors from local
      // persistence (C4's client half — a floor whose own sibling was collected has no other source)
      const fresh = (from: Fold) => {
        const f = createConvergingApply({ origin: rep.origin });
        f.load(from.checkpoint());
        f.restoreFloors(from.emissionFloors());
        return f;
      };
      rep.u = fresh(rep.u);
      rep.c = fresh(rep.c);
      if (rnd() < 0.5) {
        const freshStore = (from: Store) => {
          const st = createRegisterStore();
          st.load(from.checkpoint());
          return st;
        };
        relay.u = freshStore(relay.u);
        relay.c = freshStore(relay.c);
      }
    }
    const violation = observe();
    if (violation) return violation + ` (step ${step})`;
  }
  for (const r of replicas.values()) {
    collected.u += sizeOf(r.u.checkpoint());
    collected.c += sizeOf(r.c.checkpoint());
  }
  collected.u += sizeOf(relay.u.checkpoint());
  collected.c += sizeOf(relay.c.checkpoint());
  if (relay.r) collected.recovered += 1;
  collected.stale += ghostStale;
  collected.lateEntries += origins.filter((o) => (authored.get(o) as OpEnvelope[])[0]?.version > 1).length;
  return null;
}

describe('compaction proof: observational equivalence', () => {
  it('an over-eager collection is observable (the harness has teeth)', () => {
    let seen = 0;
    for (let seed = 0; seed < 200; seed++) if (run(seed, 60, false) !== null) seen++;
    expect(seen).toBeGreaterThan(0);
  });

  it('the candidate rule is unobservable across 600 seeds × 80 steps, and it does collect', () => {
    collected.u = 0;
    collected.c = 0;
    collected.recovered = 0;
    collected.stale = 0;
    collected.lateEntries = 0;
    for (let seed = 0; seed < 600; seed++) {
      const v = run(seed, 80, true);
      expect(v).toBeNull();
    }
    // the proof is about a rule that removes representation, not one that never runs
    expect(collected.c).toBeLessThan(collected.u * 0.9);
    // and recovery (C8) was exercised: a recovered relay twin ran alongside in a good share of runs
    expect(collected.recovered).toBeGreaterThan(250);
    // origins that entered above version 1 wrote, and a writer sent versions from below its entry
    expect(collected.lateEntries).toBeGreaterThan(600);
    expect(collected.stale).toBeGreaterThan(300);
  });

  it('the first-run anchor rests on the order gate: admitting a version below an admitted one is observable', () => {
    let seen = 0;
    for (let seed = 0; seed < 200; seed++) if (run(seed, 80, true, { orderGate: false }) !== null) seen++;
    expect(seen).toBeGreaterThan(0);
  });
});
