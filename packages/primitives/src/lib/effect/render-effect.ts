import {
  computed,
  DestroyRef,
  effect,
  EffectRef,
  inject,
  Injector,
  runInInjectionContext,
  untracked,
  ValueEqualityFn,
} from '@angular/core';
import {
  clearFrame,
  currentFrame,
  Frame,
  popFrame,
  pushFrame,
} from './frame-stack';

let isBatching = false;
const pendingEffects = new Set<() => void>();

export function batch(fn: () => void) {
  if (isBatching) return fn();

  isBatching = true;
  try {
    fn();
  } finally {
    isBatching = false;
    for (const run of pendingEffects) {
      pendingEffects.delete(run);
      run();
    }
  }
}

const ALWAYS_FALSE: ValueEqualityFn<any> = () => false;

/**
 * A synchronous version of Angular's effect, optimized for DOM-heavy renderers.
 * Runs immediately on creation and on dependency changes, bypassing the microtask queue.
 * * @example
 * renderEffect((onCleanup) => {
 * const el = document.createElement('div');
 * el.textContent = count();
 * container.appendChild(el);
 * onCleanup(() => el.remove());
 * });
 */
export function renderEffect(
  effectFn: (onCleanup: (fn: () => void) => void) => void,
  options?: {
    injector?: Injector;
    bindToFrame?: (parent: Frame | null) => Frame | null;
  },
) {
  const bindToFrame = options?.bindToFrame ?? ((parent) => parent);
  const parent = bindToFrame(currentFrame());
  const injector = options?.injector ?? parent?.injector ?? inject(Injector);

  let cleanupFn: (() => void) | undefined;
  let isDestroyed = false;

  const tracker = computed(
    () => {
      if (cleanupFn) {
        try {
          cleanupFn();
        } catch {
          // noop
        }
        cleanupFn = undefined;
      }

      const frame: Frame = {
        injector,
        parent,
        children: new Set(),
      };
      const userCleanups: (() => void)[] = [];
      pushFrame(frame);

      try {
        effectFn((fn) => userCleanups.push(fn));
      } finally {
        popFrame();
        cleanupFn = () => clearFrame(frame, userCleanups);
      }
    },
    {
      equal: ALWAYS_FALSE,
    },
  );

  const run = (isFromBridge = false) => {
    if (isDestroyed) return;
    if (isBatching && !isFromBridge) {
      pendingEffects.add(run);
      return;
    }

    tracker();
  };

  let rootEffectRef: EffectRef | null = null;

  const ref = {
    run,
    destroy: () => {
      if (isDestroyed) return;
      isDestroyed = true;
      rootEffectRef?.destroy();
      parent?.children.delete(ref);
      pendingEffects.delete(run);
      if (cleanupFn) cleanupFn();
    },
  };

  parent?.children.add(ref);

  if (parent === null) {
    rootEffectRef = runInInjectionContext(injector, () =>
      untracked(() =>
        effect(() => run(true), { injector, manualCleanup: true }),
      ),
    );
    injector.get(DestroyRef).onDestroy(() => ref.destroy());
  } else {
    untracked(() => run(true));
  }

  return ref;
}
