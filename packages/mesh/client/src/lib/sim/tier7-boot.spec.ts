/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestBed } from '@angular/core/testing';
import {
  createRelay,
  type RegisterCheckpoint,
  type SeqEnvelope,
} from '@mmstack/mesh-protocol';
import {
  applyOps,
  createConvergingApply,
  createHlcClock,
  opSync,
  store,
  type OpEnvelope,
} from '@mmstack/primitives';

/**
 * Tier 7 (crash / session / consumer correctness) CHARACTERIZATIONS. These pin the CURRENT boot and
 * replay behavior of the shipped stack so the gaps are visible and a later wave's fix has a contract
 * to flip. Where the current behavior is already correct it is asserted as an INVARIANT; where it is
 * a known gap it asserts what IS (even if wrong) and states the flip. Deterministic: fixed clocks,
 * fixed origins, no timers.
 *
 * Boot-race (disk vs relay) is characterized separately in boot-race.spec.ts; this file covers the
 * opSync durable-outbox / epoch-floor crash path and the relay onCommit replay egress.
 */

type Doc = { k: string };

// a peer's own durable-outbox capture: the envelopes a transport would have persisted for resend
function outboxPeer(origin: string, physical: number) {
  const sig = store<Doc>({ k: 'init' });
  const sent: OpEnvelope[] = [];
  const sync = opSync(sig, {
    writer: origin,
    origin,
    clock: createHlcClock(() => physical),
  });
  sync.subscribe((e) => sent.push(e));
  return { sig, sync, sent };
}

describe('Tier 7: read-your-writes across crash + restore (INVARIANT)', () => {
  it('an unacked offline write survives a crash and is re-handed to the transport for resend', () => {
    const captured: OpEnvelope[] = [];
    TestBed.runInInjectionContext(() => {
      const a = outboxPeer('o1', 10);
      a.sig.k.set('offline'); // written while disconnected, never acked
      a.sync.flush();
      captured.push(...a.sent); // the durable outbox a transport would persist
      a.sync.destroy();
    });
    expect(captured).toHaveLength(1);

    // reboot: a FRESH instance restores the persisted outbox (nothing was acked)
    const out = TestBed.runInInjectionContext(() => {
      const b = outboxPeer('o1', 20);
      const resent: OpEnvelope[] = [];
      b.sent.length = 0;
      b.sync.subscribe((e) => resent.push(e));
      b.sync.restore(captured, 1);
      const root = b.sig();
      b.sync.destroy();
      return { root, resent };
    });

    expect(out.root.k).toBe('offline'); // read-your-writes: the offline edit is on the rebooted store
    expect(out.resent).toHaveLength(1); // and handed back to the transport to resend the unacked tail
    expect(out.resent[0].version).toBe(1);
  });

  it('monotonic-reads: restore never regresses the already-exposed value below what was persisted', () => {
    // two offline writes; the second superseded the first before the crash, so the restored read
    // must be the LATER value, never the earlier one
    const captured: OpEnvelope[] = [];
    TestBed.runInInjectionContext(() => {
      const a = outboxPeer('o1', 10);
      a.sig.k.set('first');
      a.sync.flush();
      a.sig.k.set('second');
      a.sync.flush();
      captured.push(...a.sent);
      a.sync.destroy();
    });

    const root = TestBed.runInInjectionContext(() => {
      const b = outboxPeer('o1', 20);
      b.sync.restore(captured, captured.length);
      const r = b.sig();
      b.sync.destroy();
      return r;
    });
    expect(root.k).toBe('second'); // the later write, never a regression to 'first'
  });
});

describe('Tier 7: epoch floor across crash + boot (INVARIANT — dissolved by fresh-origin fencing)', () => {
  // The epoch floor never needs to persist. A dot is (origin, hlc), and every boot mints a FRESH
  // origin, so per-origin epoch monotonicity holds vacuously (a fresh origin has no emission history).
  // The correct boot flow is restore (resend the unacked tail verbatim) then HYDRATE the room
  // checkpoint before writing: a post-crash write STAMPS against the live siblings it just loaded, so
  // it adopts the exposed epoch at the path and competes there. A write made blind (before any hydrate)
  // legitimately emits epoch-fresh and may lose the fold — that is correct optimistic-offline
  // semantics, not a regression.
  const emittedEpoch = (
    origin: string,
    restoreEnvs: OpEnvelope[],
    highWater: number,
    checkpoint?: Parameters<ReturnType<typeof opSync<Doc>>['hydrate']>[0],
  ): number => {
    return TestBed.runInInjectionContext(() => {
      const s = store<Doc>({ k: 'init' });
      const sync = opSync(s, { writer: 'w', origin, clock: createHlcClock(() => 30) });
      const emitted: OpEnvelope[] = [];
      sync.subscribe((e) => emitted.push(e));
      sync.restore(restoreEnvs, highWater);
      if (checkpoint) sync.hydrate(checkpoint); // the normal boot flow: adopt the room state first
      emitted.length = 0; // ignore any resent tail; capture only the new write
      s.k.set('RETRY');
      sync.flush();
      const epoch = (emitted.at(-1)!.ops[0] as { epoch: number }).epoch;
      sync.destroy();
      return epoch;
    });
  };

  it('a post-crash write adopts the exposed epoch once the room checkpoint is hydrated (no regression)', () => {
    // session 1: an authority override stamps ['k'] at epoch 1 and the room commits it
    const overrideEnv = TestBed.runInInjectionContext(() => {
      const s = store<Doc>({ k: 'init' });
      const sync = opSync(s, { writer: 'w', origin: 'o1', clock: createHlcClock(() => 10) });
      const sent: OpEnvelope[] = [];
      sync.subscribe((e) => sent.push(e));
      sync.override(() => s.k.set('AUTH'));
      const env = sent.at(-1)!;
      sync.destroy();
      expect((env.ops[0] as { epoch: number }).epoch).toBe(1); // exposed epoch 1
      return env;
    });

    // the room's checkpoint after committing the override: register state carries the epoch-1 sibling
    const room = createConvergingApply();
    room.ingest(overrideEnv);
    const checkpoint = {
      root: room.materialize() as Doc,
      registers: room.checkpoint(),
      wm: { o1: 1 },
    };

    // CASE B (unacked tail still in the outbox): restore replays the override, floor stands
    const withTail = emittedEpoch('o2', [overrideEnv], 1);
    expect(withTail).toBe(1); // retry carries the epoch forward

    // CASE A (override acked + dropped, but the room checkpoint is hydrated): stamp reads the loaded
    // epoch-1 sibling and adopts it — the retry competes at the exposed epoch, no regression
    const hydratedBoot = emittedEpoch('o2', [], 1, checkpoint);
    expect(hydratedBoot).toBe(1); // FLIPPED: the normal boot flow adopts the observed epoch

    // a BLIND write (no tail, no hydrate) legitimately emits epoch-fresh — correct offline semantics
    const blind = emittedEpoch('o2', [], 1);
    expect(blind).toBe(0); // not a bug: an uninformed write competes fresh and may lose the fold
  });

  it('the hydrated-boot retry WINS the fold at the exposed epoch; only a blind epoch-fresh write can lose', () => {
    // shown deterministically at the register. A survivor of the old epoch under another origin:
    const survivor: OpEnvelope = { proto: 2, origin: 'o2', writer: 'w2', version: 1, hlc: { p: 20, l: 0 }, policyVersion: 0, ops: [{ kind: 'set', path: ['k'], next: 'SURVIVOR', cites: [], epoch: 1 }] };

    // the hydrated-boot retry adopted epoch 1 and has a later hlc → it WINS
    const won = createConvergingApply();
    let a: unknown = {};
    a = applyOps(a, won.ingest(survivor));
    a = applyOps(a, won.ingest({ proto: 2, origin: 'o3', writer: 'w', version: 1, hlc: { p: 30, l: 0 }, policyVersion: 0, ops: [{ kind: 'set', path: ['k'], next: 'RETRY', cites: [], epoch: 1 }] }));
    expect((a as Doc).k).toBe('RETRY'); // competes at the exposed epoch and wins on hlc

    // only a blind epoch-0 write loses to the epoch-1 survivor (accepted optimistic-offline outcome)
    const lost = createConvergingApply();
    let b: unknown = {};
    b = applyOps(b, lost.ingest(survivor));
    b = applyOps(b, lost.ingest({ proto: 2, origin: 'o3', writer: 'w', version: 1, hlc: { p: 30, l: 0 }, policyVersion: 0, ops: [{ kind: 'set', path: ['k'], next: 'RETRY', cites: [], epoch: 0 }] }));
    expect((b as Doc).k).toBe('SURVIVOR'); // a blind write is a fresh sibling and may lose; not a regression
  });
});

describe('Tier 7: effect exactly-once across relay restart replay (INVARIANT)', () => {
  // A persistence/effect adapter subscribes to the relay `onCommit` egress. Restart + hydrate reloads
  // the journal directly (never through onCommit), so each committed envelope fires the effect exactly
  // once across the restart — an append-on-onCommit adapter does not double-write the reloaded tail.
  it('onCommit fires once per committed seq even across a restart that reloads the journal', () => {
    const fired: number[] = []; // seq of every onCommit invocation, across both relay instances
    let snapSeq = 0;
    let snapInstance = '';
    let snapRegisters: readonly RegisterCheckpoint[] = [];
    let snapWm: Readonly<Record<string, number>> = {};
    const journalEnvs: SeqEnvelope[] = [];
    const onCommit = (
      _room: string,
      env: SeqEnvelope,
      state: {
        seq: number;
        instance: string;
        registers: readonly RegisterCheckpoint[];
        wm: Readonly<Record<string, number>>;
      },
    ) => {
      fired.push(env.seq);
      journalEnvs.push(env);
      snapSeq = state.seq;
      snapInstance = state.instance;
      snapRegisters = state.registers;
      snapWm = state.wm;
    };

    // drive a room to a few commits directly through a relay connection (no timers)
    const relay = createRelay({ onCommit });
    const conn = relay.connect({ send: () => undefined, close: () => undefined }, { writer: 'w' });
    conn.receive({ t: 'hello', room: 'r', origin: 'o', proto: 2, policyVersion: 0 });
    const emit = (v: number, next: unknown) =>
      conn.receive({
        t: 'env',
        room: 'r',
        env: { proto: 2, origin: 'o', writer: 'w', version: v, hlc: { p: v, l: 0 }, policyVersion: 0, ops: [{ kind: 'set', path: ['k'], next, cites: [], epoch: 0 }] },
      });
    emit(1, 'a');
    emit(2, 'b');
    emit(3, 'c');
    expect([...fired]).toEqual([1, 2, 3]); // each pre-restart commit fired once

    // restart: a fresh relay hydrates from the checkpoint, RELOADING the full journal
    const restored = createRelay({ onCommit });
    restored.hydrate('r', {
      seq: snapSeq,
      instance: snapInstance,
      registers: snapRegisters,
      wm: snapWm,
      journal: [...journalEnvs], // the reloaded journal must NOT re-fire onCommit
    });
    expect(fired).toEqual([1, 2, 3]); // hydrate reloaded the journal without re-firing the effect

    const conn2 = restored.connect({ send: () => undefined, close: () => undefined }, { writer: 'w2' });
    conn2.receive({ t: 'hello', room: 'r', origin: 'o2', proto: 2, policyVersion: 0 });
    conn2.receive({
      t: 'env',
      room: 'r',
      env: { proto: 2, origin: 'o2', writer: 'w2', version: 1, hlc: { p: 10, l: 0 }, policyVersion: 0, ops: [{ kind: 'set', path: ['k'], next: 'd', cites: [], epoch: 0 }] },
    });

    // the restored relay continues the seq space, firing only for the NEW commit
    expect(fired).toEqual([1, 2, 3, 4]);
    expect(new Set(fired).size).toBe(fired.length); // exactly-once: no seq repeats across the restart
  });
});
