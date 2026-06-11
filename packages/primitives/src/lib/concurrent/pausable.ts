import { isPlatformServer } from '@angular/common';
import {
  computed,
  type CreateComputedOptions,
  type CreateEffectOptions,
  type CreateSignalOptions,
  type EffectCleanupRegisterFn,
  type EffectRef,
  inject,
  type Injector,
  isDevMode,
  linkedSignal,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { nestedEffect } from '../effect';
import { PAUSED_CONTEXT } from './activity';

/**
 * How a pausable primitive decides whether it is currently paused:
 *  - omitted (the default) or `true` — read the ambient {@link PAUSED_CONTEXT} (via `injector`, or the
 *    current injection context). Reaching for a `pausable*` primitive means you want it pausable, so
 *    this is the default; outside an Activity boundary there's no `PAUSED_CONTEXT`, so the primitive is
 *    returned unwrapped (never pauses, zero overhead). On the server it never pauses either.
 *  - a predicate `() => boolean` — used directly. A `Signal<boolean>` satisfies this (signals are
 *    callable), and a plain function works OUTSIDE an injection context.
 *  - `false` — the explicit opt-out: the primitive is returned UNWRAPPED (no `linkedSignal`, no gate),
 *    i.e. exactly the plain primitive with zero overhead.
 */
export type PauseOption = boolean | (() => boolean);

export type PausableOptions = {
  /** Pause source — see {@link PauseOption}. Defaults to `true` (read the ambient `PAUSED_CONTEXT`). */
  readonly pause?: PauseOption;
  /**
   * Injector used to resolve {@link PAUSED_CONTEXT} when `pause` is `true`/omitted and the primitive
   * is created outside an injection context. Ignored for the `false` / predicate forms.
   */
  readonly injector?: Injector;
};

/**
 * Resolve a {@link PauseOption} into a pause predicate, or `null` meaning "do not pause".
 * `null` tells the caller to return the bare primitive — no wrapper is created.
 *
 *  - omitted/`true` → the ambient {@link PAUSED_CONTEXT} if an Activity boundary provides one (via
 *    `opt.injector` or the current injection context), else `null` (the bare primitive, no allocation).
 *    The default, because an explicit `pausable*` call wants to be pausable. An explicit `pause: true`
 *    with no boundary dev-warns; the omitted default stays quiet. SSR → `null`.
 *  - a function → returned as-is (covers `Signal<boolean>`; usable outside an injection context).
 *    SSR → `null` here too, detected via `opt.injector` if given, else a `globalThis.window` probe.
 *  - `false` → `null` (the explicit opt-out).
 *
 * Encapsulating this here keeps every pausable primitive's branching identical and in one place.
 */
export function resolvePause(opt?: PausableOptions): (() => boolean) | null {
  const explicit = opt?.pause; // distinguish explicit `true` from the omitted default
  const pause = explicit ?? true; // explicit pausable* calls default to pausing
  if (pause === false) return null;

  const run = <T>(fn: () => T): T =>
    opt?.injector ? runInInjectionContext(opt.injector, fn) : fn();

  const onServer = (): boolean =>
    typeof pause === 'function' && !opt?.injector
      ? typeof globalThis.window === 'undefined'
      : run(() =>
          isPlatformServer(
            inject(PLATFORM_ID, { optional: true }) ?? 'browser',
          ),
        );

  if (typeof pause === 'function') return onServer() ? null : pause;

  if (onServer()) return null;

  const paused = run(() => inject(PAUSED_CONTEXT, { optional: true }));
  if (!paused) {
    if (explicit === true && isDevMode())
      console.warn(
        '[pausable] `pause: true` but no PAUSED_CONTEXT in scope — not pausing. Provide one via an ' +
          'Activity boundary (`MmActivity` / `providePaused`), or pass a predicate / `pause: false`.',
      );
    return null;
  }
  return paused;
}

/**
 * Like {@link nestedEffect}, but pausable. While paused the effect does NOT run its body — and,
 * crucially, it reads the pause predicate FIRST, so while paused its dependency set collapses to just
 * the predicate (no churn from the real deps); on resume it re-runs and re-tracks. With no `pause`
 * option it defaults to the ambient `PAUSED_CONTEXT`; `pause: false` makes it a plain `nestedEffect`
 * with zero added overhead.
 */
export function pausableEffect(
  effectFn: (registerCleanup: EffectCleanupRegisterFn) => void,
  options?: CreateEffectOptions & PausableOptions,
): EffectRef {
  const paused = resolvePause(options);
  if (!paused) return nestedEffect(effectFn, options);

  return nestedEffect((registerCleanup) => {
    if (paused()) return; // read FIRST → while paused, deps collapse to just the predicate
    effectFn(registerCleanup);
  }, options);
}

/**
 * Like `signal`, but pausable. While paused, READS hold the last value; writes still land on the
 * underlying signal and surface on resume. Built on the `keepPrevious`/`hold` shape — a
 * `linkedSignal` gated on the pause predicate, with `set`/`update`/`asReadonly` forwarded to the
 * source signal. With no `pause` option it defaults to the ambient `PAUSED_CONTEXT`; `pause: false`
 * makes it a plain `signal` — no `linkedSignal` is created.
 *
 * NOTE: while paused, `set(x)` followed by a read returns the *held* (pre-pause) value, not `x` — the
 * write lands on the source and surfaces on resume. That is the "freeze the displayed value while
 * hidden" semantics; do not rely on read-after-write while paused.
 */
export function pausableSignal<T>(
  initialValue: T,
  options?: CreateSignalOptions<T> & PausableOptions,
): WritableSignal<T> {
  const paused = resolvePause(options);
  const src = signal(initialValue, options);
  if (!paused) return src;

  const read = linkedSignal<{ v: T; paused: boolean }, T>({
    source: () => ({ v: src(), paused: paused() }),
    computation: (curr, prev) =>
      prev !== undefined && curr.paused ? prev.value : curr.v,
    equal: options?.equal,
  });

  read.set = src.set;
  read.update = src.update;
  read.asReadonly = src.asReadonly;

  return read;
}

/**
 * Like `computed`, but pausable. While paused it holds its last value AND does not recompute: the
 * computation's dependencies are not read while paused, so a dependency change can't trigger work —
 * on resume it recomputes and re-tracks. The very first read always computes, to seed a value. With
 * no `pause` option it defaults to the ambient `PAUSED_CONTEXT`; `pause: false` makes it a plain
 * `computed`.
 */
export function pausableComputed<T>(
  computation: () => T,
  options?: CreateComputedOptions<T> & PausableOptions,
): Signal<T> {
  const paused = resolvePause(options);
  if (!paused) return computed(computation, options);

  const HELD = Symbol('paused-hold');
  const ls = linkedSignal<T | typeof HELD, T>({
    source: () => (paused() ? HELD : computation()),
    computation: (next, prev) =>
      next !== HELD ? next : prev !== undefined ? prev.value : computation(),
    equal: options?.equal,
  });
  return ls.asReadonly();
}
