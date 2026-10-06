/**
 * Pure model of a transaction that survives awaits: an async body re-enters its transaction with
 * synchronous `enter` slices; writes and synchronous kickoffs inside a slice belong to that body's
 * transaction exactly, anything outside a slice is attributed by the open-window rule only.
 * The model itself has no Angular and no real signals: a tiny register of values, an undo log per
 * transaction and a ledger of flights. The last block replays its generated traces against the
 * real `startTransaction`, `Transaction` and attributed pending, step by step. Properties run over generated interleavings of two bodies plus foreign
 * writers; each tempting alternative is encoded beside the reference and shown to break the
 * property it would weaken.
 */

import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  type ResourceStatus,
  runInInjectionContext,
  type Signal,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { transactional } from './active-transaction';
import {
  type AsyncTransactionRef,
  injectStartTransaction,
  type Transaction,
  type TransactionOutcome,
} from './transaction';
import { abortTransaction } from './transaction-driver';
import {
  createAttributedPending,
  injectTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

type Id = string;
type Reason = 'abort' | 'superseded' | 'destroyed';
type Outcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: Reason }
  | { kind: 'failed'; error: unknown };

type Options = {
  /** exact = slice ownership + window outside slices; zone = everything during a running body belongs to it; window-only = no slice ownership for flights */
  attribution: 'exact' | 'zone' | 'window-only';
  /** owned = compare-and-restore on the current owner; blind = restore every log entry */
  restore: 'owned' | 'blind';
  /** immediate = cancel settles at once; wait-pending = cancel waits for attributed pending to drain */
  cancel: 'immediate' | 'wait-pending';
  /** throw = enter on a settled transaction throws before running; run = it runs the slice anyway */
  closedEnter: 'throw' | 'run';
  /** whether a destroy restores like abort/supersede (the sync form keeps writes on destroy) */
  destroyRestores: boolean;
  /** kept = an in-slice kickoff stays its owner's after the owner settles; released = it falls back to the window rule */
  claims: 'kept' | 'released';
};

const REFERENCE: Options = {
  attribution: 'exact',
  restore: 'owned',
  cancel: 'immediate',
  closedEnter: 'throw',
  destroyRestores: true,
  claims: 'kept',
};

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('model: missing entry');
  return v;
}

class ClosedError extends Error {
  constructor(id: Id) {
    super(`transaction ${id} is closed`);
  }
}

/** One undo entry: a transaction's writes to one signal within one slice. */
type Entry = {
  readonly txn: Id;
  readonly sig: string;
  readonly pre: number;
  readonly prev: Entry | null;
  mine: number;
  open: boolean;
};

class Txn {
  status: 'running' | 'returned' | 'settled' = 'running';
  outcome: Outcome | undefined;
  readonly entries: Entry[] = [];
  /** Signal → its oldest entry. */
  get log(): Map<string, Entry> {
    const m = new Map<string, Entry>();
    for (const e of this.entries) if (!m.has(e.sig)) m.set(e.sig, e);
    return m;
  }
  readonly retains = new Set<number>();
  readonly nested = new Set<number>();
  settledAt = Infinity;
  resolutions = 0;
  pendingCancel: Reason | undefined;
  constructor(
    readonly id: Id,
    readonly openedAt: number,
  ) {}
}

type Flight = {
  readonly id: number;
  readonly at: number;
  /** the transaction whose slice started it synchronously, else null */
  readonly owner: Id | null;
  /** zone alternative only: every body running when it started */
  readonly zoneOwners: readonly Id[];
  settled: boolean;
};

type WriteRecord = {
  readonly sig: string;
  readonly inSliceOf: Id | null;
  readonly claimers: readonly Id[];
};

const describeOutcome = (o: Outcome | undefined): string =>
  !o ? 'none' : o.kind === 'aborted' ? `aborted:${o.reason}` : o.kind;

/** A recorded step, replayed against the real implementation. */
type Ev =
  | { k: 'open'; id: Id }
  | { k: 'enter'; id: Id }
  | { k: 'exit'; id: Id }
  | { k: 'enterClosed'; id: Id }
  | { k: 'write'; sig: string; value: number }
  | { k: 'flight'; fid: number }
  | { k: 'settle'; fid: number }
  | { k: 'retain'; id: Id; rid: number }
  | { k: 'release'; id: Id; rid: number }
  | { k: 'nested'; into: Id; token: number }
  | { k: 'nestedSettle'; into: Id; token: number }
  | { k: 'return'; id: Id }
  | { k: 'throw'; id: Id }
  | { k: 'cancel'; id: Id; reason: Reason };

type Snap = {
  readonly values: Record<string, number>;
  readonly txns: Record<
    Id,
    { settled: boolean; outcome?: string; pending?: boolean; log?: string }
  >;
  readonly holding: boolean;
};

class World {
  recording = false;
  readonly events: { e: Ev; snap?: Snap }[] = [];
  clock = 0;
  private vals = 0;
  readonly value = new Map<string, number>();
  /** the entry that last recorded each signal */
  readonly owner = new Map<string, Entry | null>();
  /** every writer label, in order, per signal */
  readonly sigWrites = new Map<string, string[]>();
  /** every value a signal ever held */
  readonly sigValues = new Map<string, Set<number>>();
  /** oracle side: who produced each (globally unique) value */
  readonly origin = new Map<number, string>();
  readonly txns = new Map<Id, Txn>();
  readonly flights: Flight[] = [];
  readonly writes: WriteRecord[] = [];
  private readonly stack: Id[] = [];
  holds = 0;
  private ids = 0;

  constructor(
    readonly opt: Options,
    sigs: readonly string[],
  ) {
    for (const s of sigs) {
      this.value.set(s, this.fresh('init'));
      this.owner.set(s, null);
      this.sigWrites.set(s, []);
      this.sigValues.set(s, new Set([must(this.value.get(s))]));
    }
  }

  private emit(e: Ev): void {
    if (this.recording) this.events.push({ e });
  }

  /** After a top-level step, remember the state the real implementation must match. */
  private tap(): void {
    if (!this.recording || this.stack.length || !this.events.length) return;
    this.events[this.events.length - 1].snap = this.snapshot();
  }

  snapshot(): Snap {
    const txns: Snap['txns'] = {};
    for (const t of this.txns.values())
      txns[t.id] =
        t.status === 'settled'
          ? { settled: true, outcome: describeOutcome(t.outcome) }
          : {
              settled: false,
              pending: this.pending(t),
              log: [...t.log.keys()].sort().join(),
            };
    return {
      values: Object.fromEntries(this.value),
      txns,
      holding: this.holds > 0,
    };
  }

  private fresh(label: string): number {
    const v = ++this.vals;
    this.origin.set(v, label);
    return v;
  }

  current(): Id | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  open(id: Id): Txn {
    this.clock++;
    const t = new Txn(id, this.clock);
    this.txns.set(id, t);
    this.holds++;
    this.emit({ k: 'open', id });
    this.tap();
    return t;
  }

  enter(id: Id, fn: () => void): void {
    const t = must(this.txns.get(id));
    if (t.status === 'settled' && this.opt.closedEnter === 'throw') {
      this.emit({ k: 'enterClosed', id });
      this.tap();
      throw new ClosedError(id);
    }
    this.emit({ k: 'enter', id });
    this.stack.push(id);
    try {
      fn();
    } finally {
      this.stack.pop();
      for (const e of t.entries) e.open = false;
      this.emit({ k: 'exit', id });
      this.tap();
    }
  }

  private running(): Txn[] {
    return [...this.txns.values()].filter((t) => t.status === 'running');
  }

  /** `unwrappedBy` marks a body continuation writing outside any slice. */
  write(sig: string, unwrappedBy?: Id): void {
    this.clock++;
    const cur = this.current();
    const label = cur ?? (unwrappedBy ? `unowned:${unwrappedBy}` : 'foreign');
    let claimers: Id[];
    if (this.opt.attribution === 'zone')
      claimers = this.running().map((t) => t.id);
    else
      claimers =
        cur && must(this.txns.get(cur)).status !== 'settled' ? [cur] : [];
    const touched: Entry[] = [];
    for (const c of claimers) {
      const t = must(this.txns.get(c));
      const prev = this.owner.get(sig) ?? null;
      if (prev && prev.txn === c && prev.open) {
        touched.push(prev);
        continue;
      }
      const e: Entry = {
        txn: c,
        sig,
        pre: must(this.value.get(sig)),
        prev,
        mine: 0,
        open: cur !== null,
      };
      t.entries.push(e);
      this.owner.set(sig, e);
      touched.push(e);
    }
    const value = this.fresh(label);
    this.value.set(sig, value);
    for (const e of touched) e.mine = value;
    must(this.sigWrites.get(sig)).push(label);
    must(this.sigValues.get(sig)).add(value);
    this.writes.push({ sig, inSliceOf: cur, claimers });
    this.emit({ k: 'write', sig, value });
    this.tap();
  }

  /** `sync` = started synchronously by the code running now; `scheduled`/`foreign` = outside any slice. */
  startFlight(kind: 'sync' | 'scheduled' | 'foreign'): Flight {
    this.clock++;
    const cur = kind === 'sync' ? this.current() : null;
    const owner =
      this.opt.attribution === 'window-only' ||
      !cur ||
      must(this.txns.get(cur)).status === 'settled'
        ? null
        : cur;
    const f: Flight = {
      id: ++this.ids,
      at: this.clock,
      owner,
      zoneOwners: this.running().map((t) => t.id),
      settled: false,
    };
    this.flights.push(f);
    this.emit({ k: 'flight', fid: f.id });
    this.tap();
    return f;
  }

  settleFlight(f: Flight): void {
    this.clock++;
    f.settled = true;
    this.progress();
    this.emit({ k: 'settle', fid: f.id });
    this.tap();
  }

  attributed(t: Txn, f: Flight): boolean {
    if (f.at < t.openedAt || f.at > t.settledAt) return false;
    if (this.opt.attribution === 'zone') return f.zoneOwners.includes(t.id);
    const owner =
      f.owner !== null &&
      this.opt.claims === 'released' &&
      must(this.txns.get(f.owner)).status === 'settled'
        ? null
        : f.owner;
    return owner === null ? true : owner === t.id;
  }

  pending(t: Txn): boolean {
    if (t.status === 'settled') return false;
    return this.flights.some((f) => !f.settled && this.attributed(t, f));
  }

  retain(id: Id): number {
    const t = must(this.txns.get(id));
    if (t.status === 'settled') throw new ClosedError(id);
    const r = ++this.ids;
    t.retains.add(r);
    this.emit({ k: 'retain', id, rid: r });
    return r;
  }

  release(id: Id, r: number): void {
    this.clock++;
    must(this.txns.get(id)).retains.delete(r);
    this.progress();
    this.emit({ k: 'release', id, rid: r });
    this.tap();
  }

  /** A nested startTransaction inside a slice merges into the slice's transaction. */
  nestedStart(): { into: Id; token: number } {
    const into = this.current();
    if (!into) throw new Error('model: nestedStart outside a slice');
    const token = ++this.ids;
    must(this.txns.get(into)).nested.add(token);
    this.emit({ k: 'nested', into, token });
    return { into, token };
  }

  nestedSettle(into: Id, token: number): void {
    this.clock++;
    must(this.txns.get(into)).nested.delete(token);
    this.progress();
    this.emit({ k: 'nestedSettle', into, token });
    this.tap();
  }

  bodyReturn(id: Id): void {
    this.emit({ k: 'return', id });
    try {
      this.clock++;
      const t = must(this.txns.get(id));
      if (t.status === 'settled') return;
      t.status = 'returned';
      this.progress();
    } finally {
      this.tap();
    }
  }

  bodyThrow(id: Id, error: unknown): void {
    this.emit({ k: 'throw', id });
    try {
      this.clock++;
      const t = must(this.txns.get(id));
      if (t.status === 'settled') return;
      this.restore(t);
      this.settle(t, { kind: 'failed', error });
    } finally {
      this.tap();
    }
  }

  cancel(id: Id, reason: Reason): void {
    this.emit({ k: 'cancel', id, reason });
    try {
      this.clock++;
      const t = must(this.txns.get(id));
      if (t.status === 'settled') return;
      if (this.opt.cancel === 'wait-pending' && this.pending(t)) {
        t.pendingCancel = reason;
        return;
      }
      this.finishCancel(t, reason);
    } finally {
      this.tap();
    }
  }

  destroy(): void {
    for (const t of this.txns.values()) this.cancel(t.id, 'destroyed');
  }

  private finishCancel(t: Txn, reason: Reason): void {
    if (reason !== 'destroyed' || this.opt.destroyRestores) this.restore(t);
    else t.entries.length = 0;
    this.settle(t, { kind: 'aborted', reason });
  }

  /** Newest first; one compare-and-restore per entry. */
  private restore(t: Txn): void {
    for (let i = t.entries.length - 1; i >= 0; i--) {
      const e = t.entries[i];
      if (this.opt.restore === 'blind') {
        this.value.set(e.sig, e.pre);
        continue;
      }
      const owned = this.owner.get(e.sig) === e;
      if (owned && this.value.get(e.sig) === e.mine)
        this.value.set(e.sig, e.pre);
      if (owned) this.owner.set(e.sig, e.prev);
    }
    t.entries.length = 0;
  }

  ownerOf(sig: string): Id | null {
    return this.owner.get(sig)?.txn ?? null;
  }

  private settle(t: Txn, outcome: Outcome): void {
    t.status = 'settled';
    t.outcome = outcome;
    t.settledAt = this.clock;
    t.retains.clear();
    t.nested.clear();
    t.resolutions++;
    this.holds--;
  }

  private progress(): void {
    for (const t of this.txns.values()) {
      if (t.status === 'settled') continue;
      if (t.pendingCancel && !this.pending(t))
        this.finishCancel(t, t.pendingCancel);
      else if (
        t.status === 'returned' &&
        !this.pending(t) &&
        t.retains.size === 0 &&
        t.nested.size === 0
      ) {
        t.entries.length = 0;
        this.settle(t, { kind: 'completed' });
      }
    }
  }
}

// deterministic PRNG, reproducible traces
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SIGS = ['s0', 's1', 's2', 's3'] as const;

type SliceOp =
  | { k: 'write'; sig: string }
  | { k: 'flight' }
  | { k: 'schedule' }
  | { k: 'nested'; sigs: string[] }
  | { k: 'retain' };
type Step =
  | { k: 'slice'; ops: SliceOp[] }
  | { k: 'unwrapped'; sig: string }
  | { k: 'end'; throws: boolean };

function genScript(r: () => number): Step[] {
  const pick = () => SIGS[Math.floor(r() * SIGS.length)];
  const slice = (): Step => {
    const ops: SliceOp[] = [];
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const x = r();
      if (x < 0.45) ops.push({ k: 'write', sig: pick() });
      else if (x < 0.65) ops.push({ k: 'flight' });
      else if (x < 0.8) ops.push({ k: 'schedule' });
      else if (x < 0.9) ops.push({ k: 'nested', sigs: [pick(), pick()] });
      else ops.push({ k: 'retain' });
    }
    return { k: 'slice', ops };
  };
  const steps: Step[] = [slice()];
  const more = 1 + Math.floor(r() * 4);
  for (let i = 0; i < more; i++) {
    if (r() < 0.3) steps.push({ k: 'unwrapped', sig: pick() });
    steps.push(slice());
  }
  steps.push({ k: 'end', throws: r() < 0.2 });
  return steps;
}

type Stats = {
  cancelsMidAwait: number;
  closedEnters: number;
  lateUnwrappedLanded: number;
  nested: number;
  windowMisattributed: number;
  foreignAttributedToBoth: number;
  restoresYielded: number;
  completed: number;
  failed: number;
};

type Body = {
  id: Id;
  script: Step[];
  cursor: number;
  opened: boolean;
  ended: boolean;
  returned: boolean;
  cancelled: boolean;
};

const unionOk = (o: Outcome | undefined): boolean =>
  !!o &&
  (o.kind === 'completed' ||
    o.kind === 'failed' ||
    (o.kind === 'aborted' &&
      ['abort', 'superseded', 'destroyed'].includes(o.reason)));

/** Runs one generated interleaving and returns the names of every property it violated. */
function runTrace(
  seed: number,
  opt: Options,
  stats?: Stats,
  onWorld?: (w: World) => void,
): Set<string> {
  const r = mulberry32(seed);
  const w = new World(opt, SIGS);
  onWorld?.(w);
  const bad = new Set<string>();
  const bodies: Body[] = ['A', 'B'].map((id) => ({
    id,
    script: genScript(r),
    cursor: 0,
    opened: false,
    ended: false,
    returned: false,
    cancelled: false,
  }));
  const sliceOf = new Map<number, Id>(); // flight id → body whose slice started it
  const scheduledBy: Id[] = [];
  const sliceSigs = new Map<Id, Set<string>>();
  // value before the body's first owned write, and where in the signal's write order it happened
  const firstPre = new Map<Id, Map<string, { pre: number; at: number }>>();
  const noteFirst = (id: Id, sig: string) => {
    const m = must(firstPre.get(id));
    if (!m.has(sig))
      m.set(sig, {
        pre: must(w.value.get(sig)),
        at: must(w.sigWrites.get(sig)).length,
      });
  };
  const retains: [Id, number][] = [];
  const nested: { into: Id; token: number }[] = [];
  const firstOutcome = new Map<Id, Outcome>();
  let destroyed = false;

  const txn = (id: Id) => must(w.txns.get(id));
  const settled = (id: Id) => w.txns.has(id) && txn(id).status === 'settled';

  const runSlice = (b: Body, ops: SliceOp[]) => {
    const wasSettled = settled(b.id);
    const writesBefore = w.writes.length;
    const flightsBefore = w.flights.length;
    try {
      w.enter(b.id, () => {
        for (const op of ops) {
          if (op.k === 'write') {
            if (!wasSettled) noteFirst(b.id, op.sig);
            w.write(op.sig);
            if (!wasSettled) must(sliceSigs.get(b.id)).add(op.sig);
          } else if (op.k === 'flight') {
            const f = w.startFlight('sync');
            if (!wasSettled) sliceOf.set(f.id, b.id);
          } else if (op.k === 'schedule') scheduledBy.push(b.id);
          else if (op.k === 'nested') {
            nested.push(w.nestedStart());
            if (stats) stats.nested++;
            for (const s of op.sigs) {
              if (!wasSettled) noteFirst(b.id, s);
              w.write(s);
              if (!wasSettled) must(sliceSigs.get(b.id)).add(s);
            }
          } else retains.push([b.id, w.retain(b.id)]);
        }
      });
    } catch (e) {
      if (!(e instanceof ClosedError)) throw e;
      if (stats) stats.closedEnters++;
      if (
        w.writes.length !== writesBefore ||
        w.flights.length !== flightsBefore
      )
        bad.add('P6-closed-enter');
      b.ended = true;
      w.bodyThrow(b.id, e);
      return;
    }
    if (wasSettled) {
      bad.add('P6-closed-enter');
      if (w.writes.length !== writesBefore) bad.add('P12-late-landing');
    }
    for (const rec of w.writes.slice(writesBefore))
      if (
        !wasSettled &&
        (rec.claimers.length !== 1 || rec.claimers[0] !== b.id)
      )
        bad.add('P1-write-exact');
  };

  const checkedEnd = (id: Id, fn: () => void, restoring: boolean) => {
    const t = txn(id);
    const was = t.status;
    const before = new Map(w.value);
    const log = new Map(t.log);
    fn();
    if (was === 'settled' || t.status !== 'settled') return;
    if (!restoring) {
      for (const s of SIGS)
        if (w.value.get(s) !== before.get(s)) bad.add('P4b-committed-survives');
      return;
    }
    for (const s of SIGS) {
      const ours = log.has(s) && w.origin.get(must(before.get(s))) === id;
      const now = must(w.value.get(s));
      if (ours) {
        // its write is gone, replaced by a value the signal really held
        if (w.origin.get(now) === id || !must(w.sigValues.get(s)).has(now))
          bad.add('P4-restore-exact');
        // nobody else wrote it since the body's first write: exactly the pre-value
        const first = must(firstPre.get(id)).get(s);
        const since = must(w.sigWrites.get(s)).slice(first?.at ?? 0);
        if (first && since.every((l) => l === id) && now !== first.pre)
          bad.add('P4-restore-exact');
      }
      if (!ours && w.value.get(s) !== before.get(s))
        bad.add('P4b-committed-survives');
      if (log.has(s) && !ours && stats) stats.restoresYielded++;
    }
  };

  const cancel = (id: Id, reason: Reason) => {
    const midAwait = !settled(id);
    checkedEnd(
      id,
      () => w.cancel(id, reason),
      reason !== 'destroyed' || opt.destroyRestores,
    );
    if (!midAwait) return;
    if (stats) stats.cancelsMidAwait++;
    const t = txn(id);
    if (
      t.status !== 'settled' ||
      w.pending(t) ||
      t.retains.size ||
      t.nested.size
    )
      bad.add('P5-cancel-clean');
  };

  const stepBody = (b: Body) => {
    if (!b.opened) {
      b.opened = true;
      w.open(b.id);
      sliceSigs.set(b.id, new Set());
      firstPre.set(b.id, new Map());
    }
    const step = b.script[b.cursor++];
    if (step.k === 'slice') runSlice(b, step.ops);
    else if (step.k === 'unwrapped') {
      const late = settled(b.id);
      const before = w.value.get(step.sig);
      w.write(step.sig, b.id);
      const rec = w.writes[w.writes.length - 1];
      if (rec.claimers.length) bad.add('P1-write-exact');
      if (late && w.value.get(step.sig) !== before && stats)
        stats.lateUnwrappedLanded++;
    } else {
      b.ended = true;
      if (step.throws) {
        const err = new Error(`body ${b.id} failed`);
        const live = !settled(b.id);
        checkedEnd(b.id, () => w.bodyThrow(b.id, err), true);
        const o = txn(b.id).outcome;
        if (live && (o?.kind !== 'failed' || o.error !== err))
          bad.add('P8-failed');
      } else {
        if (!settled(b.id)) b.returned = true;
        w.bodyReturn(b.id);
      }
    }
    if (b.cursor >= b.script.length) b.ended = true;
  };

  const invariants = () => {
    const open = [...w.txns.values()].filter((t) => t.status !== 'settled');
    if (w.holds !== open.length) bad.add('P10-hold-accounting');
    for (const t of w.txns.values()) {
      if (t.status === 'settled') {
        const first = firstOutcome.get(t.id);
        if (!first) {
          firstOutcome.set(t.id, must(t.outcome));
          const b = must(bodies.find((x) => x.id === t.id));
          if (t.outcome?.kind === 'completed') {
            const heldBy =
              retains.some(([id]) => id === t.id) ||
              nested.some((n) => n.into === t.id) ||
              w.flights.some(
                (f) =>
                  !f.settled &&
                  f.at >= t.openedAt &&
                  (sliceOf.get(f.id) ?? t.id) === t.id,
              );
            if (!b.returned || heldBy) bad.add('P10-completion');
          }
        } else if (first !== t.outcome) bad.add('P12-late-landing');
        if (t.resolutions !== 1) bad.add('P9-done-once');
        if (w.pending(t) || t.retains.size) bad.add('P5-cancel-clean');
        continue;
      }
      const keys = [...t.log.keys()].sort().join();
      if (keys !== [...must(sliceSigs.get(t.id))].sort().join())
        bad.add('P7-recorded-set');
    }
    for (const f of w.flights) {
      if (f.settled) continue;
      const by = sliceOf.get(f.id);
      for (const t of open) {
        const got = w.attributed(t, f);
        const inWindow = f.at >= t.openedAt;
        if (by !== undefined) {
          if (got !== (t.id === by)) bad.add('P2-flight-exact');
        } else if (got !== inWindow) bad.add('P3-window');
      }
    }
  };

  const actions: (() => boolean)[] = [
    () => {
      const ready = bodies.filter((b) => !b.ended);
      if (!ready.length) return false;
      stepBody(ready[Math.floor(r() * ready.length)]);
      return true;
    },
    () => (w.write(SIGS[Math.floor(r() * SIGS.length)]), true),
    () => {
      const f = w.startFlight('foreign');
      const open = [...w.txns.values()].filter((t) => w.attributed(t, f));
      if (open.length === 2 && stats) stats.foreignAttributedToBoth++;
      return true;
    },
    () => {
      const live = w.flights.filter((f) => !f.settled);
      if (!live.length) return false;
      w.settleFlight(live[Math.floor(r() * live.length)]);
      return true;
    },
    () => {
      const by = scheduledBy.shift();
      if (by === undefined) return false;
      const f = w.startFlight('scheduled');
      const other = [...w.txns.values()].some(
        (t) => t.id !== by && w.attributed(t, f),
      );
      if (other && stats) stats.windowMisattributed++;
      return true;
    },
    () => {
      const x = retains.shift();
      if (!x) return false;
      w.release(...x);
      return true;
    },
    () => {
      const x = nested.shift();
      if (!x) return false;
      w.nestedSettle(x.into, x.token);
      return true;
    },
  ];

  for (let turn = 0; turn < 200; turn++) {
    const x = r();
    const openBodies = bodies.filter(
      (b) => b.opened && !settled(b.id) && !b.cancelled,
    );
    if (x < 0.05 && openBodies.length) {
      const b = openBodies[Math.floor(r() * openBodies.length)];
      b.cancelled = true;
      cancel(b.id, r() < 0.5 ? 'abort' : 'superseded');
    } else if (
      x < 0.06 &&
      !destroyed &&
      openBodies.length &&
      bodies.every((b) => b.opened)
    ) {
      destroyed = true;
      for (const t of [...w.txns.values()]) cancel(t.id, 'destroyed');
    } else {
      const order = [0, 0, 0, 1, 2, 3, 3, 4, 5, 6];
      const start = Math.floor(r() * order.length);
      for (let i = 0; i < order.length; i++)
        if (actions[order[(start + i) % order.length]]()) break;
    }
    invariants();
    if (bodies.every((b) => b.ended) && !scheduledBy.length) break;
  }
  // drain: finish both scripts, start what was scheduled, settle and release everything
  for (const b of bodies)
    while (!b.ended) {
      stepBody(b);
      invariants();
    }
  while (actions.slice(3).some((a) => a())) invariants();
  invariants();

  for (const t of w.txns.values()) {
    if (t.status !== 'settled') bad.add('P11-liveness');
    if (!unionOk(t.outcome)) bad.add('P9-outcome-union');
    if (t.resolutions !== 1) bad.add('P9-done-once');
    if (stats && t.outcome?.kind === 'completed') stats.completed++;
    if (stats && t.outcome?.kind === 'failed') stats.failed++;
  }
  if (w.holds !== 0) bad.add('P10-hold-accounting');
  return bad;
}

const SEEDS = 600;
const emptyStats = (): Stats => ({
  cancelsMidAwait: 0,
  closedEnters: 0,
  lateUnwrappedLanded: 0,
  nested: 0,
  windowMisattributed: 0,
  foreignAttributedToBoth: 0,
  restoresYielded: 0,
  completed: 0,
  failed: 0,
});

function violations(opt: Options, stats?: Stats): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let seed = 1; seed <= SEEDS; seed++)
    for (const v of runTrace(seed, opt, stats))
      out.set(v, [...(out.get(v) ?? []), seed]);
  return out;
}

describe('PROOF: async transaction model, generated interleavings of two bodies plus foreign writers', () => {
  for (const destroyRestores of [true, false]) {
    it(`every property holds over ${SEEDS} seeds (destroy ${destroyRestores ? 'restores' : 'keeps writes'})`, () => {
      const stats = emptyStats();
      const v = violations({ ...REFERENCE, destroyRestores }, stats);
      expect(Object.fromEntries(v)).toEqual({});
      // the generator reaches every edge the properties talk about
      for (const [k, n] of Object.entries(stats))
        expect(n, k).toBeGreaterThan(0);
    });
  }
});

describe('KILLED alternatives: each breaks the property it would weaken', () => {
  it('zone-style "everything during the await window belongs to the body" cross-attributes under two overlapping bodies', () => {
    const v = violations({ ...REFERENCE, attribution: 'zone' });
    expect(v.has('P1-write-exact')).toBe(true);
    expect(v.has('P2-flight-exact')).toBe(true);
  });
  it('window-only attribution for in-slice kickoffs attributes them to the overlapping transaction too', () => {
    const v = violations({ ...REFERENCE, attribution: 'window-only' });
    expect(v.has('P2-flight-exact')).toBe(true);
    expect(v.has('P1-write-exact')).toBe(false);
  });
  it('blind restore destroys a later writer on abort', () => {
    const v = violations({ ...REFERENCE, restore: 'blind' });
    expect(v.has('P4b-committed-survives')).toBe(true);
  });
  it('a cancel that waits for attributed pending keeps the hold open after supersede', () => {
    const v = violations({ ...REFERENCE, cancel: 'wait-pending' });
    expect(v.has('P5-cancel-clean')).toBe(true);
  });
  it('enter that runs on a closed transaction lets a late continuation land writes', () => {
    const v = violations({ ...REFERENCE, closedEnter: 'run' });
    expect(v.has('P6-closed-enter')).toBe(true);
    expect(v.has('P12-late-landing')).toBe(true);
  });
});

describe('PINS: async transaction model', () => {
  const world = (opt: Partial<Options> = {}) =>
    new World({ ...REFERENCE, ...opt }, SIGS);
  const init = (w: World) => new Map(w.value);

  it('a write in slice 3 is attributed to the body and restored on abort', () => {
    const w = world();
    const v0 = init(w);
    w.open('A');
    w.enter('A', () => w.write('s0'));
    w.enter('A', () => w.write('s1'));
    w.write('s3'); // foreign, between slices
    w.enter('A', () => w.write('s2'));
    expect(w.writes.map((x) => x.claimers)).toEqual([['A'], ['A'], [], ['A']]);
    expect([...must(w.txns.get('A')).log.keys()]).toEqual(['s0', 's1', 's2']);
    const foreign = w.value.get('s3');
    w.cancel('A', 'abort');
    for (const s of ['s0', 's1', 's2']) expect(w.value.get(s)).toBe(v0.get(s));
    expect(w.value.get('s3')).toBe(foreign);
    expect(must(w.txns.get('A')).outcome).toEqual({
      kind: 'aborted',
      reason: 'abort',
    });
  });

  it('a write after an await without enter loses ownership, never the hold', () => {
    const w = world();
    const t = w.open('A');
    w.enter('A', () => w.write('s0'));
    w.write('s1', 'A'); // forgot enter
    expect(w.writes[1].claimers).toEqual([]);
    expect(w.origin.get(must(w.value.get('s1')))).toBe('unowned:A');
    expect(t.status).toBe('running');
    expect(w.holds).toBe(1);
    const unowned = w.value.get('s1');
    w.cancel('A', 'abort');
    expect(w.value.get('s1')).toBe(unowned);
  });

  it('two interleaved bodies never cross-attribute writes or in-slice kickoffs', () => {
    const w = world();
    const A = w.open('A');
    const B = w.open('B');
    let fa!: Flight, fb!: Flight;
    w.enter('A', () => (w.write('s0'), (fa = w.startFlight('sync'))));
    w.enter('B', () => (w.write('s1'), (fb = w.startFlight('sync'))));
    w.enter('A', () => w.write('s2'));
    expect(w.writes.map((x) => x.claimers)).toEqual([['A'], ['B'], ['A']]);
    expect([w.attributed(A, fa), w.attributed(B, fa)]).toEqual([true, false]);
    expect([w.attributed(A, fb), w.attributed(B, fb)]).toEqual([false, true]);
    expect([...A.log.keys()]).toEqual(['s0', 's2']);
    expect([...B.log.keys()]).toEqual(['s1']);
  });

  it('KILLED: the zone-style await window cross-attributes the same scenario', () => {
    const w = world({ attribution: 'zone' });
    const A = w.open('A');
    const B = w.open('B');
    let fa!: Flight;
    w.enter('A', () => (w.write('s0'), (fa = w.startFlight('sync'))));
    w.enter('B', () => w.write('s1'));
    expect(w.writes.map((x) => x.claimers)).toEqual([
      ['A', 'B'],
      ['A', 'B'],
    ]);
    expect(w.attributed(B, fa)).toBe(true);
    expect([...A.log.keys()]).toEqual(['s0', 's1']);
  });

  it('enter after close throws before the slice runs, for every way of closing', () => {
    const closeWays: ((w: World) => void)[] = [
      (w) => w.cancel('A', 'abort'),
      (w) => w.cancel('A', 'superseded'),
      (w) => w.destroy(),
      (w) => w.bodyThrow('A', new Error('x')),
      (w) => w.bodyReturn('A'),
    ];
    for (const close of closeWays) {
      const w = world();
      w.open('A');
      close(w);
      expect(must(w.txns.get('A')).status).toBe('settled');
      let ran = false;
      expect(() => w.enter('A', () => (ran = true))).toThrow(ClosedError);
      expect(ran).toBe(false);
      expect(() => w.retain('A')).toThrow(ClosedError);
    }
  });

  it('enter after the body returned but before settlement is allowed (retained work)', () => {
    const w = world();
    const t = w.open('A');
    const r = w.retain('A');
    w.bodyReturn('A');
    expect(t.status).toBe('returned');
    w.enter('A', () => w.write('s0'));
    expect(w.writes[0].claimers).toEqual(['A']);
    w.release('A', r);
    expect(t.outcome).toEqual({ kind: 'completed' });
  });

  it('LIMIT: an unwrapped write by a continuation outliving its cancelled transaction lands', () => {
    const w = world();
    w.open('A');
    w.enter('A', () => w.write('s0'));
    w.cancel('A', 'superseded');
    const restored = w.value.get('s0');
    w.write('s0', 'A'); // the awaited promise lands and the body writes without enter
    expect(w.value.get('s0')).not.toBe(restored);
    expect(w.origin.get(must(w.value.get('s0')))).toBe('unowned:A');
    expect(must(w.txns.get('A')).outcome).toEqual({
      kind: 'aborted',
      reason: 'superseded',
    });
  });

  it('EXTENT: a kickoff scheduled after a slice is window-attributed, so an overlapping transaction claims it too', () => {
    const w = world();
    const A = w.open('A');
    const B = w.open('B');
    w.enter('A', () => w.write('s0')); // the write schedules a load that starts after the slice
    const late = w.startFlight('scheduled');
    expect([w.attributed(A, late), w.attributed(B, late)]).toEqual([
      true,
      true,
    ]);
    w.bodyReturn('B');
    expect(B.status).toBe('returned'); // B now waits on A's load
    w.settleFlight(late);
    expect(B.outcome).toEqual({ kind: 'completed' });
  });

  it('EXTENT: a foreign kickoff between slices is attributed to every open transaction, never to one opened after it or already in flight', () => {
    const w = world();
    const early = w.startFlight('foreign');
    const A = w.open('A');
    const between = w.startFlight('foreign');
    const B = w.open('B');
    expect([w.attributed(A, early), w.attributed(B, early)]).toEqual([
      false,
      false,
    ]);
    expect([w.attributed(A, between), w.attributed(B, between)]).toEqual([
      true,
      false,
    ]);
    const both = w.startFlight('foreign');
    expect([w.attributed(A, both), w.attributed(B, both)]).toEqual([
      true,
      true,
    ]);
  });

  it('supersede mid-await: no hold, no pending, no retain; the later landing is ignored', () => {
    const w = world();
    const t = w.open('A');
    w.enter('A', () => {
      w.write('s0');
      w.startFlight('sync');
      w.retain('A');
    });
    expect([w.pending(t), t.retains.size, w.holds]).toEqual([true, 1, 1]);
    w.cancel('A', 'superseded');
    expect([w.pending(t), t.retains.size, t.nested.size, w.holds]).toEqual([
      false,
      0,
      0,
      0,
    ]);
    const outcome = t.outcome;
    const values = new Map(w.value);
    w.bodyReturn('A');
    w.bodyThrow('A', new Error('late'));
    expect(() => w.enter('A', () => w.write('s1'))).toThrow(ClosedError);
    expect(t.outcome).toBe(outcome);
    expect(t.resolutions).toBe(1);
    expect(w.value).toEqual(values);
  });

  it('body rejection restores and settles failed with the same error', () => {
    const w = world();
    const v0 = init(w);
    const t = w.open('A');
    w.enter('A', () => (w.write('s0'), w.write('s1')));
    const err = new Error('boom');
    w.bodyThrow('A', err);
    expect(t.outcome).toEqual({ kind: 'failed', error: err });
    expect((t.outcome as { error: unknown }).error).toBe(err);
    expect([w.value.get('s0'), w.value.get('s1')]).toEqual([
      v0.get('s0'),
      v0.get('s1'),
    ]);
    expect(w.holds).toBe(0);
  });

  it('a nested startTransaction inside a slice merges into the outer: same identity, composed hold', () => {
    const w = world();
    const v0 = init(w);
    const t = w.open('A');
    let n!: { into: Id; token: number };
    w.enter('A', () => {
      n = w.nestedStart();
      w.write('s0');
    });
    expect(n.into).toBe('A');
    expect(w.writes[0].claimers).toEqual(['A']);
    expect(w.ownerOf('s0')).toBe('A');
    w.bodyReturn('A');
    expect(t.status).toBe('returned'); // the nested one still holds the outer
    w.nestedSettle(n.into, n.token);
    expect(t.outcome).toEqual({ kind: 'completed' });

    const w2 = world();
    w2.open('A');
    w2.enter('A', () => (w2.nestedStart(), w2.write('s1')));
    w2.cancel('A', 'abort');
    expect(w2.value.get('s1')).toBe(v0.get('s1'));
  });

  it('abort yields to a later writer and restores through a chain of aborts', () => {
    const w = world();
    const v0 = init(w);
    w.open('A');
    w.open('B');
    w.enter('A', () => w.write('s0'));
    w.enter('B', () => w.write('s0'));
    const bs = w.value.get('s0');
    w.bodyReturn('B');
    expect(must(w.txns.get('B')).outcome).toEqual({ kind: 'completed' });
    w.cancel('A', 'abort');
    expect(w.value.get('s0')).toBe(bs);

    const w2 = world();
    w2.open('A');
    w2.open('B');
    w2.enter('A', () => w2.write('s0'));
    w2.enter('B', () => w2.write('s0'));
    w2.cancel('B', 'abort'); // hands s0 back to A
    expect(w2.ownerOf('s0')).toBe('A');
    w2.cancel('A', 'abort');
    expect(w2.value.get('s0')).toBe(v0.get('s0'));
  });

  it('INHERITED: an aborted writer that yielded can come back when the writer above it aborts', () => {
    const w = world();
    w.open('A');
    w.open('B');
    w.enter('B', () => w.write('s0'));
    const bs = w.value.get('s0');
    w.enter('A', () => w.write('s0')); // A's undo entry points at B's value
    w.cancel('B', 'abort'); // yields: A took over
    w.cancel('A', 'abort'); // restores A's pre, which is B's aborted write
    expect(w.value.get('s0')).toBe(bs);
    expect(w.origin.get(must(w.value.get('s0')))).toBe('B');
  });

  it('completion waits for attributed pending and retains, never for a load already in flight', () => {
    const w = world();
    const old = w.startFlight('foreign');
    const t = w.open('A');
    let f!: Flight;
    let r = 0;
    w.enter('A', () => ((f = w.startFlight('sync')), (r = w.retain('A'))));
    w.bodyReturn('A');
    w.settleFlight(f);
    expect(t.status).toBe('returned');
    w.release('A', r);
    w.release('A', r); // release is idempotent
    expect(t.outcome).toEqual({ kind: 'completed' });
    expect(old.settled).toBe(false);
  });

  it('destroy settles every open transaction as aborted with reason destroyed', () => {
    const w = world();
    w.open('A');
    w.open('B');
    w.retain('B');
    w.bodyReturn('B'); // returned, still held by retained work
    w.destroy();
    for (const id of ['A', 'B'])
      expect(must(w.txns.get(id)).outcome).toEqual({
        kind: 'aborted',
        reason: 'destroyed',
      });
    expect(w.holds).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Re-pointed: the model's traces replayed against the real implementation.
// ────────────────────────────────────────────────────────────────────────────

type Gate = { resolve(): void; reject(e: unknown): void };
const gate = (into: Map<unknown, Gate>, key: unknown) =>
  new Promise<void>((resolve, reject) => into.set(key, { resolve, reject }));

function fakeFlight(): ResourceLike & {
  status: WritableSignal<ResourceStatus>;
} {
  const status = signal<ResourceStatus>('loading');
  return {
    status,
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => true,
    loads: signal(1),
  };
}

const outcomeName = (o: TransactionOutcome | undefined): string =>
  !o ? 'none' : o.kind === 'aborted' ? `aborted:${o.reason}` : o.kind;

/** The real ledger drops a transaction's claims when it settles. */
const AS_BUILT: Options = { ...REFERENCE, claims: 'released' };

/** Replays one seed; returns every step where the real state differs from the model's. */
async function replay(seed: number): Promise<string[]> {
  let model!: World;
  runTrace(seed, REFERENCE, undefined, (x) => {
    x.recording = true;
    model = x;
  });
  const init = new World(REFERENCE, SIGS).value;
  const diffs: string[] = [];

  const root = TestBed.inject(EnvironmentInjector);
  const parent = createEnvironmentInjector([provideTransitionScope()], root);
  const scope = runInInjectionContext(parent, injectTransitionScope);
  const kids = new Map<Id, EnvironmentInjector>();
  const start = new Map<Id, ReturnType<typeof injectStartTransaction>>();
  for (const id of ['A', 'B']) {
    const env = createEnvironmentInjector([], parent);
    kids.set(id, env);
    start.set(id, runInInjectionContext(env, injectStartTransaction));
  }

  const raw = new Map<string, WritableSignal<unknown>>();
  const names = new Map<unknown, string>();
  const writers = new Map<string, WritableSignal<unknown>>();
  for (const s of SIGS) {
    const sig = signal<unknown>(init.get(s));
    raw.set(s, sig);
    names.set(sig, s);
    writers.set(s, transactional(sig));
  }
  const flights = new Map<number, ReturnType<typeof fakeFlight>>();
  const txs = new Map<Id, Transaction>();
  const refs = new Map<Id, AsyncTransactionRef>();
  const trackers = new Map<Id, Signal<boolean>>();
  const outcomes = new Map<Id, TransactionOutcome>();
  const bodies = new Map<unknown, Gate>();
  const nestedGates = new Map<unknown, Gate>();
  const releases = new Map<number, () => void>();

  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      TestBed.tick();
    }
  };

  const startFlight = (fid: number) => {
    const f = fakeFlight();
    flights.set(fid, f);
    scope.add(f, { suspends: false });
  };

  // one step inside a slice; the recorder is the slice's transaction
  const inner = (e: Ev) => {
    if (e.k === 'write') must(writers.get(e.sig)).set(e.value);
    else if (e.k === 'flight') startFlight(e.fid);
    else if (e.k === 'retain')
      releases.set(e.rid, must(txs.get(e.id)).retain());
    else if (e.k === 'nested')
      must(start.get(e.into))(() => gate(nestedGates, e.token));
    else throw new Error(`replay: ${e.k} inside a slice`);
  };

  const events = model.events;
  for (let i = 0; i < events.length; i++) {
    const { e } = events[i];
    let slice: Ev[] = [];
    if (e.k === 'open' || e.k === 'enter') {
      // gather the slice the model ran (open is always followed by the prefix slice)
      let j = e.k === 'open' ? i + 2 : i + 1;
      while (events[j].e.k !== 'exit') slice.push(events[j++].e);
      if (e.k === 'open') {
        const id = e.id;
        const ref = must(start.get(id))(async (tx) => {
          txs.set(id, tx);
          trackers.set(id, createAttributedPending(scope, tx));
          slice.forEach(inner);
          await gate(bodies, id);
        });
        refs.set(id, ref);
        void ref.done.then((o) => outcomes.set(id, o));
      } else {
        const ids = slice;
        must(txs.get(e.id)).enter(() => ids.forEach(inner));
      }
      i = j;
      slice = [];
    } else if (e.k === 'enterClosed') {
      let threw = false;
      try {
        must(txs.get(e.id)).enter(() => undefined);
      } catch {
        threw = true;
      }
      if (!threw) diffs.push(`#${i} enter on a closed transaction ran`);
    } else if (e.k === 'write') must(writers.get(e.sig)).set(e.value);
    else if (e.k === 'flight') startFlight(e.fid);
    else if (e.k === 'settle') must(flights.get(e.fid)).status.set('resolved');
    else if (e.k === 'release') must(releases.get(e.rid))();
    else if (e.k === 'nestedSettle') must(nestedGates.get(e.token)).resolve();
    else if (e.k === 'return') must(bodies.get(e.id)).resolve();
    else if (e.k === 'throw') must(bodies.get(e.id)).reject(new Error(e.id));
    else if (e.k === 'cancel') {
      const ref = must(refs.get(e.id));
      if (e.reason === 'abort') ref.abort();
      else if (e.reason === 'superseded') abortTransaction(ref, 'superseded');
      else must(kids.get(e.id)).destroy();
    } else throw new Error(`replay: unexpected ${e.k}`);

    const snap = events[i].snap;
    if (!snap) continue;
    await flush();
    for (const s of SIGS)
      if (must(raw.get(s))() !== snap.values[s])
        diffs.push(
          `#${i} ${e.k}: ${s} real ${must(raw.get(s))()} model ${snap.values[s]}`,
        );
    if (scope.holding() !== snap.holding)
      diffs.push(
        `#${i} ${e.k}: holding real ${scope.holding()} model ${snap.holding}`,
      );
    for (const [id, m] of Object.entries(snap.txns)) {
      const ref = must(refs.get(id));
      if (ref.pending() === m.settled)
        diffs.push(
          `#${i} ${e.k}: ${id} settled real ${!ref.pending()} model ${m.settled}`,
        );
      if (m.settled) {
        if (outcomeName(outcomes.get(id)) !== m.outcome)
          diffs.push(
            `#${i} ${e.k}: ${id} outcome real ${outcomeName(outcomes.get(id))} model ${m.outcome}`,
          );
        continue;
      }
      const attributed = must(trackers.get(id))();
      if (attributed !== m.pending)
        diffs.push(
          `#${i} ${e.k}: ${id} attributed real ${attributed} model ${m.pending}`,
        );
      const log = [
        ...new Set(
          must(txs.get(id))
            .entries()
            .map((x) => names.get(x.target)),
        ),
      ]
        .sort()
        .join();
      if (log !== m.log)
        diffs.push(`#${i} ${e.k}: ${id} log real [${log}] model [${m.log}]`);
    }
  }
  parent.destroy();
  return diffs;
}

describe('RE-POINTED: model traces replayed against the real startTransaction', () => {
  it('KILLED (model): releasing claims at settlement window-attributes an in-flight in-slice kickoff to the other transaction; the real ledger keeps them under a settled owner', () => {
    const v = violations(AS_BUILT);
    expect([...v.keys()]).toEqual(['P2-flight-exact']);
  });

  it('every step of 120 generated traces matches the model (values, attribution, logs, hold, outcomes)', async () => {
    const all: string[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const d = await replay(seed);
      if (d.length) all.push(`seed ${seed}: ${d.slice(0, 3).join(' | ')}`);
    }
    expect(all).toEqual([]);
  });
});
