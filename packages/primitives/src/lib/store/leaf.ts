import { computed, type Signal, untracked } from '@angular/core';
import { isStore } from './internals';
import { isLeafValue } from './predicates';

/**
 * @internal Runtime brand carrying a store node's lazily-built leaf probe. Exported (like
 * {@link OPAQUE}) only so the `{ readonly [LEAF]: () => boolean }` brand on the store types is
 * nameable in the emitted declarations — not part of the supported surface; use {@link isLeaf}.
 */
export const LEAF: unique symbol = Symbol('@mmstack/primitives::store/LEAF');

/**
 * @internal Constant leaf probes for nodes whose leaf-ness is statically known, so the reactive
 * `computed` can be skipped entirely.
 */
function alwaysTrue() {
  return true;
}
function alwaysFalse() {
  return false;
}

/**
 * @internal Attaches a lazy, memoized leaf probe to a store node. The probe (`() => boolean`)
 * closes over the node's value signal and its (stable) vivify setting, building the backing
 * `computed` on first call so leaf-ness tracks the live value reactively without taxing every
 * node access. Under `noUnionLeaves` the caller promises shapes never flip, so the probe is
 * resolved once from the first sample and frozen as a constant. Idempotent.
 */
export function markAsLeaf<TSig>(
  sig: TSig,
  value: Signal<unknown>,
  vivifyEnabled: boolean,
  noUnionLeaves: boolean,
): TSig & { readonly [LEAF]: () => boolean } {
  if (typeof (sig as any)[LEAF] !== 'function') {
    let memo: (() => boolean) | undefined;
    const probe = () => {
      if (memo) return memo();
      memo = noUnionLeaves
        ? isLeafValue(untracked(value), vivifyEnabled)
          ? alwaysTrue
          : alwaysFalse
        : computed(() => isLeafValue(value(), vivifyEnabled));
      return memo();
    };
    Object.defineProperty(sig, LEAF, {
      value: probe,
      enumerable: false,
      configurable: true,
    });
  }
  return sig as TSig & { readonly [LEAF]: () => boolean };
}

/**
 * Reports whether a store node is currently a **leaf** — a terminal value the store does not
 * descend into (a primitive, `Date`, `RegExp`, {@link opaque} object, class instance, or a
 * `null`/`undefined` hole when vivification is off) rather than a record/array substore.
 *
 * Leaf-ness reflects the node's **live** value: the probe is reactive and memoized, so calling
 * `isLeaf` inside a `computed`/`effect` re-evaluates when the node's shape changes.
 *
 * @internal Exposed for advanced/niche interop only — not part of the supported public surface
 * and may change without a major version bump.
 *
 * @example
 * const s = store({ name: 'Ada', address: { city: 'London' } });
 * isLeaf(s.name);    // true
 * isLeaf(s.address); // false — a substore
 */
export function isLeaf<T = unknown>(
  value: unknown,
): value is Signal<T> & { readonly [LEAF]: () => boolean } {
  return isStore(value) && (value as any)[LEAF]?.() === true;
}
