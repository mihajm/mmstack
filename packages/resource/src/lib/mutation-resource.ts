import { type HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  inject,
  ResourceStatus,
  Signal,
  signal,
  ValueEqualityFn,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { combineLatestWith, filter, map } from 'rxjs';
import {
  queryResource,
  type QueryResourceOptions,
  type QueryResourceRef,
} from './query-resource';
import { createEqualRequest } from './util';

/**
 * @internal
 * Helper type for inferring the request body type based on the HTTP method.
 */
type NextRequest<
  TMethod extends HttpResourceRequest['method'],
  TMutation,
> = TMethod extends 'DELETE' | 'delete'
  ? Omit<HttpResourceRequest, 'body'>
  : Omit<HttpResourceRequest, 'body'> & { body: TMutation };

/**
 * @internal
 * Helper type for tracking mutation status.
 */
type StatusResult<TResult> =
  | {
      status: ResourceStatus.Error;
      error: unknown;
    }
  | {
      status: ResourceStatus.Resolved;
      value: TResult;
    };

/**
 * Options for configuring a `mutationResource`.
 *
 * @typeParam TResult - The type of the expected result from the mutation.
 * @typeParam TRaw - The raw response type from the HTTP request (defaults to TResult).
 * @typeParam TCTX - The type of the context value returned by `onMutate`.
 */
export type MutationResourceOptions<
  TResult,
  TRaw = TResult,
  TMutation = TResult,
  TCTX = void,
  TICTX = TCTX,
> = Omit<
  QueryResourceOptions<TResult, TRaw>,
  'equal' | 'onError' | 'keepPrevious' | 'refresh' | 'cache' // we can't keep previous values, refresh or cache mutations as they are meant to be one-off operations
> & {
  /**
   * A callback function that is called before the mutation request is made.
   * @param value The value being mutated (the `body` of the request).
   * @returns An optional context value that will be passed to the `onError`, `onSuccess`, and `onSettled` callbacks. This is useful for storing
   *  information needed during the mutation lifecycle, such as previous values for optimistic updates or rollback.
   */
  onMutate?: (value: TMutation, initialCTX?: TICTX) => TCTX;
  /**
   * A callback function that is called if the mutation request fails.
   * @param error The error that occurred.
   * @param ctx The context value returned by the `onMutate` callback (or `undefined` if `onMutate` was not provided or returned `undefined`).
   */
  onError?: (error: unknown, ctx: NoInfer<TCTX>) => void;
  /**
   * A callback function that is called if the mutation request succeeds.
   * @param value The result of the mutation (the parsed response body).
   * @param ctx The context value returned by the `onMutate` callback (or `undefined` if `onMutate` was not provided or returned `undefined`).
   */
  onSuccess?: (value: NoInfer<TResult>, ctx: NoInfer<TCTX>) => void;
  /**
   * A callback function that is called when the mutation request settles (either succeeds or fails).
   * @param ctx The context value returned by the `onMutate` callback (or `undefined` if `onMutate` was not provided or returned `undefined`).
   */
  onSettled?: (ctx: NoInfer<TCTX>) => void;
  equal?: ValueEqualityFn<TMutation>;
};

/**
 * Represents a mutation resource created by `mutationResource`.  Extends `QueryResourceRef`
 * but removes methods that don't make sense for mutations (like `prefetch`, `value`, etc.).
 *
 * @typeParam TResult - The type of the expected result from the mutation.
 */
export type MutationResourceRef<
  TResult,
  TMutation = TResult,
  TICTX = void,
  TMethod extends HttpResourceRequest['method'] = HttpResourceRequest['method'],
> = Omit<
  QueryResourceRef<TResult>,
  'prefetch' | 'value' | 'hasValue' | 'set' | 'update' // we don't allow manually viewing the returned data or updating it manually, prefetching a mutation also doesn't make any sense
> & {
  /**
   * Executes the mutation.
   *
   * @param value The request body and any other request parameters to use for the mutation.  The `body` property is *required*.
   */
  mutate: (value: NextRequest<TMethod, TMutation>, ctx?: TICTX) => void;
  /**
   * A signal that holds the current mutation request, or `null` if no mutation is in progress.
   * This can be useful for tracking the state of the mutation or for displaying loading indicators.
   */
  current: Signal<NextRequest<TMethod, TMutation> | null>;
};

/**
 * Creates a resource for performing mutations (e.g., POST, PUT, PATCH, DELETE requests).
 * Unlike `queryResource`, `mutationResource` is designed for one-off operations that change data.
 * It does *not* cache responses and does not provide a `value` signal.  Instead, it focuses on
 * managing the mutation lifecycle (pending, error, success) and provides callbacks for handling
 * these states.
 *
 * @param request A function that returns the base `HttpResourceRequest` to be made.  This
 *               function is called reactively.  Unlike `queryResource`, the `body` property
 *               of the request is provided when `mutate` is called, *not* here.  If the
 *               function returns `undefined`, the mutation is considered "disabled." All properties,
 *               except the body, can be set here.
 * @param options Configuration options for the mutation resource.  This includes callbacks
 *               for `onMutate`, `onError`, `onSuccess`, and `onSettled`.
 * @typeParam TResult - The type of the expected result from the mutation.
 * @typeParam TRaw - The raw response type from the HTTP request (defaults to TResult).
 * @typeParam TCTX - The type of the context value returned by `onMutate`.
 * @returns A `MutationResourceRef` instance, which provides methods for triggering the mutation
 *          and observing its status.
 */
export function mutationResource<
  TResult,
  TRaw = TResult,
  TMutation = TResult,
  TCTX = void,
  TICTX = TCTX,
  TMethod extends HttpResourceRequest['method'] = HttpResourceRequest['method'],
>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined | void,
  options: MutationResourceOptions<TResult, TRaw, TMutation, TCTX, TICTX> = {},
): MutationResourceRef<TResult, TMutation, TICTX, TMethod> {
  const { onMutate, onError, onSuccess, onSettled, equal, ...rest } = options;

  const requestEqual = createEqualRequest(equal);

  const baseRequest = computed(() => request() ?? undefined, {
    equal: requestEqual,
  });

  const nextRequest = signal<NextRequest<TMethod, TMutation> | null>(null, {
    equal: (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return requestEqual(a, b);
    },
  });

  const req = computed((): HttpResourceRequest | undefined => {
    const nr = nextRequest();
    if (!nr) return;

    const base = baseRequest();

    const url = nr.url ?? base?.url;
    if (!url) return;

    const method = nr.method ?? base?.method;

    return {
      ...base,
      ...nr,
      url,
      method,
    };
  });

  const resource = queryResource<TResult, TRaw>(req, {
    ...rest,
    defaultValue: null as unknown as TResult, // doesnt matter since .value is not accessible
  });

  let ctx: TCTX = undefined as TCTX;

  const destroyRef = options.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const error$ = toObservable(resource.error);
  const value$ = toObservable(resource.value);

  const statusSub = toObservable(resource.status)
    .pipe(
      combineLatestWith(error$, value$),
      map(([status, error, value]): StatusResult<TResult> | null => {
        if (status === ResourceStatus.Error && error) {
          return {
            status: ResourceStatus.Error,
            error,
          };
        }

        if (status === ResourceStatus.Resolved && value !== null) {
          return {
            status: ResourceStatus.Resolved,
            value,
          };
        }

        return null;
      }),
      filter((v) => v !== null),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((result) => {
      if (result.status === ResourceStatus.Error) onError?.(result.error, ctx);
      else onSuccess?.(result.value, ctx);

      onSettled?.(ctx);
      ctx = undefined as TCTX;
      nextRequest.set(null);
    });

  return {
    ...resource,
    destroy: () => {
      statusSub.unsubscribe();
      resource.destroy();
    },
    mutate: (value, ictx) => {
      ctx = onMutate?.(
        (value as HttpResourceRequest).body as TMutation,
        ictx,
      ) as TCTX;
      nextRequest.set(value);
    },
    current: nextRequest,
  };
}
