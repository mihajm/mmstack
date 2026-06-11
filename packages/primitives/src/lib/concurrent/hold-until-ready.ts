import { linkedSignal, type Signal } from '@angular/core';

/**
 * Structural hold-and-swap as a signal. Given a `target` (the desired value — e.g. the
 * subtree/def/key you want to show) and a `ready` predicate, returns a signal that keeps
 * yielding its PREVIOUS value until `ready()` is true, then swaps to the current target.
 *
 * This is the structural counterpart to `keepPrevious`/`commit`: where those hold a *value*
 * through a reload, this holds a *structure* through a swap. The caller mounts the incoming
 * structure off to the side (so its resources can settle and flip `ready`), keeps showing the
 * held previous structure meanwhile, and lets the old one go once `ready` releases the swap.
 *
 * The very first value passes straight through (nothing to hold yet).
 */
export function holdUntilReady<T>(target: Signal<T>, ready: () => boolean): Signal<T> {
  return linkedSignal<{ t: T; ready: boolean }, T>({
    source: () => ({ t: target(), ready: ready() }),
    computation: (curr, prev) => (prev === undefined || curr.ready ? curr.t : prev.value),
  });
}
