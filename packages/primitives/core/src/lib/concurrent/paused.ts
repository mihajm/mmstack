import {
  inject,
  InjectionToken,
  type Provider,
  signal,
  type Signal,
} from '@angular/core';
import { isServer } from '../platform';

/**
 * Whether the subtree a resource/component lives in is currently PAUSED, for Activity / keep-alive.
 * Provided by an Activity boundary (`MmActivity`, or the app-builder's per-branch injector) and read
 * — only at instantiation — by anything that should pause its background work while paused (a resource
 * returning its `paused` token, a `<video>` pausing playback, the pausable primitives, …). Absent
 * unless an Activity boundary provides one — read it via `injectPaused()`, which falls back to a
 * never-paused signal, so code that isn't inside an Activity boundary is unaffected.
 */
export const PAUSED_CONTEXT = new InjectionToken<Signal<boolean>>(
  '@mmstack/primitives:paused-context',
);

const NEVER_PAUSED: Signal<boolean> = signal(false).asReadonly();

/**
 * Inject the nearest paused-state signal — `true` while the surrounding subtree is paused (hidden by
 * an Activity boundary). Defaults to a never-paused signal, so callers outside an Activity are
 * unaffected; on the server it is always never-paused, so server-side work (e.g. connector fetches)
 * isn't suppressed. This is the public way to read pause state; the underlying token is intentionally
 * not exported.
 */
export function injectPaused(): Signal<boolean> {
  if (isServer()) return NEVER_PAUSED;
  return inject(PAUSED_CONTEXT, { optional: true }) ?? NEVER_PAUSED;
}

/**
 * Build a provider that supplies a paused-state signal to a subtree — the public way to set up an
 * Activity-style pause boundary (used by `MmActivity` and the app-builder's per-branch injectors).
 */
export function providePaused(source: Signal<boolean>): Provider {
  return { provide: PAUSED_CONTEXT, useValue: source };
}
