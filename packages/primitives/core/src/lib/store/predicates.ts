import {
  isWritableSignal as assertion,
  isDevMode,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { type MutableSignal } from '../mutable';
import { type Vivify, type VivifyFn } from '../util';
import { isOpaque } from './opaque';

export function isWritableSignal<T>(
  value: Signal<T>,
): value is WritableSignal<T> {
  return assertion(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isOpaque(value))
    return false;

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * @internal Whether a value is a terminal leaf: a concrete non-record/non-array value always is;
 * `null`/`undefined` is a leaf only when vivification is disabled (with vivify on it can still
 * materialize a container, so it stays a descendable substore).
 */
export function isLeafValue(value: unknown, vivifyEnabled: boolean): boolean {
  if (value == null) return !vivifyEnabled;
  if (isOpaque(value)) return true; // opaque always wins — even arrays
  return !Array.isArray(value) && !isRecord(value);
}

/**
 * @internal
 * Resolves the vivify shape for a node from its current value: a present record/array is a
 * certainty we keep (cached in the derivation, so it survives the value being nulled); an
 * unknown value (`null`/`undefined`) defers to the caller's option. Off stays off.
 */
export function resolveVivify(sample: unknown, option: Vivify): Vivify {
  if (!option) return false;
  if (Array.isArray(sample)) return 'array';
  if (isRecord(sample)) return 'object';
  return 'auto';
}

export function hasOwnKey(
  value: object | null | undefined,
  key: PropertyKey,
): boolean {
  return value != null && Object.hasOwn(value, key);
}

/**
 * @internal
 * Builds the `onChange` for the fallback (non-record container) derivation branch. For an
 * immutable source the container is copied before the write — returning the same mutated
 * reference would let the source's equality cut propagation (leaving child signals permanently
 * stale) and alias the caller's original object, breaking the structural-sharing contract
 * `forkStore` relies on. For a mutable source the write goes through `mutate`, so the chain's
 * force-notify engages (plain `update` with the same reference would never notify).
 */
export function createFallbackOnChange(
  target: WritableSignal<any> | MutableSignal<any>,
  prop: PropertyKey,
  vivifyFn: VivifyFn<any>,
  isMutableSource: boolean,
): (newValue: any) => void {
  const write = (newValue: any) => (v: any) => {
    const container = vivifyFn(v, prop);
    if (container === null || container === undefined) return container;
    const next = isMutableSource
      ? container
      : Array.isArray(container)
        ? container.slice()
        : isRecord(container)
          ? { ...container }
          : container; // non-plain leaf (Date/class instance): legacy in-place attempt
    try {
      next[prop] = newValue;
    } catch (e) {
      if (isDevMode())
        console.error(`[store] Failed to set property "${String(prop)}"`, e);
    }
    return next;
  };

  return isMutableSource
    ? (newValue: any) => (target as MutableSignal<any>).mutate(write(newValue))
    : (newValue: any) => target.update(write(newValue));
}

/**
 * @internal
 * Structural equality over plain data, the one equality the merges decide "unchanged" by:
 * primitives by `Object.is` (so `NaN` equals `NaN` and `+0` differs from `-0`); plain arrays by
 * length and index (a hole reads as `undefined`); plain records by their own enumerable keys,
 * with presence (an absent key differs from a key holding `undefined`). Everything else (a
 * `Date`, `Map`, `Set`, class instance, function, typed array or opaque value) is equal only
 * to itself.
 */
export function structEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  const la = Array.isArray(a) && !isOpaque(a);
  const lb = Array.isArray(b) && !isOpaque(b);
  if (la || lb) {
    if (!la || !lb) return false;
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!structEq(x[i], y[i])) return false;
    return true;
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(b, k) || !structEq(a[k], b[k])) return false;
  }
  return true;
}
