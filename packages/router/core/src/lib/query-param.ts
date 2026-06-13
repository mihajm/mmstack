import {
  computed,
  DestroyRef,
  inject,
  isSignal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { toWritable } from '@mmstack/primitives';

/**
 * Options for {@link queryParam}.
 */
export type QueryParamOptions<T = string> = {
  /**
   * Parse the raw URL value into `T`. Provide together with `serialize` for
   * non-string params (numbers, dates, JSON, ...).
   */
  parse?: (value: string) => T | null;
  /**
   * Serialize `T` into the URL value. Return `null` to remove the param.
   */
  serialize?: (value: T) => string | null;
  /**
   * Navigate with `replaceUrl` so writes don't create history entries — the right
   * choice for high-frequency params (search inputs, scroll state).
   * @default false
   */
  replaceUrl?: boolean;
  /**
   * Debounce URL writes by this many milliseconds (reads stay live). Combines well
   * with `replaceUrl` for type-ahead params.
   */
  debounce?: number;
  /**
   * Coalesce writes made in the same microtask into ONE navigation. Off by default:
   * each `set()` navigates immediately (synchronously calling `Router.navigate`).
   *
   * Turn this on when several params are written together in one synchronous block
   * (e.g. resetting a filter set) — otherwise each write rebuilds its `UrlTree` from
   * the pre-navigation URL and only the last one survives. With `batch: true` the
   * patches merge and flush once on a microtask; the resulting navigation keeps a
   * history entry unless every batched writer also set `replaceUrl`.
   * @default false
   */
  batch?: boolean;
  /**
   * The route to bind against.
   * @default inject(ActivatedRoute)
   */
  route?: ActivatedRoute;
};

/** {@link QueryParamOptions} with the parser pair required — enables non-string `T`. */
export type TypedQueryParamOptions<T> = QueryParamOptions<T> & {
  parse: (value: string) => T | null;
  serialize: (value: T) => string | null;
};

/**
 * Default write path: navigate immediately. `merge` PRESERVES keys absent from the
 * provided object and strips null-valued ones — removal therefore requires an explicit
 * `key: null` entry (this is why we patch `null`, never `delete`).
 */
function writeParamNow(
  router: Router,
  route: ActivatedRoute,
  key: string,
  value: string | null,
  replaceUrl: boolean,
): void {
  void router.navigate([], {
    relativeTo: route,
    queryParams: { [key]: value },
    queryParamsHandling: 'merge',
    replaceUrl,
  });
}

/**
 * Opt-in (`batch: true`) write coalescing: each `set()` contributes a patch; ONE
 * navigation flushes them in a microtask. Without this, two params set in the same tick
 * each build their UrlTree from the pre-navigation URL and the second navigation drops
 * the first's change. Keyed per `Router` (per-app), entries deleted on flush — no
 * cross-request state on the server.
 */
type PendingFlush = {
  patch: Record<string, string | null>;
  replaceAll: boolean;
  route: ActivatedRoute;
  scheduled: boolean;
};

const pendingByRouter = new WeakMap<Router, PendingFlush>();

function enqueueParamWrite(
  router: Router,
  route: ActivatedRoute,
  key: string,
  value: string | null,
  replaceUrl: boolean,
): void {
  let pending = pendingByRouter.get(router);
  if (!pending) {
    pending = { patch: {}, replaceAll: true, route, scheduled: false };
    pendingByRouter.set(router, pending);
  }

  pending.patch[key] = value;
  // a history entry is only skipped when EVERY writer in the batch asked to skip it
  pending.replaceAll &&= replaceUrl;

  if (pending.scheduled) return;
  pending.scheduled = true;

  const flush = pending;
  queueMicrotask(() => {
    pendingByRouter.delete(router);
    void router.navigate([], {
      relativeTo: flush.route,
      // `merge` PRESERVES keys absent from this object and strips null-valued ones —
      // removal therefore requires an explicit `key: null` entry, never `delete`
      queryParams: flush.patch,
      queryParamsHandling: 'merge',
      replaceUrl: flush.replaceAll,
    });
  });
}

/**
 * Creates a WritableSignal that synchronizes with a specific URL query parameter,
 * enabling two-way binding between the signal's state and the URL.
 *
 * Reading the signal provides the current value of the query parameter (or null if absent).
 * Setting the signal updates the URL query parameter using `Router.navigate`, triggering
 * navigation and causing the signal to update reactively if the navigation is successful.
 *
 * @param key The key of the query parameter to synchronize with.
 * Can be a static string (e.g., `'search'`) or a function/signal returning a string
 * for dynamic keys. The signal reactively follows key changes.
 * @param routeOrOpt The `ActivatedRoute` to bind against (legacy positional form), or a
 * {@link QueryParamOptions} object — `parse`/`serialize` for typed params, `replaceUrl`,
 * `debounce`, and `route`.
 * @returns A writable signal for the param's value.
 * - Reading returns the current (parsed) value, or `null` if absent.
 * - Setting a value updates the URL (`signal.set('value')` → `?key=value`).
 * - Setting `null` REMOVES the parameter from the URL.
 * - Each `set()` navigates immediately; pass `batch: true` to coalesce same-tick
 *   writes into one navigation.
 *
 * @remarks
 * - Requires Angular's `ActivatedRoute` and `Router` in the injection context.
 * - Uses `Router.navigate` with `queryParamsHandling: 'merge'`, preserving unrelated params.
 * - During SSR it reads from the route snapshot; writes are inert on the server.
 *
 * @example
 * ```ts
 * // string param
 * readonly sort = queryParam('sort');
 * // typed param, no history spam while typing
 * readonly page = queryParam<number>('page', {
 *   parse: (v) => {
 *     const n = parseInt(v, 10);
 *     return Number.isFinite(n) ? n : null;
 *   },
 *   serialize: (n) => (n <= 1 ? null : String(n)), // page 1 keeps the URL clean
 *   replaceUrl: true,
 * });
 * // debounced search input
 * readonly q = queryParam('q', { replaceUrl: true, debounce: 300 });
 * ```
 */
export function queryParam(
  key: string | (() => string),
  routeOrOpt?: ActivatedRoute | QueryParamOptions<string>,
): WritableSignal<string | null>;
export function queryParam<T>(
  key: string | (() => string),
  opt: TypedQueryParamOptions<T>,
): WritableSignal<T | null>;

export function queryParam<T = string>(
  key: string | (() => string),
  routeOrOpt?: ActivatedRoute | QueryParamOptions<T>,
): WritableSignal<T | null> {
  const opt =
    routeOrOpt instanceof ActivatedRoute
      ? ({ route: routeOrOpt } as QueryParamOptions<T>)
      : (routeOrOpt ?? {});

  const route = opt.route ?? inject(ActivatedRoute);
  const router = inject(Router);
  const destroyRef = inject(DestroyRef);

  const parse = opt.parse ?? ((value: string) => value as unknown as T);
  const serialize =
    opt.serialize ?? ((value: T) => value as unknown as string);
  const replaceUrl = opt.replaceUrl ?? false;
  const debounce = opt.debounce ?? 0;
  const batch = opt.batch ?? false;

  const keySignal =
    typeof key === 'string'
      ? computed(() => key)
      : isSignal(key)
        ? key
        : computed(key);

  const queryParamMap = toSignal(route.queryParamMap, {
    initialValue: route.snapshot.queryParamMap,
  });

  const queryParam = computed<T | null>(() => {
    const raw = queryParamMap().get(keySignal());
    return raw === null ? null : parse(raw);
  });

  const writeToUrl = (newValue: T | null) => {
    const serialized = newValue === null ? null : serialize(newValue);
    const key = untracked(keySignal);
    if (batch) enqueueParamWrite(router, route, key, serialized, replaceUrl);
    else writeParamNow(router, route, key, serialized, replaceUrl);
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  destroyRef.onDestroy(() => clearTimeout(debounceTimer));

  const set = (newValue: T | null) => {
    if (!debounce) return writeToUrl(newValue);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => writeToUrl(newValue), debounce);
  };

  return toWritable(queryParam, set);
}
