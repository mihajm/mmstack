import { type Signal, type ValueEqualityFn } from '@angular/core';
import { SIGNAL } from '@angular/core/primitives/signals';

/**
 * @interal
 */
export function getSignalEquality<T>(sig: Signal<T>): ValueEqualityFn<T> {
  const internal = sig[SIGNAL] as {
    equal?: ValueEqualityFn<T>;
  };
  if (internal && typeof internal.equal === 'function') {
    return internal.equal;
  }
  return Object.is; // Default equality check
}
