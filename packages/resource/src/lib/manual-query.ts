import { type HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
  untracked,
  type ResourceRef,
} from '@angular/core';
import { nestedEffect } from '@mmstack/primitives';
import { applyResourceRegistration } from './options';
import { type InternalQueryHooks, ON_FINAL_ERROR } from './util/internal-hooks';
import {
  queryResource,
  type QueryResourceOptions,
  type QueryResourceRef,
} from './query-resource';

/**
 * A reference to a manually triggered query resource. Extends
 * {@link QueryResourceRef} with a `trigger()` method that runs the request
 * imperatively and returns a `Promise<TResult>`. Useful when a request should
 * only happen on user action (search submit, button click) rather than on
 * every reactive change of the request inputs.
 *
 * @example
 * ```ts
 * const search = manualQueryResource<SearchResults>(() => ({
 *   url: '/api/search',
 *   params: { q: query() },
 * }));
 *
 * async function onSubmit() {
 *   try {
 *     const results = await search.trigger();
 *     showResults(results);
 *   } catch (err) {
 *     toast.error('Search failed');
 *   }
 * }
 * ```
 *
 * @see QueryResourceRef
 */
export type ManualQueryResourceRef<TResult> = QueryResourceRef<TResult> & {
  trigger: (
    req?: HttpResourceRequest | string,
    injector?: Injector,
  ) => Promise<TResult>;
};

/**
 * Creates a manually triggered HTTP resource with features like caching, retries, refresh intervals, circuit breaker, and optimistic updates. Without additional options it is equivalent to simply calling `httpResource`.
 * This overload is for when a `defaultValue` is provided, ensuring that the resource's value is always defined.
 * @param request A function that returns the `HttpResourceRequest` or a URL string to be made.  This function
 *               is called reactively, so the request can change over time.  If the function
 *              returns `undefined`, the resource is considered "disabled" and no request will be made.
 * @param options Configuration options for the resource.  These options extend the basic
 *               `HttpResourceOptions` and add features like `keepPrevious`, `refresh`, `retry`,
 *                `onError`, `circuitBreaker`, and `cache`.  Additionally, when a `defaultValue` is provided, the resource's value will always be defined, even if the underlying HTTP request fails or is disabled.
 * @returns An `ManualQueryResourceRef` instance, which extends the basic `QueryResourceRef` with additional features.
 *
 * @example
 * ```ts
 * const search = manualQueryResource<SearchResults>(
 *   () => ({ url: '/api/search', params: { q: query() } }),
 *   { defaultValue: { hits: [], total: 0 } },
 * );
 *
 * // search.value() is always SearchResults (never undefined) thanks to defaultValue.
 * const results = await search.trigger();
 * ```
 */
export function manualQueryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | string | undefined | void,
  options: QueryResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  },
): ManualQueryResourceRef<TResult>;

/**
 * Creates a manually triggered extended HTTP resource with features like caching, retries, refresh intervals,
 * circuit breaker, and optimistic updates. Without additional options it is equivalent to simply calling `httpResource`.
 *
 * @param request A function that returns the `HttpResourceRequest` or a URL string to be made.  This function
 *                is called reactively, so the request can change over time.  If the function
 *                returns `undefined`, the resource is considered "disabled" and no request will be made.
 * @param options Configuration options for the resource.  These options extend the basic
 *                `HttpResourceOptions` and add features like `keepPrevious`, `refresh`, `retry`,
 *                `onError`, `circuitBreaker`, and `cache`.
 * @returns An `ManualQueryResourceRef` instance, which extends the basic `QueryResourceRef` with additional features.
 *
 * @example
 * ```ts
 * const exportReport = manualQueryResource<Report>(() => ({
 *   url: '/api/reports/export',
 *   params: { range: range() },
 * }));
 *
 * async function onExportClick() {
 *   try {
 *     const report = await exportReport.trigger();
 *     download(report);
 *   } catch (err) {
 *     toast.error('Export failed');
 *   }
 * }
 * ```
 */
export function manualQueryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | string | undefined | void,
  options?: QueryResourceOptions<TResult, TRaw>,
): ManualQueryResourceRef<TResult | undefined>;

export function manualQueryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | string | undefined | void,
  options?: QueryResourceOptions<TResult, TRaw>,
): ManualQueryResourceRef<TResult | undefined> {
  const trigger = signal<{
    epoch: number;
    override?: HttpResourceRequest | string;
  }>(
    { epoch: 0 },
    {
      equal: (a, b) => a.epoch === b.epoch,
    },
  );

  const injector = options?.injector ?? inject(Injector);

  const req = computed(
    () => {
      const state = trigger();
      if (state.epoch === 0) return;
      const r = state.override || untracked(request);
      if (!r) return;
      // a fresh object per trigger, so a trigger equal to the previous one still fetches
      return typeof r === 'string' ? { method: 'GET', url: r } : { ...r };
    },
    {
      equal: () => false,
    },
  );

  let pending: {
    res: (value: TResult) => void;
    rej: (err: unknown) => void;
  }[] = [];
  let watcher: { destroy: () => void } | null = null;
  let sawLoading = false;

  const settle = (fn: (p: (typeof pending)[number]) => void) => {
    const settled = pending;
    pending = [];
    watcher?.destroy();
    watcher = null;
    sawLoading = false;
    settled.forEach(fn);
  };

  const abortError = () =>
    new DOMException('The triggered load was aborted', 'AbortError');

  const resource = queryResource(req, {
    ...options,
    register: false,
    triggerOnSameRequest: true,
    [ON_FINAL_ERROR]: (err: unknown) => {
      if (sawLoading) settle((p) => p.rej(err));
    },
  } as QueryResourceOptions<TResult, TRaw> & InternalQueryHooks);

  injector.get(DestroyRef).onDestroy(() => settle((p) => p.rej(abortError())));

  // An untriggered manual query is READY, not missing data: with `register: 'suspend'`
  // the boundary must only hold while a triggered load is in flight.
  const unregister = applyResourceRegistration(
    {
      status: resource.status,
      isLoading: resource.isLoading,
      hasValue: () => untracked(trigger).epoch === 0 || resource.hasValue(),
      hasContent: () => untracked(trigger).epoch === 0 || resource.hasContent(),
      error: resource.error,
      reload: () => resource.reload(),
      abort: () => resource.abort(),
    } as unknown as ResourceRef<unknown>,
    options?.register,
    injector,
    options?.displayName,
  );

  return {
    ...resource,
    destroy: () => {
      unregister();
      settle((p) => p.rej(abortError()));
      resource.destroy();
    },
    trigger: (override, injectorOverride) => {
      trigger.update((s) => ({
        epoch: s.epoch + 1,
        override,
      }));

      return new Promise<TResult>((res, rej) => {
        if (untracked(req) === undefined) {
          rej(
            new Error(
              '[@mmstack/resource]: trigger() produced no request (the request fn returned undefined)',
            ),
          );
          return;
        }

        pending.push({ res, rej });

        if (watcher) return;

        watcher = nestedEffect(
          () => {
            const status = resource.status();

            if (status === 'loading' || status === 'reloading') {
              sawLoading = true;
              return;
            }
            if (!sawLoading) return;

            if (status === 'resolved') {
              const value = untracked(resource.value) as TResult;
              settle((p) => p.res(value));
            } else if (status === 'local' || status === 'idle') {
              settle((p) => p.rej(abortError()));
            }
          },
          { injector: injectorOverride ?? injector },
        );
      });
    },
  };
}
