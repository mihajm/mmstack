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
  type WritableSignal,
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
  mergeCircuitBreakerOptions,
  mergeRetryOptions,
} from './util';

const NULL_VALUE = Symbol('@mmstack/resource:null');

/**
 * Why a {@link MutationResourceRef.mutateAsync} promise was cancelled — a closed
 * set so consumers can branch on the cause without parsing the message:
 * - `'superseded'`: a newer mutation replaced it (latest-wins).
 * - `'queue-cleared'`: dropped from the queue by `clearQueue()`.
 * - `'queue-key-changed'`: dropped from the queue by a reactive `key` change.
 * - `'destroyed'`: the resource was destroyed while it was pending/in flight.
 * - `'no-request'`: `request()` returned `undefined`, so nothing was sent.
 */
export type MutationCancellationReason =
  | 'superseded'
  | 'queue-cleared'
  | 'queue-key-changed'
  | 'destroyed'
  | 'no-request';

/**
 * Rejection reason for a {@link MutationResourceRef.mutateAsync} promise whose
 * mutation never completed. The {@link MutationCancelledError.type} discriminant
 * carries the cause ({@link MutationCancellationReason}); the message is a
 * human-readable elaboration of it.
 *
 * Only `mutateAsync` promises reject with this; plain `mutate()` calls have no
 * promise and so produce no (potentially unhandled) rejection.
 */
export class MutationCancelledError extends Error {
  constructor(
    readonly type: MutationCancellationReason,
    message: string,
  ) {
    super(message);
    this.name = 'MutationCancelledError';
  }
}

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
 * Object form of the `queue` option. Enabling the queue serializes mutations
 * into a FIFO that runs one-at-a-time.
 */
export type MutationQueueOptions = {
  /**
   * Reactive queue key. When its returned value changes, the *pending* (not-yet-fired)
   * queued mutations are dropped; an in-flight mutation is unaffected. e.g. `key: () => selectedId()`.
   */
  key?: () => string | number;
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
   * Queue mutations and run them one-at-a-time in series, instead of latest-wins
   * superseding (e.g. while offline or the circuit breaker is open). Pass
   * {@link MutationQueueOptions} for a reactive `key` that resets the pending queue.
   * The pending queue can also be cleared via `ref.clearQueue()`.
   * @default false
   */
  queue?: boolean | MutationQueueOptions;
  /**
   * Cache entries to invalidate after a SUCCESSFUL mutation — the declarative
   * alternative to calling `injectQueryCache().invalidatePrefix(...)` in `onSuccess`.
   *
   * Each string is a URL prefix matched against the request URL of every cached
   * entry, regardless of HTTP method: `'/api/posts'` invalidates `/api/posts` with
   * any query params, plus subpaths like `/api/posts/123` — and all `varyHeaders`
   * variants of each — across GET/HEAD/OPTIONS/POST or whatever methods you cache.
   * Note that plain prefix matching also catches sibling paths sharing the prefix
   * (`/api/posts-archive`); pass `'/api/posts/'` or the exact URL to narrow.
   *
   * Keys built by a custom `cache.hash` that merely *prepends* a namespace (e.g. a
   * tenant/`sub` for per-user persistent caches) are still matched — the URL is
   * recovered structurally. Keys that abandon the auto shape entirely need an
   * a custom invalidateMatcher (or manual `injectQueryCache().invalidateWhere`).
   *
   * The function form receives the mutation result and the mutated value:
   * ```ts
   * invalidates: (saved) => [`/api/posts`, `/api/users/${saved.authorId}`]
   * ```
   */
  invalidates?:
    | string[]
    | ((value: NoInfer<TResult>, mutation: NoInfer<TMutation>) => string[]);
  /**
   * override for how {@link MutationResourceOptions.invalidates} URL
   * prefixes map onto cache keys — given a prefix, return a key predicate.
   */
  invalidateMatcher?: (urlPrefix: string) => (key: string) => boolean;
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
   * Executes the mutation and returns a `Promise`
   *
   * If the mutation never completes — superseded by a newer `mutate`/`mutateAsync`
   * (latest-wins), dropped from the queue (`clearQueue` / queue `key` change),
   * abandoned on `destroy()`, or its `request()` returned `undefined` — the
   * promise rejects with a {@link MutationCancelledError}.
   *
   * @param value The mutation value (usually the request body).
   * @param ctx An optional initial context value that will be passed to the `onMutate` callback.
   */
  mutateAsync: (value: TMutation, ctx?: TICTX) => Promise<TResult>;
  /**
   * A signal that holds the current mutation request, or `null` if no mutation is in progress.
   * This can be useful for tracking the state of the mutation or for displaying loading indicators.
   */
  current: Signal<TMutation | null>;
  /**
   * Drops all *pending* queued mutations; an in-flight mutation is unaffected.
   * Noops when `queue` is not enabled.
   */
  clearQueue: () => void;
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
// The request callback maps the mutation value into an HTTP request. `body` is a
// free-form request field (Angular's `body?: unknown`), independent of `TMutation`
// and optional — so bodyless POSTs and transforms (e.g. params → `FormData`) are fine.
export function mutationResource<
  TResult,
  TRaw = TResult,
  TMutation = TResult,
  TCTX = void,
  TICTX = TCTX,
>(
  request: (params: TMutation) => HttpResourceRequest | undefined | void,
  options0: MutationResourceOptions<TResult, TRaw, TMutation, TCTX, TICTX> = {},
): MutationResourceRef<TResult, TMutation, TICTX> {
  // Two-layer option injection: per-call > provideMutationResourceOptions > provideResourceOptions.
  const globalOpts = injectResourceOptions(options0.injector);
  const mutOpts = injectMutationResourceOptions(options0.injector);

  const options = {
    ...globalOpts,
    ...mutOpts,
    ...options0,
    circuitBreaker: mergeCircuitBreakerOptions(
      globalOpts.circuitBreaker,
      mutOpts.circuitBreaker,
      options0?.circuitBreaker,
    ),
    retry: mergeRetryOptions(globalOpts.retry, mutOpts.retry, options0?.retry),
  } as MutationResourceOptions<TResult, TRaw, TMutation, TCTX, TICTX>;

  const {
    onMutate,
    onError,
    onSuccess,
    onSettled,
    equal,
    register,
    equalRequest,
    invalidates,
    invalidateMatcher,
    ...rest
  } = options;

  const cache = invalidates ? injectQueryCache(options.injector) : undefined;

  const requestEqual = equalRequest ?? createEqualRequest(equal);

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

  const queueEnabled = !!options.queue;
  const queueKeyFn =
    typeof options.queue === 'object' ? options.queue.key : undefined;

  type QueueEntry = [
    TMutation,
    TICTX | undefined,
    PromiseWithResolvers<TResult> | undefined,
  ];

  const queue = linkedSignal<
    string | number | undefined,
    WritableSignal<QueueEntry[]>
  >({
    source: () => queueKeyFn?.(),
    computation: (_key, prev) => {
      // On a queue key change the previous pending entries are dropped — reject any
      // mutateAsync promises waiting on them so awaiters don't hang.
      if (prev)
        for (const [, , deferred] of untracked(prev.value))
          deferred?.reject(
            new MutationCancelledError(
              'queue-key-changed',
              'mutation dropped: queue key changed before it ran',
            ),
          );
      return signal<QueueEntry[]>([]);
    },
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

  let ctx: TCTX = undefined as TCTX;
  let currentDeferred: PromiseWithResolvers<TResult> | undefined;

  const begin = (
    value: TMutation,
    ictx: TICTX | undefined,
    deferred: PromiseWithResolvers<TResult> | undefined,
  ) => {
    let nextCtx: TCTX;
    try {
      nextCtx = onMutate?.(value, ictx) as TCTX;
    } catch (mutationErr) {
      // match legacy mutate(): the throw aborts the mutation and resets state
      ctx = undefined as TCTX;
      next.set(NULL_VALUE);
      deferred?.reject(mutationErr);
      if (isDevMode())
        console.error(
          '[@mmstack/resource]: error thrown in onMutate hook, mutation was not applied',
          mutationErr,
        );
      return;
    }

    ctx = nextCtx;
    currentDeferred = deferred;
    next.set(value);

    if (deferred && untracked(req) === undefined) {
      ctx = undefined as TCTX;
      currentDeferred = undefined;
      next.set(NULL_VALUE);
      deferred.reject(
        new MutationCancelledError(
          'no-request',
          'mutation not sent: request() returned undefined',
        ),
      );
    }
  };

  const supersedeInFlight = () => {
    if (untracked(next) === NULL_VALUE) return;
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
    currentDeferred?.reject(
      new MutationCancelledError(
        'superseded',
        'mutation superseded by a newer mutation (latest-wins)',
      ),
    );
    currentDeferred = undefined;
    ctx = undefined as TCTX;
  };

  const queueRef = effect(
    () => {
      const q = queue(); // subscribe to swaps (key change / clearQueue)
      const nextInQueue = q().at(0); // subscribe to contents
      if (nextInQueue === undefined || next() !== NULL_VALUE) return;
      q.update((arr) => arr.slice(1));
      const [value, ictx, deferred] = nextInQueue;
      begin(value, ictx, deferred);
    },
    { injector: options.injector },
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

  const error$ = toObservable(resource.error, { injector: options.injector });
  const value$ = toObservable(resource.value, {
    injector: options.injector,
  }).pipe(catchError(() => of(NULL_VALUE)));

  const statusSub = toObservable(resource.status, {
    injector: options.injector,
  })
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
      const deferred = currentDeferred;
      currentDeferred = undefined;

      if (result.status === 'error') {
        onError?.(result.error, ctx);
        deferred?.reject(result.error);
      } else {
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

          for (const prefix of prefixes)
            cache.invalidateUrlPrefix(prefix, invalidateMatcher);
        }

        deferred?.resolve(result.value);
      }

      onSettled?.(ctx);
      ctx = undefined as TCTX;
      next.set(NULL_VALUE);
    });

  const ref: MutationResourceRef<TResult, TMutation, TICTX> = {
    ...resource,
    destroy: () => {
      // queue first — a late queue flush must not poke an already-destroyed resource
      queueRef.destroy();
      statusSub.unsubscribe();
      // reject any outstanding mutateAsync promises so awaiters don't hang
      const cancelled = new MutationCancelledError(
        'destroyed',
        'mutation abandoned: resource destroyed',
      );
      currentDeferred?.reject(cancelled);
      currentDeferred = undefined;
      for (const [, , deferred] of untracked(queue)())
        deferred?.reject(cancelled);
      resource.destroy();
    },
    mutate: (value, ictx) => {
      if (queueEnabled) {
        queue().update((arr) => [...arr, [value, ictx, undefined]]);
        return;
      }
      supersedeInFlight();
      begin(value, ictx, undefined);
    },
    mutateAsync: (value, ictx) => {
      const deferred = Promise.withResolvers<TResult>();
      if (queueEnabled) {
        queue().update((arr) => [...arr, [value, ictx, deferred]]);
      } else {
        supersedeInFlight();
        begin(value, ictx, deferred);
      }
      return deferred.promise;
    },
    current: computed(() => {
      const nv = next();
      return nv === NULL_VALUE ? null : nv;
    }),
    clearQueue: () => {
      if (!queueEnabled) return;
      const dropped = untracked(queue)();
      queue.set(signal<QueueEntry[]>([]));
      // reject mutateAsync promises whose entries we just dropped
      for (const [, , deferred] of dropped)
        deferred?.reject(
          new MutationCancelledError(
            'queue-cleared',
            'mutation dropped: queue cleared before it ran',
          ),
        );
    },
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
