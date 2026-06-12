import { type HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  type Injector,
  isDevMode,
  linkedSignal,
  type Provider,
  type ResourceRef,
  type Signal,
  signal,
  untracked,
  type ValueEqualityFn,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, combineLatestWith, filter, map, of } from 'rxjs';
import {
  applyResourceRegistration,
  injectResourceOptions,
  provideTypedResourceOptions,
} from './options';
import {
  queryResource,
  type QueryResourceOptions,
  type QueryResourceRef,
} from './query-resource';
import {
  createCircuitBreaker,
  createEqualRequest,
  injectQueryCache,
} from './util';

const NULL_VALUE = Symbol('@mmstack/resource:null');

/**
 * @internal
 * Helper type for inferring the request body type based on the HTTP method.
 */
type NextRequest<
  TMethod extends HttpResourceRequest['method'],
  TMutation,
> = TMethod extends 'DELETE' | 'delete'
  ? Omit<HttpResourceRequest, 'body' | 'method'> & { method: TMethod }
  : Omit<HttpResourceRequest, 'body' | 'method'> & {
      body: TMutation;
      method: TMethod;
    };

/**
 * @internal
 * Helper type for tracking mutation status.
 */
type StatusResult<TResult> =
  | {
      status: 'error';
      error: unknown;
    }
  | {
      status: 'resolved';
      value: TResult;
    };

/**
 * Options for configuring a `mutationResource`. Inherits from
 * `QueryResourceOptions` (minus options that don't apply to mutations:
 * `equal`, `keepPrevious`, `refresh`, `cache`) and adds lifecycle callbacks
 * (`onMutate`, `onError`, `onSuccess`, `onSettled`) for managing optimistic
 * updates, rollback, and side effects.
 *
 * @typeParam TResult - The type of the expected result from the mutation.
 * @typeParam TRaw - The raw response type from the HTTP request (defaults to TResult).
 * @typeParam TCTX - The type of the context value returned by `onMutate`.
 *
 * @example
 * ```ts
 * const options: MutationResourceOptions<User, User, Partial<User>, { previous: User | null }> = {
 *   onMutate: (patch) => {
 *     const previous = current();
 *     current.update((u) => (u ? { ...u, ...patch } : u)); // optimistic
 *     return { previous };
 *   },
 *   onError: (_err, { previous }) => current.set(previous), // rollback
 *   onSuccess: (saved) => toast.success(`Updated ${saved.name}`),
 *   queue: true, // serialize requests when offline / circuit open
 * };
 * ```
 */
export type MutationResourceOptions<
  TResult,
  TRaw = TResult,
  TMutation = TResult,
  TCTX = void,
  TICTX = TCTX,
  TError = unknown,
> = Omit<
  QueryResourceOptions<TResult, TRaw>,
  'equal' | 'onError' | 'keepPrevious' | 'refresh' | 'cache' | 'pause' // we can't keep previous values, refresh, cache or auto-pause mutations as they are meant to be one-off commands
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
  onError?: (error: TError, ctx: NoInfer<TCTX>) => void;
  /**
   * A callback function that is called if the mutation request succeeds.
   * @param value The result of the mutation (the parsed response body).
   * @param ctx The context value returned by the `onMutate` callback (or `undefined` if `onMutate` was not provided or returned `undefined`).
   */
  onSuccess?: (value: TResult, ctx: NoInfer<TCTX>) => void;
  /**
   * A callback function that is called when the mutation request settles (either succeeds or fails).
   * @param ctx The context value returned by the `onMutate` callback (or `undefined` if `onMutate` was not provided or returned `undefined`).
   */
  onSettled?: (ctx: NoInfer<TCTX>) => void;
  /**
   * Whether to queue the mutation requests and execute them in series. For example if network is unavailable or circuit breaker is open.
   * @default false
   */
  queue?: boolean;
  /**
   * Cache entries to invalidate after a SUCCESSFUL mutation — the declarative
   * alternative to calling `injectQueryCache().invalidatePrefix(...)` in `onSuccess`.
   *
   * Each string is a URL prefix matched against auto-generated `GET` cache keys
   * (`GET:${url}:...`): `'/api/posts'` invalidates `/api/posts` with any query params,
   * plus subpaths like `/api/posts/123` — and all `varyHeaders` variants of each.
   * Note that plain prefix matching also catches sibling paths sharing the prefix
   * (`/api/posts-archive`); pass `'/api/posts/'` or the exact URL to narrow.
   *
   * Entries keyed by a custom `hash` function follow that function's shape, not the
   * auto-key shape — invalidate those manually via `injectQueryCache().invalidateWhere`.
   *
   * The function form receives the mutation result and the mutated value:
   * ```ts
   * invalidates: (saved) => [`/api/posts`, `/api/users/${saved.authorId}`]
   * ```
   */
  invalidates?:
    | string[]
    | ((value: NoInfer<TResult>, mutation: NoInfer<TMutation>) => string[]);
  equal?: ValueEqualityFn<TMutation>;
};

const MUTATION_RESOURCE_OPTIONS = new InjectionToken<
  Partial<MutationResourceOptions<any, any, any, any, any, any>>
>('@mmstack/resource:mutation-resource-options', { factory: () => ({}) });

/**
 * Layer 2 (mutation): default options for every `mutationResource`, inheriting + overriding the
 * common defaults from `provideResourceOptions`. Per-call options override these in turn.
 */
export function provideMutationResourceOptions(
  valueOrFn:
    | Partial<MutationResourceOptions<any, any, any, any, any, any>>
    | (() => Partial<MutationResourceOptions<any, any, any, any, any, any>>),
): Provider {
  return provideTypedResourceOptions(MUTATION_RESOURCE_OPTIONS, valueOrFn);
}

function injectMutationResourceOptions(
  injector?: Injector,
): Partial<MutationResourceOptions<any, any, any, any, any, any>> {
  return injector
    ? injector.get(MUTATION_RESOURCE_OPTIONS)
    : inject(MUTATION_RESOURCE_OPTIONS);
}

/**
 * Represents a mutation resource created by `mutationResource`. Extends
 * `QueryResourceRef` but strips methods that don't make sense for one-off
 * writes (`prefetch`, `value`, `hasValue`, `set`, `update`) and adds `mutate()`
 * for triggering a mutation plus `current()` for tracking the in-flight value.
 *
 * @typeParam TResult - The type of the expected result from the mutation.
 *
 * @example
 * ```ts
 * const updateUser = mutationResource<User, User, Partial<User>>(...);
 *
 * effect(() => console.log('mutating:', updateUser.current()));
 * effect(() => {
 *   if (updateUser.status() === 'error') toast.error(updateUser.error());
 * });
 *
 * updateUser.mutate({ name: 'Alice' });
 * ```
 */
export type MutationResourceRef<
  TResult,
  TMutation = TResult,
  TICTX = void,
> = Omit<
  QueryResourceRef<TResult>,
  'prefetch' | 'value' | 'hasValue' | 'set' | 'update' // we don't allow manually viewing the returned data or updating it manually, prefetching a mutation also doesn't make any sense
> & {
  /**
   * Executes the mutation.
   *
   * @param value The mutation value (usually the request body).
   * @param ctx An optional initial context value that will be passed to the `onMutate` callback.
   */
  mutate: (value: TMutation, ctx?: TICTX) => void;
  /**
   * A signal that holds the current mutation request, or `null` if no mutation is in progress.
   * This can be useful for tracking the state of the mutation or for displaying loading indicators.
   */
  current: Signal<TMutation | null>;
};

/**
 * Creates a resource for performing mutations (e.g., POST, PUT, PATCH, DELETE requests).
 * Unlike `queryResource`, `mutationResource` is designed for one-off operations that change data.
 * It does *not* cache responses and does not provide a `value` signal.  Instead, it focuses on
 * managing the mutation lifecycle (pending, error, success) and provides callbacks for handling
 * these states.
 *
 * @param request A function that returns the base `HttpResourceRequest` to be made. This function is called reactively. The parameter is the mutation value provided by the `mutate` method.
 * @param options Configuration options for the mutation resource.  This includes callbacks
 *               for `onMutate`, `onError`, `onSuccess`, and `onSettled`.
 * @typeParam TResult - The type of the expected result from the mutation.
 * @typeParam TRaw - The raw response type from the HTTP request (defaults to TResult).
 * @typeParam TMutation - The type of the mutation value (the request body).
 * @typeParam TICTX - The type of the initial context value passed to `onMutate`.
 * @typeParam TCTX - The type of the context value returned by `onMutate`.
 * @typeParam TMethod - The HTTP method to be used for the mutation (defaults to `HttpResourceRequest['method']`).
 * @returns A `MutationResourceRef` instance, which provides methods for triggering the mutation
 *          and observing its status.
 *
 * @example
 * ```ts
 * // Basic PATCH mutation
 * const updateUser = mutationResource<User, User, Partial<User>>(
 *   (body) => ({ url: `/api/users/${userId()}`, method: 'PATCH', body }),
 *   {
 *     onSuccess: (saved) => toast.success(`Updated ${saved.name}`),
 *     onError: (err) => toast.error(err),
 *   },
 * );
 *
 * updateUser.mutate({ name: 'Alice' });
 * ```
 *
 * @example
 * ```ts
 * // Optimistic update with rollback via the `ctx` returned from `onMutate`
 * const updateUser = mutationResource<User, User, Partial<User>, { prev: User | null }>(
 *   (body) => ({ url: `/api/users/${userId()}`, method: 'PATCH', body }),
 *   {
 *     onMutate: (patch) => {
 *       const prev = current();
 *       current.update((u) => (u ? { ...u, ...patch } : u));
 *       return { prev };
 *     },
 *     onError: (_err, { prev }) => current.set(prev),
 *   },
 * );
 * ```
 */
export function mutationResource<
  TResult,
  TRaw = TResult,
  TMutation = TResult,
  TCTX = void,
  TICTX = TCTX,
  TMethod extends HttpResourceRequest['method'] = HttpResourceRequest['method'],
>(
  request: (
    params: TMutation,
  ) => Omit<NextRequest<TMethod, TMutation>, 'body'> | undefined | void,
  options0: MutationResourceOptions<TResult, TRaw, TMutation, TCTX, TICTX> = {},
): MutationResourceRef<TResult, TMutation, TICTX> {
  // Two-layer option injection: per-call > provideMutationResourceOptions > provideResourceOptions.
  const options = {
    ...injectResourceOptions(options0.injector),
    ...injectMutationResourceOptions(options0.injector),
    ...options0,
  } as MutationResourceOptions<TResult, TRaw, TMutation, TCTX, TICTX>;

  // `register` is pulled out (and forced off on the inner query below) so the mutation ref is
  // the only thing registered into the transition scope, not its internal query resource.
  const {
    onMutate,
    onError,
    onSuccess,
    onSettled,
    equal,
    register,
    equalRequest,
    invalidates,
    ...rest
  } = options;

  const cache = invalidates ? injectQueryCache(options.injector) : undefined;

  const requestEqual = equalRequest ?? createEqualRequest(equal);

  // A mutation is an imperative command, so `triggerOnSameRequest` means "fire on EVERY mutate(),
  // even with an identical body". By default we dedup an identical value/request while one is in
  // flight (double-click protection); when this is set, both the `next` and `req` dedup are bypassed
  // so a repeat click isn't silently swallowed mid-flight. (Otherwise it'd be dropped until `next`
  // resets to NULL on settle — the "every other click" symptom.)
  const triggerOnSame = options.triggerOnSameRequest ?? false;

  const eq = equal ?? Object.is;
  const next = signal<TMutation | typeof NULL_VALUE>(NULL_VALUE, {
    equal: (a, b) => {
      if (a === NULL_VALUE && b === NULL_VALUE) return true;
      if (a === NULL_VALUE || b === NULL_VALUE) return false;
      if (triggerOnSame) return false;
      return eq(a, b);
    },
  });

  const queue = signal<[TMutation, TICTX | undefined][]>([]);

  let ctx: TCTX = undefined as TCTX;

  const queueRef = effect(() => {
    const nextInQueue = queue().at(0);
    if (nextInQueue === undefined || next() !== NULL_VALUE) return;
    queue.update((q) => q.slice(1));
    const [value, ictx] = nextInQueue;
    try {
      ctx = onMutate?.(value, ictx) as TCTX;
      next.set(value);
    } catch (mutationErr) {
      ctx = undefined as TCTX;
      next.set(NULL_VALUE);
      if (isDevMode())
        console.error(
          '[@mmstack/resource]: error thrown in onMutate hook, mutation was not applied',
          mutationErr,
        );
    }
  });

  const req = computed(
    (): HttpResourceRequest | undefined => {
      const nr = next();
      if (nr === NULL_VALUE) return;

      return request(nr) ?? undefined;
    },
    {
      equal: (a, b) => {
        if (a === undefined && b === undefined) return true;
        if (a === undefined || b === undefined) return false;
        if (triggerOnSame) return false;
        return requestEqual(a, b);
      },
    },
  );

  const lastValue = linkedSignal<
    TMutation | typeof NULL_VALUE,
    TMutation | typeof NULL_VALUE
  >({
    source: next,
    computation: (next, prev) => {
      if (next === NULL_VALUE && !!prev) return prev.value;
      return next;
    },
  });

  const lastValueRequest = computed(
    (): HttpResourceRequest | undefined => {
      const nr = lastValue();
      if (nr === NULL_VALUE) return;

      return request(nr) ?? undefined;
    },
    {
      equal: (a, b) => {
        if (a === b) return true;
        if (a === undefined || b === undefined) return false;
        return requestEqual(a, b);
      },
    },
  );

  const cb = createCircuitBreaker(
    options?.circuitBreaker === true
      ? undefined
      : (options?.circuitBreaker ?? false),
    options?.injector,
  );

  const resource = queryResource<TResult, TRaw>(req, {
    ...rest,
    register: false, // the mutation ref handles registration; never register the inner query
    circuitBreaker: cb,
    equalRequest: requestEqual,
    defaultValue: NULL_VALUE as unknown as TResult, // doesnt matter since .value is not accessible
  });

  const destroyRef = options.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const error$ = toObservable(resource.error);
  const value$ = toObservable(resource.value).pipe(
    catchError(() => of(NULL_VALUE)),
  );

  const statusSub = toObservable(resource.status)
    .pipe(
      combineLatestWith(error$, value$),
      map(
        ([status, error, value]): StatusResult<TResult> | typeof NULL_VALUE => {
          if (status === 'error' && error) {
            return {
              status: 'error',
              error,
            };
          }

          if (status === 'resolved' && value !== NULL_VALUE) {
            return {
              status: 'resolved',
              value,
            };
          }

          return NULL_VALUE;
        },
      ),
      filter((v) => v !== NULL_VALUE),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((result) => {
      if (result.status === 'error') onError?.(result.error, ctx);
      else {
        onSuccess?.(result.value, ctx);

        if (cache && invalidates) {
          const mutation = untracked(lastValue);
          const prefixes =
            typeof invalidates === 'function'
              ? invalidates(
                  result.value,
                  (mutation === NULL_VALUE ? undefined : mutation) as TMutation,
                )
              : invalidates;

          // auto-keys are `${method}:${url}:...` — a `GET:`-prefixed url prefix hits
          // the url with any params/subpaths and every varyHeaders variant
          for (const prefix of prefixes)
            cache.invalidatePrefix(`GET:${prefix}`);
        }
      }

      onSettled?.(ctx);
      ctx = undefined as TCTX;
      next.set(NULL_VALUE);
    });

  const shouldQueue = options.queue ?? false;

  const ref: MutationResourceRef<TResult, TMutation, TICTX> = {
    ...resource,
    destroy: () => {
      // queue first — a late queue flush must not poke an already-destroyed resource
      queueRef.destroy();
      statusSub.unsubscribe();
      resource.destroy();
    },
    mutate: (value, ictx) => {
      if (shouldQueue) {
        return queue.update((q) => [...q, [value, ictx]]);
      } else {
        // latest-wins: a mutation already in flight gets superseded (its request is
        // aborted by the request change), so its onSuccess/onError will never fire —
        // settle its context NOW so optimistic state can be rolled back/cleaned up
        if (untracked(next) !== NULL_VALUE) {
          if (isDevMode())
            console.warn(
              '[@mmstack/resource]: mutate() called while another mutation was in flight — the previous mutation was superseded (latest-wins) and its onSettled was invoked. Use `queue: true` for sequential mutations.',
            );
          try {
            onSettled?.(ctx);
          } catch (settleErr) {
            if (isDevMode())
              console.error(
                '[@mmstack/resource]: error thrown in onSettled hook for a superseded mutation',
                settleErr,
              );
          }
          ctx = undefined as TCTX;
        }

        try {
          ctx = onMutate?.(value, ictx) as TCTX;
          next.set(value);
        } catch (mutationErr) {
          ctx = undefined as TCTX;
          next.set(NULL_VALUE);
          if (isDevMode())
            console.error(
              '[@mmstack/resource]: error thrown in onMutate hook, mutation was not applied',
              mutationErr,
            );
        }
      }
    },
    current: computed(() => {
      const nv = next();
      return nv === NULL_VALUE ? null : nv;
    }),
    // redeclare disabled with last value so that it is not affected by the resource's internal disablement logic
    disabled: computed(() => cb.isOpen() || lastValueRequest() === undefined),
  };

  applyResourceRegistration(
    ref as unknown as ResourceRef<unknown>,
    register,
    options0.injector,
  );

  return ref;
}
