import {
  DestroyRef,
  inject,
  InjectionToken,
  type Injector,
  type Provider,
  type ResourceRef,
  runInInjectionContext,
} from '@angular/core';
import {
  injectTransitionScope,
  type RegisterOptions,
} from '@mmstack/primitives';
import { type CircuitBreakerOptions, type RetryOptions } from './util';

/**
 * Auto-registration into the nearest transition scope, as a resource OPTION:
 *  - `true` — register for the pending indicator + hold-stale (does NOT block first paint);
 *  - `{ suspends: true }` — register as *suspending* (the boundary holds its placeholder until
 *    this resource has a value), i.e. full Suspense;
 *  - `{ suspends: false }` — same as `true`;
 *  - `false` / omitted — don't register.
 *
 * Defaultable via `provideResourceOptions` / `provideQueryResourceOptions` and overridable
 * (including opting out with `false`) per call — so a dev can make "all queries participate in
 * transitions" the default and turn it off for the odd one.
 */
export type TransitionRegistration = boolean | RegisterOptions;

/** Options common to every resource kind (the base layer for the options-injection system). */
export type CommonResourceOptions = {
  /** Auto-registration into the nearest transition scope. */
  readonly register?: TransitionRegistration;
  /** Retry failed requests. */
  readonly retry?: RetryOptions;
  /** Configure a circuit breaker for the resource. */
  readonly circuitBreaker?: CircuitBreakerOptions | true;
  /** Trigger a request even when the request parameters are unchanged. @default false */
  readonly triggerOnSameRequest?: boolean;
};

const RESOURCE_OPTIONS = new InjectionToken<CommonResourceOptions>(
  '@mmstack/resource:resource-options',
  { factory: () => ({}) },
);

function asProvider<T>(
  token: InjectionToken<T>,
  valueOrFn: T | (() => T),
): Provider {
  return typeof valueOrFn === 'function'
    ? { provide: token, useFactory: valueOrFn as () => T }
    : { provide: token, useValue: valueOrFn };
}

/** Layer 1: defaults that apply to ALL resource kinds. Type-specific providers inherit + override these. */
export function provideResourceOptions(
  valueOrFn: CommonResourceOptions | (() => CommonResourceOptions),
): Provider {
  return asProvider(RESOURCE_OPTIONS, valueOrFn);
}

export function injectResourceOptions(
  injector?: Injector,
): CommonResourceOptions {
  return injector ? injector.get(RESOURCE_OPTIONS) : inject(RESOURCE_OPTIONS);
}

/** Shared helper for the type-specific providers (query/mutation), so precedence is identical. */
export function provideTypedResourceOptions<T>(
  token: InjectionToken<T>,
  valueOrFn: T | (() => T),
): Provider {
  return asProvider(token, valueOrFn);
}

/**
 * Applies a resolved `register` option to a freshly-created resource — adds it to the nearest
 * transition scope and removes it on destroy. Runs in the resource's injection context (or the
 * provided `injector`), since registration needs `TRANSITION_SCOPE` + `DestroyRef`.
 */
export function applyResourceRegistration(
  ref: ResourceRef<unknown>,
  register: TransitionRegistration | undefined,
  injector?: Injector,
): void {
  if (!register) return;
  const opt: RegisterOptions =
    register === true ? { suspends: false } : register;
  const run = injector
    ? (fn: () => void) => runInInjectionContext(injector, fn)
    : (fn: () => void) => fn();
  run(() => {
    const scope = injectTransitionScope();
    const destroyRef = inject(DestroyRef);
    scope.add(ref, opt);
    destroyRef.onDestroy(() => scope.remove(ref));
  });
}
