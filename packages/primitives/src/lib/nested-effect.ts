import {
  type CreateEffectOptions,
  effect,
  type EffectCleanupRegisterFn,
  type EffectRef,
  inject,
  Injector,
  isDevMode,
  untracked,
} from '@angular/core';

type Frame = {
  injector: Injector;
  parent: Frame | null;
  children: Set<EffectRef>;
};

const frameStack: Frame[] = [];

function current(frameAt = -1) {
  return frameStack.at(frameAt) ?? null;
}

function clearFrame(frame: Frame, userCleanups: (() => void)[]) {
  frame.parent = null;
  for (const child of frame.children) {
    try {
      child.destroy();
    } catch (e) {
      if (isDevMode()) console.error('Error destroying nested effect:', e);
    }
  }
  frame.children.clear();
  for (const fn of userCleanups) {
    try {
      fn();
    } catch (e) {
      if (isDevMode()) console.error('Error destroying nested effect:', e);
    }
  }
  userCleanups.length = 0;
}

/**
 * Creates an effect that can be nested, similar to SolidJS's `createEffect`.
 *
 * This primitive enables true hierarchical reactivity. A `nestedEffect` created
 * within another `nestedEffect` is automatically destroyed and recreated when
 * the parent re-runs.
 *
 * It automatically handles injector propagation and lifetime management, allowing
 * you to create fine-grained, conditional side-effects that only track
 * dependencies when they are "live".
 *
 * @param effectFn The side-effect function, which receives a cleanup register function.
 * @param options (Optional) Angular's `CreateEffectOptions`.
 * @returns An `EffectRef` for the created effect.
 *
 * @example
 * ```ts
 * // Assume `coldGuard` changes rarely, but `hotSignal` changes often.
 * const coldGuard = signal(false);
 * const hotSignal = signal(0);
 *
 * nestedEffect(() => {
 * // This outer effect only tracks `coldGuard`.
 * if (coldGuard()) {
 *
 * // This inner effect is CREATED when coldGuard is true
 * // and DESTROYED when it becomes false.
 * nestedEffect(() => {
 * // It only tracks `hotSignal` while it exists.
 * console.log('Hot signal is:', hotSignal());
 * });
 * }
 * // If `coldGuard` is false, this outer effect does not track `hotSignal`.
 * });
 * ```
 * @example
 * ```ts
 * const users = signal([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' }
]);

// The fine-grained mapped list
const mappedUsers = mapArray(
  users,
  (userSignal, index) => {
    // 1. Create a fine-grained SIDE EFFECT for *this item*
    // This effect's lifetime is now tied to this specific item. created once on init of this index.
    const effectRef = nestedEffect(() => {
      // This only runs if *this* userSignal changes,
      // not if the whole list changes.
      console.log(`User ${index} updated:`, userSignal().name);
    });

    // 2. Return the data AND the cleanup logic
    return {
      // The mapped data
      label: computed(() => `User: ${userSignal().name}`),
      
      // The cleanup function
      destroyEffect: () => effectRef.destroy()
    };
  },
  {
    // 3. Tell mapArray HOW to clean up when an item is removed, this needs to be manual as it's not a nestedEffect itself
    onDestroy: (mappedItem) => {
      mappedItem.destroyEffect();
    }
  }
);
 * ```
 */
export function nestedEffect(
  effectFn: (registerCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions & { bindToFrame?: number },
) {
  const parent = current(options?.bindToFrame);
  const injector = options?.injector ?? parent?.injector ?? inject(Injector);

  const srcRef = untracked(() => {
    return effect(
      (cleanup) => {
        const frame: Frame = {
          injector,
          parent,
          children: new Set<EffectRef>(),
        };

        const userCleanups: (() => void)[] = [];

        frameStack.push(frame);

        try {
          effectFn((fn) => {
            userCleanups.push(fn);
          });
        } finally {
          frameStack.pop();
        }

        return cleanup(() => clearFrame(frame, userCleanups));
      },
      {
        ...options,
        injector,
        manualCleanup: !!parent,
      },
    );
  });

  const ref = {
    ...srcRef,
    destroy: () => {
      parent?.children.delete(ref);
      srcRef.destroy();
    },
  };
  parent?.children.add(ref);

  return ref;
}
