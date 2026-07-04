import { isSignal, type Signal } from '@angular/core';

export function unwrap<T>(value: T | Signal<T>): T {
  return isSignal(value) ? value() : value;
}

/**
 * @internal
 * Merge overrides over defaults, skipping keys explicitly set to `undefined`
 * (a plain spread would let those punch through the defaults).
 */
export function mergeDefined<T extends object>(
  defaults: T,
  overrides?: Partial<T>,
): T {
  if (!overrides) return defaults;
  const out = { ...defaults };
  for (const k of Object.keys(overrides) as (keyof T)[]) {
    const v = overrides[k];
    if (v !== undefined) out[k] = v as T[keyof T];
  }
  return out;
}
