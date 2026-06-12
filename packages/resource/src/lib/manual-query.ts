import { HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  inject,
  Injector,
  ResourceStatus,
  signal,
  untracked,
} from '@angular/core';
import { nestedEffect } from '@mmstack/primitives';
import {
  queryResource,
  QueryResourceOptions,
  QueryResourceRef,
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
      if (state.override) return state.override;

      return untracked(request);
    },
    {
      equal: () => false,
    },
  );

  const resource = queryResource(req, options);

  // Shared across trigger() calls: a per-call watcher could observe the PREVIOUS
  // request's `resolved` status before this trigger's load flips the resource to
  // loading (effect ordering within a flush is unspecified) and resolve with stale
  // data; concurrent triggers would also cross-resolve each other's promises.
  let pending: {
    res: (value: TResult) => void;
    rej: (err: unknown) => void;
  }[] = [];
  let watcher: { destroy: () => void } | null = null;

  return {
    ...resource,
    trigger: (override, injectorOverride) => {
      trigger.update((s) => ({
        epoch: s.epoch + 1,
        override,
      }));

      return new Promise<TResult>((res, rej) => {
        if (untracked(req) === undefined) {
          // the request fn produced nothing — no load will ever start, so a watcher
          // would hang this promise forever
          rej(
            new Error(
              '[@mmstack/resource]: trigger() produced no request (the request fn returned undefined)',
            ),
          );
          return;
        }

        pending.push({ res, rej });

        // an active watcher (concurrent trigger) settles ALL pending promises with
        // the final result of the latest request — TanStack-style latest-wins
        if (watcher) return;

        // only accept a settle AFTER the load for this trigger has been observed —
        // the pre-trigger status may still be a stale `resolved`/`error`
        let sawLoading = false;

        watcher = nestedEffect(
          () => {
            const status = resource.status();

            if (
              status === ResourceStatus.Loading ||
              status === ResourceStatus.Reloading
            ) {
              sawLoading = true;
              return;
            }
            if (!sawLoading) return;

            if (
              status === ResourceStatus.Resolved ||
              status === ResourceStatus.Error
            ) {
              const settled = pending;
              pending = [];
              watcher?.destroy();
              watcher = null;

              if (status === ResourceStatus.Resolved) {
                const value = untracked(resource.value) as TResult;
                settled.forEach((p) => p.res(value));
              } else {
                const err = untracked(resource.error);
                settled.forEach((p) => p.rej(err));
              }
            }
          },
          { injector: injectorOverride ?? injector },
        );
      });
    },
  };
}
