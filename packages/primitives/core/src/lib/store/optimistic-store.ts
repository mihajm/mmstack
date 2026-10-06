import { type Signal, type WritableSignal } from '@angular/core';
import { overlayCore } from '../concurrent/optimistic-overlay';
import { OPEN_OVERLAY } from '../concurrent/optimistic-seam';
import type { Transaction } from '../concurrent/transaction';
import type { ReconcileFn } from './fork-store';
import { STORE_SHARED_OPTIONS } from './internals';
import { toStore } from './store';
import type { SignalStore, WritableSignalStore } from './types';

/** A fork of an optimistic store: write guesses into `store`, `discard` drops them. */
export type OptimisticStoreFork<T> = {
  readonly store: WritableSignalStore<T>;
  /** Drop the fork. The base is never written. Calling it twice is harmless. */
  discard(): void;
};

/**
 * An overlay over a store. `store` is the read-only facade: every open fork folded over the base
 * in open order, a later fork winning a path both changed. The base and everything that reads it
 * never see a guess.
 */
export type OptimisticStore<T> = {
  readonly store: SignalStore<T>;
  /** Open a fork you manage yourself; inside a transaction prefer `tx.overlay(this)`. */
  fork(): OptimisticStoreFork<T>;
};

/**
 * The overlay tier for a store: each body writes its guesses into its own fork of `base` (get it
 * with `tx.overlay(opt)`), readers of `opt.store` see them, and the fork is discarded when the
 * transaction settles, however it settles. Nothing is ever written to `base`.
 *
 * A base that moves while a fork is open is merged per path (`merge3`): paths the fork did not
 * change follow the base at once; a path it did change keeps the guess until the fork is
 * discarded (an array is one value, so a guessed list hides base changes to that list until
 * then). A guess equal to the value it covers is no change, so a base move there shows through.
 * Pass `reconcile` (for example an array-by-id merge) to merge differently. The base must be an
 * immutable store.
 */
export function optimisticStore<T extends Record<string, any>>(
  base: WritableSignalStore<T>,
  opt?: { reconcile?: ReconcileFn<T> },
): OptimisticStore<T> {
  if (typeof (base as { mutate?: unknown }).mutate === 'function')
    throw new TypeError('optimisticStore: the base must be an immutable store');
  const shared = (base as unknown as Record<symbol, unknown>)[
    STORE_SHARED_OPTIONS
  ] as object | undefined;
  const core = overlayCore<T>(base as unknown as Signal<T>, opt?.reconcile);
  const facade = toStore(core.view, { ...shared }) as SignalStore<T>;
  const asStore = (staged: WritableSignal<T>) =>
    toStore(staged, { ...shared }) as unknown as WritableSignalStore<T>;
  const forks = new WeakMap<WritableSignal<T>, WritableSignalStore<T>>();

  return {
    store: facade,
    fork: () => {
      const f = core.manual();
      return { store: asStore(f.staged), discard: f.close };
    },
    [OPEN_OVERLAY]: (txn: Transaction) => {
      const staged = core.forTransaction(txn);
      let s = forks.get(staged);
      if (!s) forks.set(staged, (s = asStore(staged)));
      return s;
    },
  } as OptimisticStore<T>;
}
