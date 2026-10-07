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
  activeTransaction,
  onTransactionClose,
  openOrderOf,
  type Transaction,
} from './transaction';

/**
 * A writable signal that can carry optimistic guesses (see `Transaction.guess`). Reading it gives
 * the most recent open guess, else the truth. `set` and `update` are authoritative writes: they land
 * on the wrapped signal and are recorded in the active transaction like any write. A write from
 * outside a transaction that guessed here buries every open guess, for good. A write inside the
 * transaction that laid a guess here resolves that guess instead (and buries every other open guess
 * here, as any write does): the guess takes the written value and stays until the transaction settles, so held readers move with it rather than dropping back
 * to the value before the transaction. A resolved guess equals the truth beneath it and never hides
 * a guess laid after it.
 */
export type Guessable<T> = WritableSignal<T> & {
  /** The authoritative value beneath any guess. */
  readonly truth: Signal<T>;
};

type GuessEntry = {
  readonly txn: Transaction;
  readonly order: number;
  readonly seq: number;
  readonly value: unknown;
  /** Resolved by its transaction's own write: equal to the truth, ranked below every other guess. */
  readonly refined?: boolean;
};

/** What a guessable keeps between events; `visible` projects it, every event replaces it. */
type Ledger = {
  /** The truth cell the recorder sees: a new identity for every acknowledged change. */
  readonly cur: Cell;
  /** The wrapped signal's version when the ledger last acknowledged it. */
  readonly known: number | undefined;
  /** Open, unburied guesses only: burial removes an entry for good. */
  readonly hist: readonly GuessEntry[];
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
 * value; `update` applies to the truth, not to a guess on screen) and any change of the wrapped
 * signal's own value from upstream (a `linkedSignal` that recomputes after a refetch). An upstream
 * change and a write from outside the guessing transaction bury every open guess; a write inside
 * the transaction that laid a guess resolves it to the written value (see {@link Guessable}). A
 * write after an `await` that is not wrapped in `tx.enter` is outside the transaction. Write
 * through the guessable, not the wrapped signal: a direct `set` with an equal value is not seen.
 * A mutable signal is not supported.
 */
export function guessable<T>(sig: WritableSignal<T>): Guessable<T> {
  if (isMutable(sig))
    throw new TypeError('guessable: a mutable signal is not supported');

  const ledger = signal<Ledger>({
    cur: { value: untracked(sig), id: ++ids },
    known: versionOf(sig),
    hist: [],
  });

  /** Whether the wrapped signal moved since the ledger acknowledged it: an upstream change. */
  const moved = (
    l: Ledger,
    value: unknown,
    ver: number | undefined,
  ): boolean =>
    ver === undefined ? !Object.is(value, l.cur.value) : ver !== l.known;

  /** Acknowledges an upstream change (it is authoritative) and returns the current truth cell. */
  const observe = (): Cell => {
    const l = untracked(ledger);
    const v = untracked(sig);
    const ver = versionOf(sig);
    if (!moved(l, v, ver)) return l.cur;
    const cur = { value: v, id: ++ids };
    ledger.set({ cur, known: ver, hist: [] }); // an upstream change buries every guess
    return cur;
  };

  const top = (hist: readonly GuessEntry[]): GuessEntry | undefined => {
    let best: GuessEntry | undefined;
    for (const g of hist) {
      if (!best) best = g;
      else if (!!g.refined !== !!best.refined) {
        if (best.refined) best = g;
      } else if (
        g.order > best.order ||
        (g.order === best.order && g.seq > best.seq)
      )
        best = g;
    }
    return best;
  };

  const visible = computed(
    (): readonly [boolean, unknown?] => {
      const l = ledger();
      const v = sig();
      // an upstream change the ledger has not acknowledged yet already buries: the next event
      // acknowledges it, so the projection and the ledger agree at every event
      const g = moved(l, v, versionOf(sig)) ? undefined : top(l.hist);
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
    // the value the signal kept: a custom `equal` may have rejected `v`
    const accepted = untracked(sig);
    // inside the transaction that guessed here: its latest guess takes the stored value
    const txn = activeTransaction();
    let own: GuessEntry | undefined;
    if (txn)
      for (const g of untracked(ledger).hist)
        if (g.txn === txn && (!own || g.seq > own.seq)) own = g;
    ledger.set({
      cur: { value: accepted, id: ++ids },
      known: versionOf(sig),
      hist: own ? [{ ...own, value: accepted, refined: true }] : [],
    });
  };

  // what a transaction records: truth cells, so compare-and-restore compares identities
  const port = (() => observe()) as unknown as WritableSignal<unknown>;
  port.set = (cell) => {
    const c = cell as Cell;
    observe();
    writeUnrecorded(sig, c.value as T);
    // a restore re-instates the truth it covered and buries nothing
    ledger.update((l) => ({ ...l, cur: c, known: versionOf(sig) }));
  };
  port.update = (fn) => port.set(fn(observe()));
  port.asReadonly = () => port;

  // a per-node guard: guess entries live on it, so they never own or restore the truth
  const guard = signal(0) as WritableSignal<unknown>;

  const lay = (txn: Transaction, value: T) => {
    observe();
    txn.record(guard, { kind: 'guess' });
    const l = untracked(ledger);
    if (!l.hist.some((g) => g.txn === txn))
      onTransactionClose(txn, () =>
        ledger.update((cur) => ({
          ...cur,
          hist: cur.hist.filter((g) => g.txn !== txn),
        })),
      );
    ledger.set({
      ...l,
      hist: [
        ...l.hist,
        { txn, order: openOrderOf(txn), seq: ++guessSeq, value },
      ],
    });
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
