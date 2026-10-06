import {
  assertInInjectionContext,
  type CreateEffectOptions,
  DestroyRef,
  effect,
  type EffectCleanupRegisterFn,
  type EffectRef,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import {
  injectTransitionScope,
  type TransitionScope,
} from './transition-scope';

export type HeldEffectOptions = Pick<
  CreateEffectOptions,
  'debugName' | 'manualCleanup'
> & {
  /**
   * Returns true while the effect is held. Defaults to the scope's `holding() || pending()`: held
   * while a transaction holds the display or a load is in flight.
   */
  readonly gate?: () => boolean;
  /** The scope the default gate reads. Defaults to the nearest transition scope. */
  readonly scope?: TransitionScope;
  /** Needed outside an injection context. */
  readonly injector?: Injector;
};

/**
 * An effect that waits while its gate is held. While `gate()` is true a dependency change does
 * not run `fn`; it only marks the effect stale. When the gate lets go, a stale effect runs once,
 * with the latest values. Changes that all happen while held still produce one run, which is the
 * commit-time behaviour of a transition: side effects see the settled state, not each step to it.
 * With nothing held it behaves as `effect`: one run per batch of changes.
 *
 * While held the effect stops tracking `fn`'s dependencies (it did not read them), so later
 * changes do not reach it. Nothing is lost: the first change already marked it stale, and the
 * release run reads and tracks everything again. A held effect cannot tell one change from many.
 *
 * Cleanups registered through `onCleanup` run right before the next run of `fn` (so not while it
 * is held) and when the effect is destroyed. Destroying a held effect runs nothing.
 *
 * Holding covers effects only. Template bindings belong to Angular and update as usual; hold
 * those with `*mmTransition` or by wrapping the values with the scope's `hold`/`commit`.
 *
 * ```ts
 * heldEffect(() => analytics.track('cart', cart.total()));
 * ```
 */
export function heldEffect(
  fn: (onCleanup: EffectCleanupRegisterFn) => void,
  opt?: HeldEffectOptions,
): EffectRef {
  if (!opt?.injector) assertInInjectionContext(heldEffect);
  const injector = opt?.injector ?? inject(Injector);
  const gate = opt?.gate ?? defaultGate(opt?.scope, injector);

  let stale = false;
  let cleanups: (() => void)[] = [];
  const runCleanups = () => {
    const current = cleanups;
    cleanups = [];
    for (const c of current) c();
  };
  const release = signal(0);

  const main = effect(
    () => {
      release();
      if (untracked(gate)) {
        stale = true;
        return;
      }
      stale = false;
      runCleanups();
      fn((c) => cleanups.push(c));
    },
    {
      injector,
      manualCleanup: true,
      debugName: opt?.debugName,
    },
  );

  const watcher = effect(
    () => {
      if (gate() || !stale) return;
      untracked(() => release.update((v) => v + 1));
    },
    { injector, manualCleanup: true },
  );

  let destroyed = false;
  const ref: EffectRef = {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      main.destroy();
      watcher.destroy();
      runCleanups();
    },
  };
  if (!opt?.manualCleanup) injector.get(DestroyRef).onDestroy(ref.destroy);
  return ref;
}

function defaultGate(
  scope: TransitionScope | undefined,
  injector: Injector,
): () => boolean {
  const s = scope ?? runInInjectionContext(injector, injectTransitionScope);
  return () => s.holding() || s.pending();
}
