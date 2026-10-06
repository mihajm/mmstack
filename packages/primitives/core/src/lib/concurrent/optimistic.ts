// inspired by SolidJS 2.0's optimistic revert-by-construction — https://github.com/solidjs/solid
import {
  computed,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { SIGNAL } from '@angular/core/primitives/signals';
import { isMutable } from '../mutable';
import {
  mapRecordTarget,
  recordsElsewhere,
  recordWrite,
  swapRecorder,
} from './active-transaction';
import { type Cell, guessableRegistry, LAY_GUESS } from './optimistic-seam';
import {
  onTransactionClose,
  openOrderOf,
  type Transaction,
} from './transaction';

/**
 * A writable signal that can carry optimistic guesses (see `Transaction.guess`). Reading it gives
 * the most recent open guess laid after the last authoritative write, else the truth. `set` and
 * `update` are authoritative writes: they land on the wrapped signal, are recorded in the active
 * transaction like any write, and bury every guess laid before them, for good.
 */
export type Guessable<T> = WritableSignal<T> & {
  /** The authoritative value beneath any guess. */
  readonly truth: Signal<T>;
};

type GuessEntry = {
  readonly txn: Transaction;
  readonly order: number;
  readonly seq: number;
  readonly laidAt: number;
  readonly value: unknown;
};

let ids = 0;
let guessSeq = 0;

const versionOf = (sig: object): number | undefined =>
  (sig as { [SIGNAL]?: { version?: number } })[SIGNAL]?.version;

/** Writes `sig` with no transaction active: the caller records what needs recording. */
function writeUnrecorded<T>(sig: WritableSignal<T>, value: T): void {
  const prev = swapRecorder(null);
  try {
    sig.set(value);
  } finally {
    swapRecorder(prev);
  }
}

/**
 * Wraps a writable signal so transactions can lay optimistic guesses on it (the live tier: every
 * reader, derivation and request built on the guessable sees a guess). The wrapped signal keeps
 * the truth: it never holds a guess, so undo logs and held frames read the truth beneath one.
 *
 * Authoritative writes are `set`/`update` on the guessable (each one counts, even with an equal
 * value; `update` applies to the truth, not to a guess on screen) and any change of the wrapped signal's own value from upstream (a `linkedSignal` that
 * recomputes after a refetch). Write through the guessable, not the wrapped signal: a direct
 * `set` with an equal value is not seen. A mutable signal is not supported.
 */
export function guessable<T>(sig: WritableSignal<T>): Guessable<T> {
  if (isMutable(sig))
    throw new TypeError('guessable: a mutable signal is not supported');

  const rev = signal(0);
  const bump = () => rev.update((n) => n + 1);
  let cur: Cell = { value: untracked(sig), id: ++ids };
  let known = versionOf(sig);
  let authSeq = 0;
  let hist: GuessEntry[] = [];

  /** Brings `cur` up to date with the wrapped signal; an upstream change is authoritative. */
  const observe = (): Cell => {
    const v = untracked(sig);
    const ver = versionOf(sig);
    const changed =
      ver === undefined ? !Object.is(v, cur.value) : ver !== known;
    if (changed) {
      known = ver;
      cur = { value: v, id: ++ids };
      authSeq++;
    }
    if (hist.length && hist.some((g) => g.laidAt !== authSeq))
      hist = hist.filter((g) => g.laidAt === authSeq); // buried for good
    return cur;
  };

  const top = (): GuessEntry | undefined => {
    let best: GuessEntry | undefined;
    for (const g of hist)
      if (
        !best ||
        g.order > best.order ||
        (g.order === best.order && g.seq > best.seq)
      )
        best = g;
    return best;
  };

  const visible = computed(
    (): readonly [boolean, unknown?] => {
      rev();
      sig();
      observe();
      const g = top();
      return g ? [true, g.value] : [false];
    },
    { equal: (a, b) => a[0] === b[0] && Object.is(a[1], b[1]) },
  );

  const display = computed(() => {
    const [has, v] = visible();
    return (has ? v : sig()) as T;
  });

  const authoritative = (v: T) => {
    observe();
    recordWrite(port);
    writeUnrecorded(sig, v);
    known = versionOf(sig);
    cur = { value: v, id: ++ids };
    authSeq++;
    hist = [];
    bump();
  };

  // what a transaction records: truth cells, so compare-and-restore compares identities
  const port = (() => observe()) as unknown as WritableSignal<unknown>;
  port.set = (cell) => {
    const c = cell as Cell;
    observe();
    writeUnrecorded(sig, c.value as T);
    known = versionOf(sig);
    cur = c; // a restore re-instates the truth it covered and buries nothing
    bump();
  };
  port.update = (fn) => port.set(fn(observe()));
  port.asReadonly = () => port;

  // a per-node guard: guess entries live on it, so they never own or restore the truth
  const guard = signal(0) as WritableSignal<unknown>;

  const lay = (txn: Transaction, value: T) => {
    observe();
    txn.record(guard, { kind: 'guess' });
    if (!hist.some((g) => g.txn === txn))
      onTransactionClose(txn, () => {
        hist = hist.filter((g) => g.txn !== txn);
        bump();
      });
    hist.push({
      txn,
      order: openOrderOf(txn),
      seq: ++guessSeq,
      laidAt: authSeq,
      value,
    });
    bump();
  };

  const truth = computed(() => sig());
  const readonly = computed(() => display());
  const out = display as unknown as Guessable<T> & {
    [LAY_GUESS]: typeof lay;
  };
  out.set = authoritative;
  out.update = (fn) => authoritative(fn(untracked(sig)));
  out.asReadonly = () => readonly;
  Object.defineProperty(out, 'truth', { value: truth });
  out[LAY_GUESS] = lay;

  recordsElsewhere(out);
  mapRecordTarget(out, port);
  guessableRegistry.set(out, {
    port,
    truth: truth as Signal<unknown>,
    visible,
  });
  return out;
}
