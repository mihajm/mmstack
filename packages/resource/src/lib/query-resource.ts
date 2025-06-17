import {
  HttpClient,
  HttpHeaders,
  httpResource,
  HttpResponse,
  type HttpResourceOptions,
  type HttpResourceRef,
  type HttpResourceRequest,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  isDevMode,
  linkedSignal,
  Signal,
  untracked,
} from '@angular/core';
import { toWritable } from '@mmstack/primitives';
import { firstValueFrom } from 'rxjs';
import {
  catchValueError,
  CircuitBreakerOptions,
  createCircuitBreaker,
  createEqualRequest,
  hasSlowConnection,
  injectQueryCache,
  persistResourceValues,
  refresh,
  retryOnError,
  setCacheContext,
  toResourceObject,
  urlWithParams,
  type RetryOptions,
} from './util';

/**
 * Options for configuring caching behavior of a `queryResource`.
 * - `true`: Enables caching with default settings.
 * - `{ ttl?: number; staleTime?: number; hash?: (req: HttpResourceRequest) => string; }`:  Configures caching with custom settings.
 */
type ResourceCacheOptions =
  | true
  | {
      /**
       * The Time To Live (TTL) for the cached data, in milliseconds. After this time, the cached data is
       * considered expired and will be refetched.
       */
      ttl?: number;
      /**
       * The duration, in milliseconds, during which stale data can be served while a revalidation request
       * is made in the background.
       */
      staleTime?: number;
      /**
       * A custom function to generate the cache key. Defaults to using the request URL with parameters.
       * Provide a custom hash function if you need more control over how cache keys are generated,
       * for instance, to ignore certain query parameters or to use request body for the cache key.
       */
      hash?: (req: HttpResourceRequest) => string;
    };

/**
 * Options for configuring a `queryResource`.
 */
export type QueryResourceOptions<TResult, TRaw = TResult> = HttpResourceOptions<
  TResult,
  TRaw
> & {
  /**
   * Whether to keep the previous value of the resource while a refresh is in progress.
   * Defaults to `false`. Also keeps status & headers while refreshing.
   */
  keepPrevious?: boolean;
  /**
   * The refresh interval, in milliseconds. If provided, the resource will automatically
   * refresh its data at the specified interval.
   */
  refresh?: number;
  /**
   * Options for retrying failed requests.
   */
  retry?: RetryOptions;
  /**
   * An optional error handler callback.  This function will be called whenever the
   * underlying HTTP request fails. Useful for displaying toasts or other error messages.
   */
  onError?: (err: unknown) => void;
  /**
   * Options for configuring a circuit breaker for the resource.
   */
  circuitBreaker?: CircuitBreakerOptions | true;
  /**
   * Options for enabling and configuring caching for the resource.
   */
  cache?: ResourceCacheOptions;
  /**
   * Trigger a request every time the request function is triggered, even if the request parameters are the same.
   * @default false
   */
  triggerOnSameRequest?: boolean;
};

/**
 * Represents a resource created by `queryResource`. Extends `HttpResourceRef` with additional properties.
 */
export type QueryResourceRef<TResult> = HttpResourceRef<TResult> & {
  /**
   * A signal indicating whether the resource is currently disabled (due to circuit breaker or undefined request).
   */
  disabled: Signal<boolean>;
  /**
   * Prefetches data for the resource, populating the cache if caching is enabled.  This can be
   * used to proactively load data before it's needed.  If a slow connection is detected, prefetching is skipped.
   *
   * @param req - Optional partial request parameters to use for the prefetch.  This allows you
   *              to prefetch data with different parameters than the main resource request.
   */
  prefetch: (req?: Partial<HttpResourceRequest>) => Promise<void>;
};

export function queryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined | void,
  options: QueryResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  },
): QueryResourceRef<TResult>;

/**
 * Creates an extended HTTP resource with features like caching, retries, refresh intervals,
 * circuit breaker, and optimistic updates. Without additional options it is equivalent to simply calling `httpResource`.
 *
 * @param request A function that returns the `HttpResourceRequest` to be made.  This function
 *                is called reactively, so the request can change over time.  If the function
 *                returns `undefined`, the resource is considered "disabled" and no request will be made.
 * @param options Configuration options for the resource.  These options extend the basic
 *                `HttpResourceOptions` and add features like `keepPrevious`, `refresh`, `retry`,
 *                `onError`, `circuitBreaker`, and `cache`.
 * @returns An `QueryResourceRef` instance, which extends the basic `HttpResourceRef` with additional features.
 */
export function queryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined | void,
  options?: QueryResourceOptions<TResult, TRaw>,
): QueryResourceRef<TResult | undefined>;

export function queryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined | void,
  options?: QueryResourceOptions<TResult, TRaw>,
): QueryResourceRef<TResult | undefined> {
  const cache = injectQueryCache(options?.injector);

  const destroyRef = options?.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const cb = createCircuitBreaker(
    options?.circuitBreaker === true
      ? undefined
      : (options?.circuitBreaker ?? false),
  );

  const stableRequest = computed(
    () => {
      if (cb.isClosed()) return undefined;
      return request() ?? undefined;
    },
    {
      equal: options?.triggerOnSameRequest
        ? undefined
        : createEqualRequest(options?.equal),
    },
  );

  const hashFn =
    typeof options?.cache === 'object'
      ? (options.cache.hash ?? urlWithParams)
      : urlWithParams;

  const staleTime =
    typeof options?.cache === 'object' ? options.cache.staleTime : 0;
  const ttl =
    typeof options?.cache === 'object' ? options.cache.ttl : undefined;

  const cacheKey = computed(() => {
    const r = stableRequest();
    if (!r) return null;
    return hashFn(r);
  });

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
          }),
        };
      })
    : stableRequest;

  let resource = toResourceObject(
    httpResource<TResult>(cachedRequest, {
      ...options,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parse: options?.parse as any, // Not my favorite thing to do, but here it is completely safe.
    }) as HttpResourceRef<TResult>,
  );

  resource = catchValueError(resource, options?.defaultValue as TResult);

  // get full HttpResonse from Cache
  const cachedEvent = cache.get(cacheKey);

  const parse = options?.parse ?? ((val: TRaw) => val as unknown as TResult);

  const actualCacheValue = computed((): TResult | undefined => {
    const ce = cachedEvent();
    if (!ce || !(ce.value instanceof HttpResponse)) return;
    return parse(ce.value.body as TRaw);
  });

  // retains last cache value after it is invalidated for lifetime of resource
  const cachedValue = linkedSignal<TResult | undefined, TResult | undefined>({
    source: () => actualCacheValue(),
    computation: (source, prev) => {
      if (!source && prev) return prev.value;
      return source;
    },
  });

  resource = refresh(resource, destroyRef, options?.refresh);
  resource = retryOnError(resource, options?.retry);

  resource = persistResourceValues<TResult>(
    resource,
    options?.keepPrevious,
    options?.equal,
  );

  const value = options?.cache
    ? toWritable(
        computed((): TResult => {
          return cachedValue() ?? resource.value();
        }),
        resource.value.set,
        resource.value.update,
      )
    : resource.value;

  const onError = options?.onError; // Put in own variable to ensure value remains even if options are somehow mutated in-line
  if (onError) {
    const onErrorRef = effect(() => {
      const err = resource.error();
      if (err) onError(err);
    });

    // cleanup on manual destroy, I'm comfortable setting these props in-line as we have yet to 'release' the object out of this lexical scope
    const destroyRest = resource.destroy;
    resource.destroy = () => {
      onErrorRef.destroy();
      destroyRest();
    };
  }

  // iterate circuit breaker state, is effect as a computed would cause a circular dependency (resource -> cb -> resource)
  const cbEffectRef = effect(() => {
    const status = resource.status();
    if (status === 'error') cb.fail();
    else if (status === 'resolved') cb.success();
  });

  const set = (value: TResult) => {
    resource.value.set(value);
    const k = untracked(cacheKey);
    if (options?.cache && k)
      cache.store(
        k,
        new HttpResponse({
          body: value,
          status: 200,
          statusText: 'OK',
        }),
      );
  };

  const update = (updater: (value: TResult) => TResult) => {
    set(updater(untracked(resource.value)));
  };

  const client = options?.injector
    ? options.injector.get(HttpClient)
    : inject(HttpClient);

  return {
    ...resource,
    value,
    set,
    update,
    disabled: computed(() => cb.isClosed() || stableRequest() === undefined),
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

      const request = untracked(cachedRequest);
      if (!request) return Promise.resolve();

      const prefetchRequest = {
        ...request,
        ...partial,
      };

      try {
        await firstValueFrom(
          client.request<TRaw>(
            prefetchRequest.method ?? 'GET',
            prefetchRequest.url,
            {
              ...prefetchRequest,
              headers: prefetchRequest.headers as HttpHeaders,
              observe: 'response',
            },
          ),
        );

        return;
      } catch (err) {
        if (isDevMode()) console.error('Prefetch failed: ', err);
        return;
      }
    },
  };
}
