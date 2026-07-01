import {
  HttpClient,
  type HttpHeaders,
  httpResource,
  type HttpResourceOptions,
  type HttpResourceRef,
  type HttpResourceRequest,
  HttpResponse,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  linkedSignal,
  type Provider,
  type ResourceRef,
  ResourceStatus,
  runInInjectionContext,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  injectPaused,
  type PauseOption,
  toWritable,
} from '@mmstack/primitives';
import { firstValueFrom } from 'rxjs';
import {
  applyResourceRegistration,
  type CommonResourceOptions,
  injectResourceOptions,
  provideTypedResourceOptions,
  type ResourceCacheOptions,
} from './options';
import {
  catchValueError,
  createCircuitBreaker,
  createEqualRequest,
  hashRequest,
  hasSlowConnection,
  injectNetworkStatus,
  injectPageVisibility,
  injectQueryCache,
  mergeCacheOptions,
  mergeCircuitBreakerOptions,
  mergeRefreshOptions,
  mergeRetryOptions,
  persistResourceValues,
  refresh,
  type RefreshOptions,
  retryOnError,
  setCacheContext,
  toResourceObject,
} from './util';
import { type CacheEntry } from './util/cache/cache';

export { type RefreshOptions } from './util';

/**
 * Options for configuring a `queryResource`. Extends Angular's
 * `HttpResourceOptions` with caching, retries, refresh intervals, circuit
 * breakers, and lifecycle callbacks. See the linked properties below for the
 * full list.
 *
 * @example
 * ```ts
 * const options: QueryResourceOptions<User> = {
 *   defaultValue: { id: 0, name: 'Anonymous' },
 *   cache: { ttl: 60_000, staleTime: 10_000 },
 *   refresh: 30_000,
 *   retry: { max: 3 },
 *   circuitBreaker: true,
 *   onError: (err, retry, isFinal) => isFinal && toast.error(err),
 * };
 * ```
 */
export type QueryResourceOptions<TResult, TRaw = TResult> = HttpResourceOptions<
  TResult,
  TRaw
> &
  CommonResourceOptions & {
    /**
     * Whether to keep the previous value of the resource while a refresh is in progress.
     * Defaults to `false`. Also keeps status & headers while refreshing.
     */
    keepPrevious?: boolean;
    /**
     * Automatic refresh behavior. A number polls every n milliseconds; the object form
     * composes polling with event-driven triggers:
     *
     * ```ts
     * refresh: 30_000                                  // poll every 30s
     * refresh: { onFocus: true, onReconnect: true }    // refetch on tab refocus / back-online
     * refresh: { interval: 60_000, onFocus: true }     // both
     * ```
     *
     * Triggers respect the resource's disabled/paused state (no refetch while
     * offline, circuit-open, or paused).
     */
    refresh?: RefreshOptions;
    /**
     * Called on every failed attempt, including each retry.
     *
     * @param err - The error from the underlying HTTP request.
     * @param retryCount - The number of retries that already happened before
     * this error (`0` on the original failure, `1` after the first retry, etc.).
     * @param isFinal - `true` when no further retry will be scheduled — either
     * because retries are exhausted or `retry` was unset/0. Branch on this for
     * "user actually needs to know" side effects (toasts, error reporting).
     */
    onError?: (err: unknown, retryCount: number, isFinal: boolean) => void;
    /**
     * Options for enabling and configuring caching for the resource.
     */
    cache?: ResourceCacheOptions;
    /**
     * Opt-in automatic pausing (off by default — existing behavior unchanged):
     * - `true` — pause whenever the surrounding Activity boundary (`MmActivity` /
     *   `providePaused` from `@mmstack/primitives`) is paused. Outside a boundary this
     *   is a no-op, so it's safe to set app-wide via `provideQueryResourceOptions`.
     * - a `() => boolean` predicate (a `Signal<boolean>` qualifies) — pause while it
     *   returns `true`.
     *
     * Pausing has the same semantics as returning `ctx.paused` from the request fn:
     * the resource HOLDS its current value and last request (no refetch on resume if
     * the request is unchanged) and stops background work (polling, focus/reconnect
     * triggers). The two compose — either source can pause the resource.
     */
    pause?: PauseOption;
    /**
     * Comparison of request object
     */
    equalRequest?: (a: HttpResourceRequest, b: HttpResourceRequest) => boolean;
  };

const QUERY_RESOURCE_OPTIONS = new InjectionToken<
  Partial<QueryResourceOptions<any, any>>
>('@mmstack/resource:query-resource-options', { factory: () => ({}) });

/**
 * Layer 2 (query): default options for every `queryResource`, inheriting + overriding the
 * common defaults from `provideResourceOptions`. Per-call options override these in turn.
 */
export function provideQueryResourceOptions(
  valueOrFn:
    | Partial<QueryResourceOptions<any, any>>
    | (() => Partial<QueryResourceOptions<any, any>>),
): Provider {
  return provideTypedResourceOptions(QUERY_RESOURCE_OPTIONS, valueOrFn);
}

function injectQueryResourceOptions(
  injector?: Injector,
): Partial<QueryResourceOptions<any, any>> {
  return injector
    ? injector.get(QUERY_RESOURCE_OPTIONS)
    : inject(QUERY_RESOURCE_OPTIONS);
}

/**
 * The reason a query resource is currently in the `disabled` state, or `null`
 * if it is enabled. Useful for branching UI on cause (e.g. "offline" vs
 * "circuit tripped" vs "nothing to fetch yet").
 *
 * @example
 * ```ts
 * effect(() => {
 *   switch (user.disabledReason()) {
 *     case 'offline':      return toast.warn('You are offline');
 *     case 'circuit-open': return toast.warn('Service temporarily unavailable');
 *     case 'no-request':   return; // expected — request signal returned undefined
 *     case null:           return; // resource is enabled
 *   }
 * });
 * ```
 *
 * Note: a PAUSED resource also reports `'no-request'` — it holds its previous value
 * and request, but no request is currently active.
 */
export type DisabledReason = 'offline' | 'circuit-open' | 'no-request';

/**
 * Returned from a resource's request fn to PAUSE it: the resource holds its current value and last
 * request (so it does not refetch on resume), and stops background work (no polling, no refetch
 * while paused). Distinct from returning `undefined` (DISABLE), which drops the request — a
 * disabled resource may refetch when re-enabled, a paused one resumes exactly where it left off.
 *
 * The request fn receives a {@link RequestContext} and can just return `ctx.paused`.
 */
export const PAUSED: unique symbol = Symbol('@mmstack/resource:paused');

/**
 * Context passed to a resource's request fn. An object (not positional args) so it can grow
 * without changing the call signature. Today it carries {@link PAUSED} so the fn can return it.
 */
export type RequestContext = { readonly paused: typeof PAUSED };

/** The request fn shape: build a request, or return `undefined` (disable) / `ctx.paused` (pause). */
export type ResourceRequestFn = (
  ctx: RequestContext,
) => HttpResourceRequest | string | undefined | void | typeof PAUSED;

/**
 * Represents a resource created by `queryResource`. Extends `HttpResourceRef`
 * with `disabled` / `disabledReason` signals, writable `headers` / `statusCode`
 * (so optimistic updates can patch them), and `prefetch()` for proactive cache
 * warm-up.
 *
 * @example
 * ```ts
 * const user = queryResource<User>(() => `/api/users/${userId()}`);
 *
 * effect(() => {
 *   if (user.status() === 'resolved') console.log(user.value());
 * });
 *
 * // Warm the cache before navigating
 * onMouseEnter(() => user.prefetch());
 * ```
 */
export type QueryResourceRef<TResult> = Omit<
  HttpResourceRef<TResult>,
  'headers' | 'statusCode'
> & {
  /**
   * Linkedsignal of the response headers, when available.
   */
  readonly headers: WritableSignal<HttpHeaders | undefined>;
  /**
   * Linkedsignal of the response status code, when available.
   */
  readonly statusCode: WritableSignal<number | undefined>;
  /**
   * A signal indicating whether the resource is currently disabled (due to circuit breaker, offline, or undefined request).
   */
  disabled: Signal<boolean>;
  /**
   * Why the resource is currently disabled, or `null` if it is enabled.
   * Maps to one of: `'offline'`, `'circuit-open'`, `'no-request'`.
   */
  disabledReason: Signal<DisabledReason | null>;
  /**
   * Prefetches data for the resource, populating the cache if caching is enabled.  This can be
   * used to proactively load data before it's needed.
   *
   * Resolves immediately without fetching when caching is disabled or a slow
   * connection is detected (prefetching would compete with user-initiated requests).
   *
   * @param req - Optional partial request parameters to use for the prefetch.  This allows you
   *              to prefetch data with different parameters than the main resource request.
   */
  prefetch: (req?: Partial<HttpResourceRequest> | string) => Promise<void>;
};

/**
 * Creates an HTTP resource with features like caching, retries, refresh intervals, circuit breaker, and optimistic updates. Without additional options it is equivalent to simply calling `httpResource`.
 * This overload is for when a `defaultValue` is provided, ensuring that the resource's value is always defined.
 * @param request A function that returns the `HttpResourceRequest` or a URL string to be made.  This function
 *               is called reactively, so the request can change over time.  If the function
 *              returns `undefined`, the resource is considered "disabled" and no request will be made.
 * @param options Configuration options for the resource.  These options extend the basic
 *               `HttpResourceOptions` and add features like `keepPrevious`, `refresh`, `retry`,
 *                `onError`, `circuitBreaker`, and `cache`.  Additionally, when a `defaultValue` is provided, the resource's value will always be defined, even if the underlying HTTP request fails or is disabled.
 * @returns An `QueryResourceRef` instance, which extends the basic `HttpResourceRef` with additional features.
 *
 * @example
 * ```ts
 * const userId = signal(1);
 *
 * const user = queryResource<User>(
 *   () => `/api/users/${userId()}`,
 *   { defaultValue: { id: 0, name: 'Anonymous' } },
 * );
 *
 * user.value(); // always User — never undefined, even before the first fetch resolves
 * ```
 */
export function queryResource<TResult, TRaw = TResult>(
  request: ResourceRequestFn,
  options: QueryResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  },
): QueryResourceRef<TResult>;

/**
 * Creates an extended HTTP resource with features like caching, retries, refresh intervals,
 * circuit breaker, and optimistic updates. Without additional options it is equivalent to simply calling `httpResource`.
 *
 * @param request A function that returns the `HttpResourceRequest` or a URL string to be made.  This function
 *                is called reactively, so the request can change over time.  If the function
 *                returns `undefined`, the resource is considered "disabled" and no request will be made.
 * @param options Configuration options for the resource.  These options extend the basic
 *                `HttpResourceOptions` and add features like `keepPrevious`, `refresh`, `retry`,
 *                `onError`, `circuitBreaker`, and `cache`.
 * @returns An `QueryResourceRef` instance, which extends the basic `HttpResourceRef` with additional features.
 *
 * @example
 * ```ts
 * const userId = signal<number | undefined>(undefined);
 *
 * const user = queryResource<User>(
 *   () => userId() ? `/api/users/${userId()}` : undefined,
 *   {
 *     cache: { ttl: 60_000, staleTime: 10_000 },
 *     refresh: 30_000,
 *     retry: { max: 3 },
 *   },
 * );
 *
 * user.value();          // User | undefined
 * user.status();         // 'idle' | 'loading' | 'resolved' | 'error'
 * user.disabledReason(); // null while enabled; 'offline' / 'circuit-open' / 'no-request' otherwise
 * ```
 */
export function queryResource<TResult, TRaw = TResult>(
  request: ResourceRequestFn,
  options?: QueryResourceOptions<TResult, TRaw>,
): QueryResourceRef<TResult | undefined>;

export function queryResource<TResult, TRaw = TResult>(
  request: ResourceRequestFn,
  options0?: QueryResourceOptions<TResult, TRaw>,
): QueryResourceRef<TResult | undefined> {
  const globalOpts = injectResourceOptions(options0?.injector);
  const queryOpts = injectQueryResourceOptions(options0?.injector);

  const options = {
    ...globalOpts,
    ...queryOpts,
    ...options0,
    cache: mergeCacheOptions(queryOpts.cache, options0?.cache),
    circuitBreaker: mergeCircuitBreakerOptions(
      globalOpts.circuitBreaker,
      queryOpts.circuitBreaker,
      options0?.circuitBreaker,
    ),
    retry: mergeRetryOptions(
      globalOpts.retry,
      queryOpts.retry,
      options0?.retry,
    ),
    refresh: mergeRefreshOptions(queryOpts.refresh, options0?.refresh),
  } as QueryResourceOptions<TResult, TRaw>;

  const cache = injectQueryCache<TResult>(options?.injector);

  const destroyRef = options?.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const cb = createCircuitBreaker(
    options?.circuitBreaker === true
      ? undefined
      : (options?.circuitBreaker ?? false),
    options?.injector,
  );

  const networkAvailable = injectNetworkStatus(options.injector);

  const eq = options?.triggerOnSameRequest
    ? undefined
    : (options?.equalRequest ?? createEqualRequest());

  const pauseOpt = options?.pause ?? false;
  const externallyPaused: () => boolean =
    pauseOpt === false
      ? () => false
      : typeof pauseOpt === 'function'
        ? pauseOpt
        : options?.injector
          ? runInInjectionContext(options.injector, injectPaused)
          : injectPaused();

  const requestCtx: RequestContext = { paused: PAUSED };
  const rawResult = computed(() => request(requestCtx));
  const paused = computed(() => rawResult() === PAUSED || externallyPaused());
  const rawRequest = computed(() => {
    const r = rawResult();
    return r === PAUSED ? undefined : (r ?? undefined);
  });

  const disabledReason = computed<DisabledReason | null>(() => {
    if (!networkAvailable()) return 'offline';
    if (cb.isOpen()) return 'circuit-open';
    if (paused() || !rawRequest()) return 'no-request';
    return null;
  });

  // While PAUSED, hold the previous request so httpResource sees no change — it keeps its value and
  // does NOT refetch. On resume the request is re-evaluated, so it refetches only if it changed.
  const heldRequest = linkedSignal<
    { req: HttpResourceRequest | undefined; held: boolean },
    HttpResourceRequest | undefined
  >({
    source: () => {
      if (paused()) return { req: undefined, held: true };
      if (disabledReason() !== null) return { req: undefined, held: false };
      const req = rawRequest();
      if (!req) return { req: undefined, held: false };
      if (typeof req === 'string')
        return { req: { method: 'GET', url: req }, held: false };
      return { req, held: false };
    },
    computation: (curr, prev) =>
      curr.held && prev !== undefined ? prev.value : curr.req,
  });

  // Dedup via the request-equality (the linkedSignal re-runs on every source tick; this computed
  // is what actually gates httpResource — so an equal/held request never triggers a refetch).
  const stableRequest = computed(
    (): HttpResourceRequest | undefined => heldRequest(),
    {
      equal: (a, b) => {
        if (a === b) return true;
        if (a === undefined || b === undefined) return false;
        if (eq) return eq(a, b);
        return a === b;
      },
    },
  );

  const varyHeaders =
    typeof options?.cache === 'object' ? options.cache.varyHeaders : undefined;

  const hashFn =
    typeof options?.cache === 'object'
      ? (options.cache.hash ??
        ((r: HttpResourceRequest) => hashRequest(r, varyHeaders)))
      : hashRequest;

  const staleTime =
    typeof options?.cache === 'object' ? options.cache.staleTime : 0;
  const ttl =
    typeof options?.cache === 'object' ? options.cache.ttl : undefined;

  const cacheKey = computed(() => {
    const r = stableRequest();
    if (!r) return null;
    return hashFn(r);
  });

  const bustBrowserCache =
    typeof options?.cache === 'object' &&
    options.cache.bustBrowserCache === true;

  const ignoreCacheControl =
    typeof options?.cache === 'object' &&
    options.cache.ignoreCacheControl === true;

  const persist =
    typeof options?.cache === 'object' && options.cache.persist === true;

  const cachedRequest = options?.cache
    ? computed(() => {
        const r = stableRequest();
        if (!r) return r;

        return {
          ...r,
          context: setCacheContext(r.context, {
            staleTime,
            ttl,
            key: cacheKey() ?? hashFn(r),
            bustBrowserCache,
            ignoreCacheControl,
            persist,
          }),
        };
      })
    : stableRequest;

  let resource = toResourceObject(
    httpResource<TResult>(cachedRequest, {
      ...options,
      parse: options?.parse as any, // Not my favorite thing to do, but here it is completely safe.
    }) as HttpResourceRef<TResult>,
  );

  resource = catchValueError(resource, options?.defaultValue as TResult);

  // get full HttpResonse from Cache
  const cachedEvent = cache.getEntryOrKey(cacheKey);

  const cacheEntry = linkedSignal<
    CacheEntry<HttpResponse<TResult>> | string | null,
    { key: string; value: TResult | null } | null
  >({
    source: () => cachedEvent(),
    computation: (entry, prev) => {
      if (!entry) return null;

      if (
        typeof entry === 'string' &&
        prev &&
        prev.value !== null &&
        prev.value.key === entry
      ) {
        return prev.value;
      }

      if (typeof entry === 'string') return { key: entry, value: null };

      if (!(entry.value instanceof HttpResponse))
        return { key: entry.key, value: null };

      return {
        value: entry.value.body,
        key: entry.key,
      };
    },
  });

  // A disabled (offline / circuit-open / no-request) or PAUSED resource must not poll or react to focus/reconnect.
  resource = refresh(
    resource,
    destroyRef,
    options?.refresh,
    () => disabledReason() !== null,
    {
      injector: options?.injector ?? inject(Injector),
      visibility: injectPageVisibility(options.injector),
      online: networkAvailable,
    },
  );
  resource = retryOnError(
    resource,
    options?.retry,
    options?.onError,
    options.injector,
  );

  resource = persistResourceValues<TResult>(
    resource,
    options?.keepPrevious,
    options?.equal,
  );

  const set = (value: TResult) => {
    resource.value.set(value);
    const k = untracked(cacheKey);
    if (options?.cache && k)
      cache.store(
        k,
        new HttpResponse({
          body: value,
          status: 200,
        }),
        staleTime,
        ttl,
        persist,
      );
  };

  const update = (updater: (value: TResult) => TResult) => {
    set(updater(untracked(value)));
  };

  const value = options?.cache
    ? toWritable(
        computed((): TResult => cacheEntry()?.value ?? resource.value()),
        set,
        update,
      )
    : resource.value;

  // iterate circuit breaker state, is effect as a computed would cause a circular dependency (resource -> cb -> resource)
  const cbEffectRef = effect(
    () => {
      const status = resource.status();
      if (status === ResourceStatus.Error)
        cb.fail(untracked(resource.error) as Error | undefined);
      else if (status === ResourceStatus.Resolved) cb.success();
    },
    { injector: options.injector },
  );

  const client = options?.injector
    ? options.injector.get(HttpClient)
    : inject(HttpClient);

  const ref: QueryResourceRef<TResult | undefined> = {
    ...resource,
    value,
    set,
    update,
    statusCode: linkedSignal(resource.statusCode),
    headers: linkedSignal(resource.headers),
    disabled: computed(() => disabledReason() !== null),
    disabledReason,
    reload: () => {
      cb.halfOpen(); // open the circuit for manual reload
      return resource.reload();
    },
    destroy: () => {
      cbEffectRef.destroy();
      cb.destroy();
      resource.destroy();
    },
    prefetch: async (partial) => {
      if (!options?.cache || hasSlowConnection()) return Promise.resolve();

      const request = untracked(stableRequest);

      const partialReq =
        typeof partial === 'string' ? { method: 'GET', url: partial } : partial;

      const prefetchRequest = {
        ...request,
        ...partialReq,
      };
      if (!prefetchRequest.url) return Promise.resolve();

      const key = hashFn({
        ...prefetchRequest,
        url: prefetchRequest.url ?? '',
      });

      const found = cache.getUntracked(key);
      if (found && !found.isStale) return Promise.resolve();

      try {
        await firstValueFrom(
          client.request(prefetchRequest.method ?? 'GET', prefetchRequest.url, {
            ...prefetchRequest,
            context: setCacheContext(prefetchRequest.context, {
              staleTime,
              ttl,
              key: hashFn({
                ...prefetchRequest,
                url: prefetchRequest.url ?? '',
              }),
              bustBrowserCache,
              ignoreCacheControl,
              persist,
            }),
            headers: prefetchRequest.headers as HttpHeaders,
            observe: 'response',
          }),
        );

        return;
      } catch (err) {
        if (isDevMode()) console.error('Prefetch failed: ', err);
        return;
      }
    },
  };

  // Auto-register into the nearest transition scope if the (merged) options ask for it.
  applyResourceRegistration(
    ref as ResourceRef<unknown>,
    options.register,
    options?.injector,
  );

  return ref;
}
