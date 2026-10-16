import { Injector, untracked, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  compareHlc,
  createStoreContext,
  store,
  type OpEnvelope,
  type WritableSignalStore,
} from '@mmstack/primitives/core';
import {
  createWorkerHost,
  type WorkerHost,
  type WorkerPortLike,
} from '@mmstack/worker/host';
import {
  storeFrontierEquals,
  type StoreFrontier,
  type WorkerEnvelope,
} from '@mmstack/worker/protocol';
import { describe, expect, it } from 'vitest';
import { connectWorker, type WorkerRef } from './connect-worker';
import { workerStore, type WorkerStoreRef } from './worker-store';

// M3: the frontier predicate on the REAL host + replicas, over hand-driven FIFO channels (one up and
// one down queue per replica: the postMessage contract) so the schedule is a seeded choice of which
// channel delivers next. The oracle tracks applied op SETS (dots `origin#version`) and the owner
// GENERATION each set belongs to, from the traffic alone; the SUT is
// `storeFrontierEquals(owner frontier at a derivation, replica.applied())`. Mid-run the owner host
// is replaced by a fresh one seeded from the VALUE (no registers): every worker port crashes, each
// replica reconnects and rehydrates into the new generation.

const SEEDS = 200;
const STEPS = 70;
const REPLICAS = 3;

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Doc = { cells: Record<string, number> };
type Dot = string;
const dotOf = (env: OpEnvelope): Dot => `${env.origin}#${env.version}`;
const setEq = (a: ReadonlySet<Dot>, b: ReadonlySet<Dot>) =>
  a.size === b.size && [...a].every((d) => b.has(d));

type Port = { onmessage: ((ev: any) => void) | null };
type Queued = { msg: WorkerEnvelope; ownerSet?: ReadonlySet<Dot> };
type Gen = {
  readonly id: number;
  readonly owned: WritableSignalStore<Doc>;
  readonly host: WorkerHost<{
    readonly stores: { room: Doc };
    readonly published: Record<string, never>;
    readonly tasks: Record<string, never>;
  }>;
  readonly ownerSet: Set<Dot>;
};
type Channel = { queue: Queued[]; target: Port; gen: Gen };
type Replica = {
  set: Set<Dot>;
  gen: number | null; // the generation the oracle set belongs to; null = none (pre-checkpoint)
  postsSinceCrash: Set<Dot>;
  up: Channel;
  down: Channel;
  client: Port & { onerror: (() => void) | null };
  worker: WorkerRef;
  ref: WorkerStoreRef<Doc>;
};

function world(seed: number) {
  const r = mulberry32(seed * 104729);
  let genSeq = 0;
  const makeGen = (value: Doc): Gen => {
    const owned = store<Doc>(value, createStoreContext());
    const gen: Gen = {
      id: genSeq++,
      owned,
      host: createWorkerHost({
        stores: { room: owned as unknown as WritableSignal<Doc> },
      }),
      ownerSet: new Set(),
    };
    // an always-subscribed tap: owner emissions count even while no replica is subscribed (a fresh
    // owner before the replicas reconnect)
    const tap: Port = { onmessage: null };
    gen.host.connect(
      Object.assign(tap, {
        postMessage: (msg: unknown) => {
          const m = msg as WorkerEnvelope;
          if (
            m.type === 'store:sync' &&
            m.env.origin.startsWith(gen.host.hostId)
          )
            gen.ownerSet.add(dotOf(m.env));
        },
      }),
    );
    tap.onmessage?.({
      data: { type: 'store:subscribe', store: 'room', clientId: 'tap' },
    });
    return gen;
  };
  let g = makeGen({ cells: { a: 0 } });

  // a fresh channel pair to the CURRENT host: what a (re)spawned worker port is
  const spawn = (rep: Replica): WorkerPortLike => {
    const gen = g;
    const hostSide: Port = { onmessage: null };
    const client: Replica['client'] = { onmessage: null, onerror: null };
    const up: Channel = { queue: [], target: hostSide, gen };
    const down: Channel = { queue: [], target: client, gen };
    gen.host.connect(
      Object.assign(hostSide, {
        postMessage: (msg: unknown) => {
          const m = structuredClone(msg) as WorkerEnvelope;
          if (
            m.type === 'store:sync' &&
            m.env.origin.startsWith(gen.host.hostId)
          )
            gen.ownerSet.add(dotOf(m.env));
          down.queue.push({
            msg: m,
            ownerSet:
              m.type === 'store:checkpoint' ? new Set(gen.ownerSet) : undefined,
          });
        },
      }),
    );
    rep.up = up;
    rep.down = down;
    rep.client = client;
    return Object.assign(client, {
      postMessage: (msg: unknown) => {
        const m = structuredClone(msg) as WorkerEnvelope;
        if (m.type === 'store:sync') {
          rep.set.add(dotOf(m.env)); // own envelopes are applied locally when posted
          rep.postsSinceCrash.add(dotOf(m.env));
        }
        up.queue.push({ msg: m });
      },
    });
  };

  const replicas: Replica[] = Array.from({ length: REPLICAS }, () => {
    const rep = {
      set: new Set<Dot>(),
      gen: null,
      postsSinceCrash: new Set<Dot>(),
    } as unknown as Replica;
    const injector = TestBed.inject(Injector);
    rep.worker = TestBed.runInInjectionContext(() =>
      connectWorker(() => spawn(rep), {
        injector,
        restart: 'auto',
        restartDelay: () => 0,
      }),
    );
    rep.ref = TestBed.runInInjectionContext(() =>
      workerStore<Doc>(rep.worker, 'room', { injector }),
    );
    return rep;
  });
  const channels = () => replicas.flatMap((x) => [x.up, x.down]);

  const deliver = (ch: Channel): void => {
    const q = ch.queue.shift() as Queued;
    const rep = replicas.find((x) => x.down === ch);
    if (rep && q.msg.type === 'store:sync' && rep.gen !== null)
      rep.set.add(dotOf(q.msg.env)); // no checkpoint in this generation yet: nothing is folded
    if (rep && q.msg.type === 'store:checkpoint') {
      if (rep.gen === ch.gen.id)
        for (const d of q.ownerSet ?? []) rep.set.add(d);
      // a new generation: its checkpoint plus the own tail the replica replays on top of it
      else rep.set = new Set([...(q.ownerSet ?? []), ...rep.postsSinceCrash]);
      rep.gen = ch.gen.id;
    }
    if (!rep && q.msg.type === 'store:sync')
      ch.gen.ownerSet.add(dotOf(q.msg.env));
    ch.target.onmessage?.({ data: q.msg });
  };

  /** Replace the owner by a fresh host seeded from the current VALUE; every worker port crashes. */
  const replaceOwner = async () => {
    const old = g;
    g = makeGen(structuredClone(untracked(old.owned)));
    old.host.dispose();
    for (const rep of replicas) {
      rep.gen = null;
      rep.set = new Set();
      rep.postsSinceCrash = new Set();
      rep.client.onerror?.();
    }
    for (let i = 0; i < 3; i++)
      await new Promise<void>((res) => setTimeout(res, 0)); // respawn
  };

  return { r, gen: () => g, replicas, channels, deliver, replaceOwner };
}

describe('M3 the frontier predicate: storeFrontierEquals(owner@derivation, replica.applied()) ⇔ same generation + same applied op set', () => {
  it(`[PROVEN] both directions, monotone per origin within a generation, owner replaced mid-run, ${SEEDS} seeds × ${STEPS} steps × ${REPLICAS} replicas`, async () => {
    const hits = {
      eqTrue: 0,
      eqFalse: 0,
      eqTrueNewGen: 0,
      staleGenChecks: 0,
      hydrates: 0,
      dupes: 0,
      ownerWrites: 0,
      lateJoins: 0,
    };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed);
      const { r, replicas, channels } = w;
      // the last replica is a LATE JOINER: its channels stay frozen until a random step, so its first
      // hydrate carries ops it never saw as envelopes
      const late = replicas[REPLICAS - 1];
      const joinAt = 10 + Math.floor(r() * 30);
      const genAt = 42 + Math.floor(r() * 12); // the owner is replaced after the late join
      let stepNow = 0;
      const frozen = (c: Channel) =>
        (c === late.up || c === late.down) && stepNow < joinAt;
      for (let guard = 0; guard < 10_000; guard++) {
        const ch = channels().find((c) => c.queue.length && !frozen(c));
        if (!ch) break;
        w.deliver(ch); // handshake + first hydrate of the early replicas
      }
      const delivered: { ch: Channel; msg: WorkerEnvelope }[] = [];
      const derivations: {
        F: StoreFrontier;
        gen: number;
        S: ReadonlySet<Dot>;
      }[] = [];
      const last = replicas.map((): StoreFrontier => ({
        instance: '',
        applied: {},
      }));
      const derive = () => {
        const g = w.gen();
        derivations.push({
          F: g.host.frontiers.room(),
          gen: g.id,
          S: new Set(g.ownerSet),
        });
        if (derivations.length > 5) derivations.shift();
      };

      const check = (step: number) => {
        for (const [i, rep] of replicas.entries()) {
          const now = rep.ref.applied();
          const prev = last[i];
          if (now.instance !== '' && now.instance === prev.instance) {
            for (const [o, h] of Object.entries(prev.applied)) {
              expect(
                now.applied[o],
                `seed ${seed} step ${step} r${i}: origin dropped`,
              ).toBeDefined();
              expect(
                compareHlc(now.applied[o], h),
                `seed ${seed} step ${step} r${i}: lowered`,
              ).toBeGreaterThanOrEqual(0);
            }
          }
          last[i] = now;
          for (const d of derivations) {
            const byFrontier = storeFrontierEquals(d.F, now);
            const bySet =
              rep.gen !== null && rep.gen === d.gen && setEq(d.S, rep.set);
            expect(
              byFrontier,
              `seed ${seed} step ${step} r${i} gen ${d.gen}/${rep.gen}`,
            ).toBe(bySet);
            if (bySet) {
              hits.eqTrue++;
              if (d.gen > 0) hits.eqTrueNewGen++;
            } else hits.eqFalse++;
            if (d.gen !== w.gen().id) hits.staleGenChecks++;
          }
        }
      };

      for (let step = 0; step < STEPS; step++) {
        stepNow = step;
        if (step === genAt) {
          if (late.gen !== null) hits.lateJoins++; // the late joiner hydrated in the first generation
          await w.replaceOwner();
          check(step);
          continue;
        }
        const roll = r();
        const rep = replicas[Math.floor(r() * replicas.length)];
        const key = 'abc'[Math.floor(r() * 3)];
        if (roll < 0.22) {
          if (rep.ref.hasValue())
            rep.ref
              .write((d) => d.cells[key].set(Math.floor(r() * 1000)))
              .catch(() => undefined);
        } else if (roll < 0.32) {
          w.gen().owned.cells[key].set(Math.floor(r() * 1000));
          hits.ownerWrites++;
          if (r() < 0.5) w.gen().host.flush(); // else it rides a receive/subscribe or a microtask
        } else if (roll < 0.4) {
          derive();
        } else if (roll < 0.45) {
          // a hydrate mid-run: the replica re-subscribes (what its gap path does)
          rep.worker._send({
            type: 'store:subscribe',
            store: 'room',
            clientId: rep.worker.clientId,
          });
          hits.hydrates++;
        } else if (roll < 0.5 && delivered.length) {
          const { ch, msg } = delivered[Math.floor(r() * delivered.length)];
          if (msg.type === 'store:sync' && channels().includes(ch)) {
            ch.queue.push({ msg }); // a duplicated delivery, appended FIFO
            hits.dupes++;
          }
        } else if (roll < 0.55) {
          await Promise.resolve(); // let microtask drivers emit
          await Promise.resolve();
        } else {
          const live = channels().filter((c) => c.queue.length && !frozen(c));
          if (live.length) {
            const ch = live[Math.floor(r() * live.length)];
            const msg = ch.queue[0].msg;
            w.deliver(ch);
            delivered.push({ ch, msg });
          }
        }
        check(step);
      }
      // quiesce: everything delivered ⇒ every replica matches the final owner derivation
      stepNow = STEPS;
      w.gen().host.flush();
      for (let guard = 0; guard < 10_000; guard++) {
        const ch = channels().find((c) => c.queue.length);
        if (!ch) break;
        w.deliver(ch);
      }
      derive();
      check(STEPS);
      for (const rep of replicas) {
        expect(
          storeFrontierEquals(w.gen().host.frontiers.room(), rep.ref.applied()),
          `seed ${seed} quiesced`,
        ).toBe(true);
        rep.ref.destroy();
        rep.worker.destroy();
      }
      w.gen().host.dispose();
    }
    // the schedule really exercises both outcomes and every perturbation
    expect(hits.eqTrue).toBeGreaterThan(1000);
    expect(hits.eqFalse).toBeGreaterThan(1000);
    expect(hits.eqTrueNewGen).toBeGreaterThan(SEEDS);
    expect(hits.staleGenChecks).toBeGreaterThan(SEEDS);
    expect(hits.hydrates).toBeGreaterThan(SEEDS);
    expect(hits.dupes).toBeGreaterThan(SEEDS);
    expect(hits.ownerWrites).toBeGreaterThan(SEEDS);
    expect(hits.lateJoins).toBeGreaterThan(SEEDS / 4);
  });
});
