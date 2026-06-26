import {
  type CreateEffectOptions,
  effect,
  type EffectCleanupRegisterFn,
  type EffectRef,
} from '@angular/core';
import { type PausableOptions, resolvePause } from './pausable';

/**
 * @internal The plain-`effect` sibling of the public {@link pausableEffect} (which is built on
 * `nestedEffect`). For infra utilities that own a single top-level effect/subscription and don't
 * need frame/nesting semantics. Opt-in (default off): with no `pause` (call site or
 * `providePausableOptions` default) it returns a bare `effect` (zero overhead, byte-identical to
 * today); otherwise it gates the body on the resolved predicate — read FIRST so the dependency set
 * collapses to just the predicate while paused, re-tracking on resume. Deliberately NOT re-exported
 * from the public barrel.
 */
export function pausablePureEffect(
  effectFn: (registerCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions & PausableOptions,
): EffectRef {
  const paused = resolvePause(options, false);
  if (!paused) return effect(effectFn, options);

  return effect((registerCleanup) => {
    if (paused()) return;
    effectFn(registerCleanup);
  }, options);
}
