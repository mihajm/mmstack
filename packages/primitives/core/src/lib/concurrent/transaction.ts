// inspired by SolidJS 2.0's action slice re-entry — https://github.com/solidjs/solid
import { isServer } from '../platform';
import {
  afterNextRender,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { isMutable } from '../mutable';
import {
  currentRecorder,
  recordWrite,
  swapRecorder,
} from './active-transaction';
import { isStore } from '../store/internals';
import { recordHoldEntry } from './hold-seed';
import { bindAbort } from './transaction-driver';
import { LAY_GUESS, OPEN_OVERLAY } from './optimistic-seam';
import type { Guessable } from './optimistic';
import type { Optimistic } from './optimistic-overlay';
import type { OptimisticStore } from '../store/optimistic-store';
import type { WritableSignalStore } from '../store/types';

export { transactional } from './active-transaction';
import {
  claimLoads,
  createAttributedPending,
  injectTransitionScope,
  releaseClaims,
  snapshotLoads,
} from './transition-scope';

/**
 * `'authoritative'` is an ordinary write. `'guess'` marks an optimistic write: it gets its own log
 * entry and generation, never shared with an authoritative write to the same signal.
 */
export type TransactionEntryKind = 'authoritative' | 'guess';

export type RecordOptions = {
  /** Defaults to `'authoritative'`. */
  readonly kind?: TransactionEntryKind;
  /**
   * Undo for structured values. On abort the signal is set to `reconcile(mine, current, pre)`, where
   * `mine` is the value this entry produced and `pre` the value before it, so paths another writer
   * changed since are kept. Without it a signal is restored to `pre` only when the transaction still
   * owns it and its value is still `mine`.
   */
  readonly reconcile?: (
    mine: unknown,
    current: unknown,
    pre: unknown,
  ) => unknown;
};

/** One undo log entry, as exposed for inspection. */
export type TransactionEntry = {
  readonly target: WritableSignal<unknown>;
  readonly kind: TransactionEntryKind;
  /** Per-transaction, increasing; a fresh one for every entry. */
  readonly generation: number;
};

/**
 * An undo log with ownership. Writes made while the transaction is active record their target
 * first; `restore()` undoes them (abort), `clear()` keeps them (commit: they already landed live).
 *
 * Abort removes this transaction's effect where it is still in effect and yields where a later
 * writer took over: a signal another writer recorded after this one, or set to another value since,
 * keeps that value. Abort preserves later writers' values, not invariants across signals (a value
 * computed from one this transaction wrote stays as computed).
 *
 * Rollback covers only recorded writes. Nothing is intercepted.
 */
export type Transaction = {
  /**
   * Record a signal before writing it (any write: `set`, `update`, `mutate`). Repeated calls in one
   * slice are one entry. A no-op once the transaction is closed, so the write lands unrecorded.
   *
   * A plain signal's pre-value is kept by reference. A mutable signal is snapshotted with
   * `structuredClone`, so an in-place write cannot reach the recorded value; its value must be plain
   * data that survives a structured clone (class instances come back as plain objects, functions or
   * signals throw).
   */
  record(sig: WritableSignal<unknown>, opt?: RecordOptions): void;
  /** Undo the recorded writes that are still in effect, newest first, and close (abort). */
  restore(): void;
  /** Drop the log, keeping live writes, and close (commit). */
  clear(): void;
  /**
   * Run a synchronous slice with this transaction active: writes inside record into this log. Use it
   * to re-enter after an `await`. Nested `enter` calls are fine. Throws once the transaction is closed.
   */
  enter<R>(fn: () => R): R;
  /**
   * Write `target` as part of this transaction, before or after any `await`: the write is recorded
   * here, so `restore()` undoes it, whether `target` is a plain signal, a `transactional` one, a
   * store node or a guessable (where it resolves this transaction's guess to the written value).
   * The same as `enter(() => target.set(value))`, except that a plain signal is recorded too.
   * Throws once the transaction is closed.
   */
  set<T>(target: WritableSignal<T>, value: T): void;
  /** {@link Transaction.set} with an updater applied to the current value. */
  update<T>(target: WritableSignal<T>, fn: (value: T) => T): void;
  /**
   * Keep the transaction open: its display hold and its `done` wait until every release function
   * has been called. Releasing twice is harmless. Throws once the transaction is closed.
   */
  retain(): () => void;
  /** How many retains are open. */
  readonly retained: Signal<number>;
  /** True after `restore()` or `clear()`. */
  readonly closed: boolean;
  /** The current log, oldest first. */
  entries(): readonly TransactionEntry[];
  /**
   * Lay an optimistic guess on a {@link Guessable} node, owned by this transaction. Every reader of
   * the node sees it until an authoritative write lands on the node or this transaction settles,
   * however it settles. It never enters the undo log as a value. Throws once the transaction is
   * closed.
   */
  guess<T>(node: Guessable<T>, value: T): void;
  /**
   * This transaction's fork of an optimistic overlay: write guesses into it. Readers of the overlay
   * see them, readers of its base never do. The fork is discarded when this transaction settles,
   * never written to the base. Repeated calls return the same fork. Throws once the transaction is
   * closed.
   */
  overlay<T extends Record<string, any>>(
    target: OptimisticStore<T>,
  ): WritableSignalStore<T>;
  overlay<T>(target: Optimistic<T>): WritableSignal<T>;
};

type Entry = {
  readonly txn: Transaction;
  readonly target: WritableSignal<unknown>;
  readonly kind: TransactionEntryKind;
  readonly generation: number;
  readonly reconcile: RecordOptions['reconcile'];
  pre: unknown;
  mine: unknown;
  open: boolean;
  prev: Entry | undefined;
};

/** Open order of every transaction (and of forks opened outside one), shared by all. */
let openSeq = 0;
const openOrders = new WeakMap<Transaction, number>();
const closeHooks = new WeakMap<Transaction, (() => void)[]>();

/** @internal The next open order, for an overlay fork opened outside a transaction. */
export function nextOpenOrder(): number {
  return ++openSeq;
}

/** @internal When `txn` was opened relative to every other transaction. */
export function openOrderOf(txn: Transaction): number {
  return openOrders.get(txn) ?? 0;
}

/** @internal Run `fn` once when `txn` closes (after its undo pass, on commit and abort alike). */
export function onTransactionClose(txn: Transaction, fn: () => void): void {
  if (txn.closed) return fn();
  let list = closeHooks.get(txn);
  if (!list) closeHooks.set(txn, (list = []));
  list.push(fn);
}

/** The entry that last recorded each signal: the writer that owns its current value. */
const owners = new WeakMap<WritableSignal<unknown>, Entry>();

/** A deep copy of a mutable signal's value, so its in-place writes cannot reach the rollback point. */
function snapshot(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name !== 'DataCloneError') throw e;
    throw new Error(
      'transaction: a mutable signal holding a value that cannot be cloned cannot be recorded for rollback; hold plain data or write it through a plain signal',
      { cause: e },
    );
  }
}

function finalize(e: Entry): void {
  if (!e.open) return;
  e.open = false;
  e.mine = untracked(e.target);
}

function handBack(e: Entry): void {
  if (e.prev) owners.set(e.target, e.prev);
  else owners.delete(e.target);
}

/** One atomic compare-and-restore. */
function undo(e: Entry): void {
  const cur = untracked(e.target);
  const owned = owners.get(e.target) === e;
  if (e.reconcile) {
    const next = e.reconcile(e.mine, cur, e.pre);
    if (!Object.is(next, cur)) e.target.set(next);
  } else if (owned && Object.is(cur, e.mine)) {
    e.target.set(e.pre);
  }
  if (owned) handBack(e);
}

/** Runs before a transaction's outermost slice; the function it returns runs after it. */
type SliceWatcher = () => () => void;
const sliceWatchers = new WeakMap<Transaction, SliceWatcher>();

function watchSlices(txn: Transaction, watcher: SliceWatcher): void {
  sliceWatchers.set(txn, watcher);
}

/** The transaction in effect right now, or `null`. Stateful writers consult this to record undo. */
export function activeTransaction(): Transaction | null {
  return currentRecorder() as Transaction | null;
}

/**
 * Record a target written through `tx.set` / `tx.update` when nothing else would: a store node
 * records at its root, and `recordWrite` already skips signals that record themselves
 * (`transactional`, guessables), so only a plain signal is recorded here.
 */
function recordPlain(target: WritableSignal<unknown>): void {
  if (!isStore(target)) recordWrite(target);
}

export function createTransaction(): Transaction {
  let log: Entry[] = [];
  let generation = 0;
  let depth = 0;
  let closed = false;
  const retained = signal(0);

  const close = (undoAll: boolean) => {
    if (closed) return;
    closed = true;
    untracked(() => {
      for (const e of log) finalize(e);
      if (undoAll) for (let i = log.length - 1; i >= 0; i--) undo(log[i]);
    });
    // closed entries are inert: drop their links so a long-lived signal holds no history
    for (const e of log) {
      e.prev = undefined;
      e.pre = e.mine = undefined;
    }
    log = [];
    const hooks = closeHooks.get(txn);
    closeHooks.delete(txn);
    if (hooks) untracked(() => hooks.forEach((fn) => fn()));
  };

  const txn: Transaction = {
    record: (sig, opt) => {
      if (closed) return;
      const kind = opt?.kind ?? 'authoritative';
      const cur = owners.get(sig);
      if (cur && cur.txn === txn && cur.open && cur.kind === kind) return;
      if (cur) finalize(cur);
      const pre = untracked(sig);
      const e: Entry = {
        txn,
        target: sig,
        kind,
        generation: ++generation,
        reconcile: opt?.reconcile,
        pre: isMutable(sig) ? snapshot(pre) : pre,
        mine: undefined,
        open: true,
        prev: cur,
      };
      log.push(e);
      owners.set(sig, e);
      // a view mounted under a hold starts from the pre of the first entry since that hold began
      recordHoldEntry(sig, e.pre);
    },
    restore: () => close(true),
    clear: () => close(false),
    enter: <R>(fn: () => R): R => {
      if (closed)
        throw new Error('transaction: enter() on a closed transaction');
      const after = depth === 0 ? sliceWatchers.get(txn)?.() : undefined;
      const prev = swapRecorder(txn);
      depth++;
      try {
        return untracked(fn);
      } finally {
        swapRecorder(prev);
        if (--depth === 0) {
          for (const e of log) finalize(e);
          after?.();
        }
      }
    },
    set: (target, value) =>
      txn.enter(() => {
        recordPlain(target);
        target.set(value);
      }),
    update: (target, fn) =>
      txn.enter(() => {
        recordPlain(target);
        target.update(fn);
      }),
    retain: () => {
      if (closed)
        throw new Error('transaction: retain() on a closed transaction');
      retained.update((n) => n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.update((n) => n - 1);
      };
    },
    retained: retained.asReadonly(),
    get closed() {
      return closed;
    },
    entries: () =>
      log.map(({ target, kind, generation }) => ({ target, kind, generation })),
    guess: (node, value) => {
      if (closed)
        throw new Error('transaction: guess() on a closed transaction');
      const lay = (node as { [LAY_GUESS]?: unknown })[LAY_GUESS];
      if (typeof lay !== 'function')
        throw new TypeError('transaction: guess() needs a guessable node');
      lay(txn, value);
    },
    overlay: ((target: object) => {
      if (closed)
        throw new Error('transaction: overlay() on a closed transaction');
      const open = (target as { [OPEN_OVERLAY]?: unknown })[OPEN_OVERLAY];
      if (typeof open !== 'function')
        throw new TypeError(
          'transaction: overlay() needs an optimistic overlay',
        );
      return open(txn);
    }) as Transaction['overlay'],
  };
  openOrders.set(txn, ++openSeq);
  return txn;
}

/** Handle for an in-progress transaction (Tier 3): the transaction's own `pending`/`done`
 * (loads already in flight at start are not attributed to it), plus `abort`. */
export type TransactionRef = {
  readonly pending: Signal<boolean>;
  /** Resolves when the transaction settles: committed, aborted, or its context destroyed. */
  readonly done: Promise<void>;
  /** Roll back the recorded writes and release the hold without committing. */
  abort(): void;
};

/** Why a transaction was aborted. `'abort'` is a call to `abort()`; `'destroyed'` its context ended. */
export type TransactionAbortReason = 'abort' | 'superseded' | 'destroyed';

/** How an async transaction settled. */
export type TransactionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly reason: TransactionAbortReason }
  | { readonly kind: 'failed'; readonly error: unknown };

/** Handle for a transaction whose body is async. */
export type AsyncTransactionRef = {
  /** True until the transaction settles. */
  readonly pending: Signal<boolean>;
  /** Resolves with how the transaction settled. Never rejects. */
  readonly done: Promise<TransactionOutcome>;
  /** Undo the recorded writes still in effect, release the hold and settle as aborted. */
  abort(): void;
};

/** A `startTransaction` function: an async body gets an {@link AsyncTransactionRef}. */
export type StartTransaction = {
  (fn: (tx: Transaction) => PromiseLike<unknown>): AsyncTransactionRef;
  (fn: (tx: Transaction) => void): TransactionRef;
};

type Controller = {
  readonly pending: Signal<boolean>;
  readonly outcome: Promise<TransactionOutcome>;
  abort(reason: TransactionAbortReason): void;
  fail(error: unknown): void;
};

/** The transactions `startTransaction` opened, so a nested call can join its outer one. */
const controllers = new WeakMap<Transaction, Controller>();

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  (typeof v === 'object' || typeof v === 'function') &&
  typeof (v as { then?: unknown }).then === 'function';

/** A nested call inside a slice merges into the outer transaction: one log, one hold, one outcome. */
function joinOuter(
  outer: Transaction,
  host: Controller,
  fn: (tx: Transaction) => unknown,
): TransactionRef | AsyncTransactionRef {
  const result = outer.enter(() => fn(outer));
  const abort = () => host.abort('abort');
  if (!isThenable(result)) {
    const ref: TransactionRef = {
      pending: host.pending,
      done: host.outcome.then(() => undefined),
      abort,
    };
    bindAbort(ref, host.abort);
    return ref;
  }
  const release = outer.closed ? () => undefined : outer.retain();
  Promise.resolve(result).then(release, (e) => {
    release();
    host.fail(e);
  });
  const ref: AsyncTransactionRef = {
    pending: host.pending,
    done: host.outcome,
    abort,
  };
  bindAbort(ref, host.abort);
  return ref;
}

/**
 * Returns a `startTransaction(fn)` bound to the nearest transition scope — the Tier 3 sibling of
 * `injectStartTransition`. It HOLDS the scope's synchronous display reads from before `fn` runs
 * (so a state write inside `fn` doesn't flash through), records those writes in an undo log, then:
 *  - on settle (the scope's resources go in flight and drain, and every `retain()` is released)
 *    → release the hold + keep the writes;
 *  - on `abort()` → undo the recorded writes still in effect and release the hold.
 *
 * `fn` receives the transaction: `tx.retain()` keeps it open past the first render, and
 * `tx.enter(() => ...)` makes later writes part of it.
 *
 * The writes land on LIVE state immediately (so derived variables and connector requests see the
 * new values and refetch); only the *display* is held, via `scope.hold`. Must run in an injection
 * context.
 *
 * Caveat: work must go in flight by the first post-write render to be part of the transaction,
 * unless a retain is open. A loader that starts later (a debounced request signal, a
 * chained/deferred resource) is not attributable to it — the no-async fallback will have already
 * committed and released the hold, after which `abort()` is a no-op. Trigger such work eagerly
 * inside `fn`, or hold a retain until it starts.
 *
 * Async bodies: when `fn` returns a promise, the result is an {@link AsyncTransactionRef}. The hold
 * lasts until the promise resolves and a render has passed, the loads attributed to the
 * transaction have drained, and every retain is released; then `done` resolves `completed`. Code
 * after an `await` runs outside the transaction: wrap writes and synchronous kickoffs there in
 * `tx.enter(() => ...)` to make them part of it. A write without `enter` still lands and the hold
 * still spans it, but abort does not undo it. A load that starts after the slice (scheduled by
 * Angular in response to the slice's writes) is attributed by time, as any load started while the
 * transaction is open. A rejection undoes the recorded writes and settles `failed` with the error;
 * `abort()` and the injection context's destruction undo them and settle `aborted`. Once settled,
 * `tx.enter` and `tx.retain` throw, and a continuation's later result is ignored; nothing stops a
 * continuation from writing a signal directly.
 *
 * Nested calls: `startTransaction` called inside a slice of another one joins it. Its writes are
 * the outer transaction's, an async nested body keeps the outer open until it resolves (and fails
 * it if it rejects), its `abort()` aborts the outer, and its `done` follows the outer's settlement.
 *
 * A view that mounts while its scope is held shows each recorded signal as it was before the
 * first write since that hold began, counting holds inherited from enclosing scopes. Any
 * transaction's write counts, in any scope, settled or not, so the new view matches the rest of
 * the held page. Any other read (an unrecorded signal, a derived value, a store leaf) shows the
 * live value.
 *
 * Destroying the injection context settles a synchronous transaction and keeps its writes.
 */
export function injectStartTransaction(): StartTransaction {
  const scope = injectTransitionScope();
  const injector = inject(Injector);
  const destroyRef = inject(DestroyRef);
  const onServer = isServer();

  const start = (
    fn: (tx: Transaction) => unknown,
  ): TransactionRef | AsyncTransactionRef => {
    const outer = activeTransaction();
    const host = outer && !outer.closed ? controllers.get(outer) : undefined;
    if (outer && host) return joinOuter(outer, host, fn);

    const txn = createTransaction();
    const attributed = createAttributedPending(scope, txn);
    // flights a slice starts are this transaction's, never another's
    watchSlices(txn, () => {
      const before = snapshotLoads(scope);
      return () => {
        if (!txn.closed) claimLoads(scope, txn, before);
      };
    });

    scope.beginHold();

    // Two phases, not one flag twice: `finished` turns true before the undo pass, the claim
    // release and the hold release (it is the reentrancy guard, read synchronously and
    // untracked), `settledSig` after them, so `pending` lets go only once the settlement has
    // landed. A single tracked phase signal would expose the half-settled window to readers.
    let finished = false;
    let isAsync = false;
    const asyncBody = signal(false);
    const settledSig = signal(false);
    let watcher: { destroy(): void } | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let resolveOutcome!: (o: TransactionOutcome) => void;
    const outcome = new Promise<TransactionOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const finish = (o: TransactionOutcome, restore: boolean) => {
      if (finished) return;
      finished = true;
      releaseDestroy();
      watcher?.destroy();
      if (restore) txn.restore();
      else txn.clear();
      releaseClaims(scope, txn);
      scope.endHold();
      settledSig.set(true);
      resolveDone();
      resolveOutcome(o);
    };
    const abortWith = (reason: TransactionAbortReason) =>
      finish({ kind: 'aborted', reason }, true);
    const fail = (error: unknown) => finish({ kind: 'failed', error }, true);

    const releaseDestroy = destroyRef.onDestroy(() =>
      finish({ kind: 'aborted', reason: 'destroyed' }, isAsync),
    );

    const pending = computed(() =>
      asyncBody() ? !settledSig() : attributed(),
    );
    controllers.set(txn, { pending, outcome, abort: abortWith, fail });

    let result: unknown;
    try {
      result = txn.enter(() => fn(txn));
    } catch (e) {
      fail(e);
      throw e;
    }

    if (isThenable(result)) {
      isAsync = true;
      asyncBody.set(true);
      const returned = signal(false);
      const rendered = signal(false);
      const settleIfIdle = () => {
        if (!untracked(attributed) && untracked(txn.retained) === 0)
          finish({ kind: 'completed' }, false);
      };
      watcher = effect(
        () => {
          const p = attributed();
          const open = txn.retained() > 0;
          if (returned() && rendered() && !p && !open)
            finish({ kind: 'completed' }, false);
        },
        { injector },
      );
      Promise.resolve(result).then(() => {
        if (finished) return;
        returned.set(true);
        if (onServer) {
          rendered.set(true);
          settleIfIdle();
        } else afterNextRender(() => rendered.set(true), { injector });
      }, fail);
      const ref: AsyncTransactionRef = {
        pending,
        done: outcome,
        abort: () => abortWith('abort'),
      };
      bindAbort(ref, abortWith);
      return ref;
    }

    let sawPending = false;
    const rendered = signal(false);
    const settled = () =>
      !untracked(attributed) && untracked(txn.retained) === 0;
    watcher = effect(
      () => {
        const p = attributed();
        const open = txn.retained() > 0;
        if (p) sawPending = true;
        if ((sawPending || rendered()) && !p && !open)
          finish({ kind: 'completed' }, false);
      },
      { injector },
    );
    if (onServer) {
      rendered.set(true);
      if (settled()) finish({ kind: 'completed' }, false);
    } else {
      // no-async fallback; with a retain open it waits for the release
      afterNextRender(
        () => {
          if (sawPending) return;
          rendered.set(true);
          if (settled()) finish({ kind: 'completed' }, false);
        },
        { injector },
      );
    }

    const ref: TransactionRef = {
      pending,
      done,
      abort: () => abortWith('abort'),
    };
    bindAbort(ref, abortWith);
    return ref;
  };
  return start as StartTransaction;
}
