import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  DestroyRef,
  effect,
  inject,
  Injector,
  PLATFORM_ID,
  type Signal,
  untracked,
} from '@angular/core';
import {
  createAttributedPending,
  injectTransitionScope,
} from './transition-scope';

/**
 * Handle for an in-progress transition: a `pending` signal (true while the transition's OWN
 * resources are in flight — loads already in flight when it started are not attributed) and a
 * `done` promise that resolves once they all settle.
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
  const destroyRef = inject(DestroyRef);
  const onServer = isPlatformServer(
    inject(PLATFORM_ID, { optional: true }) ?? 'browser',
  );

  return (fn: () => void): TransitionRef => {
    // attributed: loads already in flight when the transition starts are not ours —
    // they can neither settle this transition early nor block it forever
    const pending = createAttributedPending(scope);
    untracked(fn);

    let sawPending = false;
    const done = new Promise<void>((resolve) => {
      const settle = () => {
        releaseDestroy();
        watcher.destroy();
        resolve();
      };
      const watcher = effect(
        () => {
          const p = pending();
          if (p) sawPending = true;
          // settle: requests went in flight and then drained
          if (sawPending && !p) settle();
        },
        { injector },
      );
      // a destroy mid-flight kills the watcher — resolve so awaiters never hang
      const releaseDestroy = destroyRef.onDestroy(settle);
      if (onServer) {
        if (!untracked(pending)) settle();
        return;
      }
      // no-async fallback: once the reactive system has processed the writes (afterNextRender),
      // if nothing ever went in flight, the transition is already complete.
      afterNextRender(
        () => {
          if (!sawPending && !untracked(pending)) settle();
        },
        { injector },
      );
    });

    return { pending, done };
  };
}
