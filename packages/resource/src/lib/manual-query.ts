import { HttpResourceRequest } from '@angular/common/http';
import { computed, inject, Injector, signal, untracked } from '@angular/core';
import { nestedEffect } from '@mmstack/primitives';
import {
  queryResource,
  QueryResourceOptions,
  QueryResourceRef,
} from './query-resource';

/**
 * A reference to a manually triggered query resource.  This type extends the standard `QueryResourceRef`
 * with an additional `trigger` method that allows you to manually trigger the resource request.
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

  return {
    ...resource,
    trigger: (override, injectorOverride) => {
      trigger.update((s) => ({
        epoch: s.epoch + 1,
        override,
      }));

      return new Promise<TResult>((res, rej) => {
        const watcher = nestedEffect(
          () => {
            const status = resource.status();

            if (status === 'resolved') {
              watcher.destroy();
              res(untracked(resource.value) as TResult);
            } else if (status === 'error') {
              watcher.destroy();
              rej(untracked(resource.error));
            }
          },
          { injector: injectorOverride ?? injector },
        );
      });
    },
  };
}
