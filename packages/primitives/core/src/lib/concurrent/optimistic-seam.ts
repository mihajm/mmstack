import type { Signal, WritableSignal } from '@angular/core';

/** @internal Lays a guess on a guessable node for a transaction. */
export const LAY_GUESS = Symbol('@mmstack/primitives:lay-guess');
/** @internal Opens (or returns) a transaction's fork of an optimistic overlay. */
export const OPEN_OVERLAY = Symbol('@mmstack/primitives:open-overlay');

/** @internal A truth value with its own identity: an equal value written again is a new cell. */
export type Cell = { readonly value: unknown; readonly id: number };

/** @internal What `hold()` and `commit()` need from a guessable. */
export type GuessableInternals = {
  /** The signal the transaction records; its values are truth cells. */
  readonly port: WritableSignal<unknown>;
  readonly truth: Signal<unknown>;
  /** The visible guess, tracked: `[true, value]`, or `[false]` when the truth shows. */
  readonly visible: Signal<readonly [boolean, unknown?]>;
};

/** @internal */
export const guessableRegistry = new WeakMap<object, GuessableInternals>();

/** @internal The guess machinery behind `node`, if it is a guessable. */
export function guessableInternals(
  node: object,
): GuessableInternals | undefined {
  return guessableRegistry.get(node);
}

/** @internal Unwraps a hold seed recorded through a guessable's port. */
export function truthOfCell(cell: unknown): unknown {
  return (cell as Cell).value;
}
