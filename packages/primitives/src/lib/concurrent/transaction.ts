import {
  afterNextRender,
  effect,
  inject,
  Injector,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { injectTransitionScope } from './transition-scope';

/**
 * An undo log for a transactional transition. Stateful writes made while the transaction is the
 * active one record their PRE-write value here (once, on first touch); `restore()` rolls them all
 * back (abort), `clear()` keeps them (commit — the writes already landed live).
 */
export type Transaction = {
  /** Record a signal's current value as its rollback point (no-op if already recorded). */
  record(sig: WritableSignal<unknown>): void;
  /** Roll every recorded signal back to its pre-write value (abort). */
  restore(): void;
  /** Drop the log, keeping live writes (commit). */
  clear(): void;
};

export function createTransaction(): Transaction {
  const log = new Map<WritableSignal<unknown>, unknown>();
  return {
    record: (sig) => {
      if (!log.has(sig)) log.set(sig, untracked(sig));
    },
    restore: () =>
      untracked(() => {
        for (const [sig, old] of log) sig.set(old);
        log.clear();
      }),
    clear: () => log.clear(),
  };
}

// The currently-active transaction, set only for the synchronous duration of a `startTransaction`
// body (so stateful actions running inside it can record their writes). Module-level + sync
// set/reset is the honest shape: a transaction is call-scoped, not structural-per-injector.
let active: Transaction | null = null;

/** The transaction in effect right now, or `null`. Stateful actions consult this to record undo. */
export function activeTransaction(): Transaction | null {
  return active;
}

function runInTransaction(txn: Transaction, fn: () => void): void {
  const prev = active;
  active = txn;
  try {
    untracked(fn);
  } finally {
    active = prev;
  }
}

/** Handle for an in-progress transaction (Tier 3): the transition `pending`/`done`, plus `abort`. */
export type TransactionRef = {
  readonly pending: Signal<boolean>;
  readonly done: Promise<void>;
  /** Roll back the staged writes and release the hold without committing. */
  abort(): void;
};

/**
 * Returns a `startTransaction(fn)` bound to the nearest transition scope — the Tier 3 sibling of
 * `injectStartTransition`. It HOLDS the scope's synchronous display reads from before `fn` runs
 * (so a state write inside `fn` doesn't flash through), records those writes in an undo log, then:
 *  - on settle (the scope's resources go in flight and drain) → release the hold + keep the writes;
 *  - on `abort()` → roll the writes back and release the hold.
 *
 * The writes land on LIVE state immediately (so derived variables and connector requests see the
 * new values and refetch); only the *display* is held, via `scope.hold`. Must run in an injection
 * context.
 *
 * Caveat: work must go in flight by the first post-write render to be part of the transaction. A
 * loader that starts later (a debounced request signal, a chained/deferred resource) is not
 * attributable to it — the no-async fallback will have already committed and released the hold,
 * after which `abort()` is a no-op. Trigger such work eagerly inside `fn`.
 */
export function injectStartTransaction(): (fn: () => void) => TransactionRef {
  const scope = injectTransitionScope();
  const injector = inject(Injector);

  return (fn: () => void): TransactionRef => {
    const txn = createTransaction();

    // Hold BEFORE the writes, so the display freezes at pre-transaction values.
    scope.beginHold();

    let finished = false;
    // eslint-disable-next-line prefer-const -- assigned in try/catch, but needs to be declared here for the `finally` block to see it
    let watcher: { destroy(): void } | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    // Every exit path funnels through here, so `done` always settles — including `abort()`
    // and a throwing transaction body (which would otherwise leak the hold forever and
    // freeze the boundary with no recovery).
    const finish = (restore: boolean) => {
      if (finished) return;
      finished = true;
      watcher?.destroy();
      if (restore) txn.restore();
      else txn.clear();
      scope.endHold();
      resolveDone();
    };

    try {
      runInTransaction(txn, fn);
    } catch (e) {
      finish(true);
      throw e;
    }

    let sawPending = false;
    watcher = effect(
      () => {
        const p = scope.pending();
        if (p) sawPending = true;
        if (sawPending && !p) finish(false);
      },
      { injector },
    );
    // no-async fallback: if nothing ever went in flight, settle once the writes are processed.
    afterNextRender(
      () => {
        if (!sawPending && !untracked(scope.pending)) finish(false);
      },
      { injector },
    );

    return {
      pending: scope.pending,
      done,
      abort: () => finish(true),
    };
  };
}
