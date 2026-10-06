import type { TransactionAbortReason } from './transaction';

const drivers = new WeakMap<object, (reason: TransactionAbortReason) => void>();

/** @internal Bind a transaction ref to its reasoned abort. */
export function bindAbort(
  ref: object,
  abort: (reason: TransactionAbortReason) => void,
): void {
  drivers.set(ref, abort);
}

/**
 * Abort a started transaction with a cancellation reason. This is a seam for primitives that
 * drive transactions and supersede or tear down runs (a mutation that replaces the one in flight
 * passes `'superseded'`); application code calls the ref's own `abort()`. Undoes the recorded
 * writes still in effect, drops the transaction's guesses, and settles an async ref's `done` with
 * `{ kind: 'aborted', reason }`. A no-op once the transaction settled.
 */
export function abortTransaction(
  ref: object,
  reason: TransactionAbortReason,
): void {
  drivers.get(ref)?.(reason);
}
