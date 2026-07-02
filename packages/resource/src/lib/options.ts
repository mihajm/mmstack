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
import { type HttpResourceRequest } from '@angular/common/http';

/**
 * Options for enabling and configuring caching for a resource.
 *
 * - `true`: Enables caching with default settings.
 * - `{ ttl?: number; staleTime?: number; hash?: (req: HttpResourceRequest) => string; }`:  Configures caching with custom settings.
 */
export type ResourceCacheOptions =
  | true
  | {
      /**
       * The time-to-live for the cached value in milliseconds.
       * After this time, the value is removed from the cache entirely.
       * Defaults to 5 minutes (`300_000`).
       */
      ttl?: number;
      /**
       * The time in milliseconds during which the cached value is considered "fresh".
       * If a request is made within this time, the cached value is returned immediately without a background fetch.
       * Defaults to 0 (always stale, triggering a background fetch).
       */
      staleTime?: number;
      /**
       * A custom function to generate the cache key from the HTTP request.
       * By default, it hashes the URL, method, headers (specified by `varyHeaders`), and body.
       */
      hash?: (req: HttpResourceRequest) => string;
      /**
       * A list of header names to include in the default cache key generation.
       * Ignored if a custom `hash` function is provided.
       *
       * Note: still call `cache.clear()` on logout — the previous user's entries are
       * unreachable under the new key but linger until their TTL.
       */
      varyHeaders?: string[];
      /**
       * Whether to bust the browser cache by appending a unique query parameter to the request URL.
       * This is useful for ensuring that the latest data is fetched from the server, bypassing any
       * cached responses in the browser. The unique parameter is removed before calling the cache function, so it does not affect the cache key.
       * @default false - By default, the resource will not bust the browser cache.
       */
      bustBrowserCache?: boolean;
      /**
       * Whether to ignore the `Cache-Control` headers from the server when caching responses.
       * If set to `true`, the resource will not respect any cache directives from the server,
       * allowing you to control caching behavior entirely through the resource options.
       * @default false - By default the resource will respect `Cache-Control` headers.
       */
      ignoreCacheControl?: boolean;
      /**
       * If true, it saves the cached responses to an indexedDb table, making it available across
       * tabs, sessions and reloads.
       *
       * Note: persisted values are structured-cloned, which preserves `Date`/`Map`/`Set`/`Blob`
       * etc. but drops class prototypes — so prototype-bearing `parse` output comes back as a
       * plain object on hydration. Use `setLocal` to keep such a value in memory only.
       * @default false
       */
      persist?: boolean;
      /**
       * If true, entries written by this resource are not broadcast to other tabs, even when
       * `syncTabs` is enabled globally on the cache. Lets you opt into cross-tab sync globally
       * and opt a specific resource out. Combine with `persist: true` for "persist but don't sync".
       * @default false
       */
      skipTabSync?: boolean;
    };

/**
 * Auto-registration into the nearest transition scope, as a resource OPTION:
 *  - `'suspend'` — register as *suspending*: the boundary holds its placeholder until this
 *    resource has a value (full Suspense). The right choice for data the subtree can't render without;
 *  - `'indicator'` — register for the pending indicator + hold-stale only (does NOT block first
 *    paint). The right choice for in-region data: the boundary shows the held value with `aria-busy`;
 *  - `false` / omitted — don't register.
 *
 * Defaultable via `provideResourceOptions` / `provideQueryResourceOptions` and overridable
 * (including opting out with `false`) per call — so a dev can make "all queries participate in
 * transitions" the default and turn it off for the odd one.
 */
export type TransitionRegistration = false | 'indicator' | 'suspend';

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
 * transition scope and removes it when the context is destroyed OR the resource's own
 * `.destroy()` is called (a manually-destroyed resource must not linger in the scope). Runs in
 * the resource's injection context (or the provided `injector`), since registration needs
 * `TRANSITION_SCOPE` + `DestroyRef`. Returns the remover, for callers that manage a facade.
 */
export function applyResourceRegistration(
  ref: ResourceRef<unknown>,
  register: TransitionRegistration | undefined,
  injector?: Injector,
): () => void {
  if (!register) return () => undefined;
  const opt: RegisterOptions = { suspends: register === 'suspend' };
  const run = <T>(fn: () => T): T =>
    injector ? runInInjectionContext(injector, fn) : fn();
  return run(() => {
    const scope = injectTransitionScope();
    const destroyRef = inject(DestroyRef);
    scope.add(ref, opt);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      scope.remove(ref);
    };
    destroyRef.onDestroy(remove);
    const originalDestroy = ref.destroy;
    if (typeof originalDestroy === 'function') {
      ref.destroy = () => {
        remove();
        originalDestroy.call(ref);
      };
    }
    return remove;
  });
}
