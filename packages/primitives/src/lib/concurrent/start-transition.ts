import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  effect,
  inject,
  Injector,
  PLATFORM_ID,
  type Signal,
  untracked,
} from '@angular/core';
import { injectTransitionScope } from './transition-scope';

/**
 * Handle for an in-progress transition: a `pending` signal (true while the transition's
 * resources are in flight) and a `done` promise that resolves once they all settle.
 */
export type TransitionRef = {
  readonly pending: Signal<boolean>;
  readonly done: Promise<void>;
};

/**
 * Returns a `startTransition(fn)` bound to the nearest transition scope. `fn` runs its state
 * mutations (which commit immediately); any resource that reloads as a result holds its value
 * (when `coordinate`/`commit`-wrapped) and reveals together once everything settles. The
 * returned handle exposes a unified `pending` + `done` for the whole operation — for imperative
 * coordination (disable a control, await completion) on top of the declarative hold-and-commit.
 *
 * Must be called in an injection context. This is the *async* generalization (Tier 2): it adds
 * no rendering cost and needs no fork — holding direct/sync readers is a separate, deferred tier.
 *
 * Caveat: work must go in flight by the first post-write render to be awaited. A loader that
 * starts later (a debounced request signal, a chained/deferred resource) is not attributable to
 * this transition — the no-async fallback will have already resolved `done`. Trigger such work
 * eagerly inside `fn`, or coordinate it separately.
 */
export function injectStartTransition(): (fn: () => void) => TransitionRef {
  const scope = injectTransitionScope();
  const injector = inject(Injector);
  const onServer = isPlatformServer(
    inject(PLATFORM_ID, { optional: true }) ?? 'browser',
  );

  return (fn: () => void): TransitionRef => {
    untracked(fn);

    let sawPending = false;
    const done = new Promise<void>((resolve) => {
      const watcher = effect(
        () => {
          const p = scope.pending();
          if (p) sawPending = true;
          // settle: requests went in flight and then drained
          if (sawPending && !p) {
            watcher.destroy();
            resolve();
          }
        },
        { injector },
      );
      if (onServer) {
        if (!untracked(scope.pending)) {
          watcher.destroy();
          resolve();
        }
        return;
      }
      // no-async fallback: once the reactive system has processed the writes (afterNextRender),
      // if nothing ever went in flight, the transition is already complete.
      afterNextRender(
        () => {
          if (!sawPending && !untracked(scope.pending)) {
            watcher.destroy();
            resolve();
          }
        },
        { injector },
      );
    });

    return { pending: scope.pending, done };
  };
}
