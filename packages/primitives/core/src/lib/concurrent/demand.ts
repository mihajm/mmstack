import { type Loading, loading } from '../semantics/sentinel';
import { type UseSource } from './latest';
import { outcomeOf } from './outcome';

/** What a `loading` sentinel thrown for an idle source with nothing to show carries as `source`. */
export type AwaitingSource = { readonly kind: 'awaiting' };

const awaiting = new WeakMap<object, Loading>();

function awaitingFor(res: UseSource<unknown>): Loading {
  let sentinel = awaiting.get(res);
  if (!sentinel) {
    sentinel = loading({ kind: 'awaiting' } satisfies AwaitingSource);
    awaiting.set(res, sentinel);
  }
  return sentinel;
}

/**
 * What a derivation that needs `res` gets from it: its outcome, except that an idle source with
 * nothing to show is pending from the reader's point of view (`loading`, source `awaiting`).
 */
export function demandOf(res: UseSource<unknown>): unknown {
  const out = res.outcome ? res.outcome() : outcomeOf(res)();
  if (out === undefined && !(res.hasContent?.() ?? res.hasValue()))
    return awaitingFor(res);
  return out;
}
