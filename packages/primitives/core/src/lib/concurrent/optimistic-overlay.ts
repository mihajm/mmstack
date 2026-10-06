import {
  computed,
  linkedSignal,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { merge3, type ReconcileFn } from '../store/fork-store';
import { recordsElsewhere } from './active-transaction';
import { OPEN_OVERLAY } from './optimistic-seam';
import {
  nextOpenOrder,
  onTransactionClose,
  openOrderOf,
  type Transaction,
} from './transaction';

/** A fork of a plain-signal overlay: write guesses into `value`, `discard` drops them. */
export type OptimisticFork<T> = {
  readonly value: WritableSignal<T>;
  /** Drop the fork. Its base is never written. Calling it twice is harmless. */
  discard(): void;
};

/**
 * A read-only view of a signal with optimistic forks laid over it. Readers of the view see every
 * open fork's guesses folded over the base in open order (a later fork wins a value both changed);
 * readers of the base see none of them.
 */
export type Optimistic<T> = Signal<T> & {
  /** Open a fork you manage yourself; inside a transaction prefer `tx.overlay(this)`. */
  fork(): OptimisticFork<T>;
};

type OpenFork<T> = {
  readonly order: number;
  readonly staged: WritableSignal<T>;
};

/** @internal The fork-per-body machinery shared by `optimistic` and `optimisticStore`. */
export type OverlayCore<T> = {
  readonly view: Signal<T>;
  open(order: number): { readonly staged: WritableSignal<T>; close(): void };
  forTransaction(txn: Transaction): WritableSignal<T>;
  manual(): { readonly staged: WritableSignal<T>; close(): void };
};

/** @internal */
export function overlayCore<T>(
  base: Signal<T>,
  reconcile: ReconcileFn<T> = merge3,
): OverlayCore<T> {
  const forks = signal<readonly OpenFork<T>[]>([]);
  const byTxn = new WeakMap<Transaction, WritableSignal<T>>();

  const view = computed(() => {
    const b = base();
    let v = b;
    for (const f of forks()) v = reconcile(b, f.staged(), v);
    return v;
  });

  const open = (order: number) => {
    // re-links to a moving base: a path the fork changed keeps its guess, any other follows
    const staged = linkedSignal<T, T>({
      source: base,
      computation: (theirs, prev) =>
        prev === undefined
          ? theirs
          : reconcile(prev.source, prev.value, theirs),
    });
    recordsElsewhere(staged); // a guess is never an undoable write
    const entry: OpenFork<T> = { order, staged };
    untracked(() =>
      forks.update((list) =>
        [...list, entry].sort((a, b) => a.order - b.order),
      ),
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      untracked(() => forks.update((list) => list.filter((f) => f !== entry)));
    };
    return { staged, close };
  };

  return {
    view,
    open,
    forTransaction: (txn) => {
      let staged = byTxn.get(txn);
      if (staged) return staged;
      const f = open(openOrderOf(txn));
      staged = f.staged;
      byTxn.set(txn, staged);
      onTransactionClose(txn, f.close);
      return staged;
    },
    manual: () => open(nextOpenOrder()),
  };
}

/**
 * The overlay tier for a plain signal: guesses go into forks that only readers of the returned
 * view see, never readers of `base` (a request or derivation built on `base` ignores them). A fork
 * opened with `tx.overlay(view)` is discarded when its transaction settles, never written back.
 *
 * When `base` changes while a fork is open, the fork follows it unless the fork changed the value
 * itself; then the guess shows until it is discarded. Pass `reconcile` to merge differently.
 */
export function optimistic<T>(
  base: Signal<T>,
  opt?: { reconcile?: ReconcileFn<T> },
): Optimistic<T> {
  const core = overlayCore(base, opt?.reconcile);
  const out = computed(() => core.view()) as Optimistic<T> & {
    [OPEN_OVERLAY]: (txn: Transaction) => WritableSignal<T>;
  };
  out.fork = () => {
    const f = core.manual();
    return { value: f.staged, discard: f.close };
  };
  out[OPEN_OVERLAY] = core.forTransaction;
  return out;
}
