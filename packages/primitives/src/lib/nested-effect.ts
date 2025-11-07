import {
  type CreateEffectOptions,
  effect,
  type EffectCleanupRegisterFn,
  type EffectRef,
  inject,
  Injector,
  untracked,
} from '@angular/core';

type Frame = {
  injector: Injector;
  children: Set<EffectRef>;
};

const frameStack: Frame[] = [];

function current() {
  return frameStack.at(-1) ?? null;
}

function clearFrame(frame: Frame, userCleanups: (() => void)[]) {
  for (const child of frame.children) {
    try {
      child.destroy();
    } catch {}
  }
  frame.children.clear();
  for (const fn of userCleanups) {
    try {
      fn();
    } catch {}
  }
  userCleanups.length = 0;
}

export function nestedEffect(
  effectFn: (registerCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions,
) {
  const parent = current();
  const injector = options?.injector ?? parent?.injector ?? inject(Injector);

  const srcRef = untracked(() => {
    return effect(
      (cleanup) => {
        const frame: Frame = {
          injector,
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
