import { type EffectRef, type Injector, isDevMode } from '@angular/core';

export type Frame = {
  injector: Injector;
  parent: Frame | null;
  children: Set<EffectRef>;
};

const frameStack: Frame[] = [];

export function currentFrame() {
  return frameStack.at(-1) ?? null;
}

export function clearFrame(frame: Frame, userCleanups: (() => void)[]) {
  frame.parent = null;
  for (const fn of userCleanups) {
    try {
      fn();
    } catch (e) {
      if (isDevMode()) console.error('Error destroying nested effect:', e);
    }
  }
  userCleanups.length = 0;
  for (const child of frame.children) {
    try {
      child.destroy();
    } catch (e) {
      if (isDevMode()) console.error('Error destroying nested effect:', e);
    }
  }
  frame.children.clear();
}

export function pushFrame(frame: Frame) {
  return frameStack.push(frame);
}

export function popFrame() {
  return frameStack.pop();
}
