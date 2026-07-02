import {
  computed,
  effect,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  makeEnvironmentProviders,
  type Signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  type ParamMap,
  type ResolveFn,
  type Route,
  Router,
} from '@angular/router';
import { provideTransitionScope } from '@mmstack/primitives';
import { filter } from 'rxjs';

/**
 * Context handed to a {@link RouteDataFactory}. Both `params` and `queryParams` are LIVE
 * signals: they update on every navigation, derived from the router state — so a factory
 * defined once keeps producing correct data across param/query changes regardless of the
 * route's `runGuardsAndResolvers` setting.
 */
export type RouteDataContext = {
  readonly params: Signal<Record<string, string>>;
  readonly queryParams: Signal<Record<string, string>>;
  /**
   * Single-param accessor: `param('id')` ≡ a memoized `computed(() => params()['id'] ?? '')`,
   * with a dev-mode error the first time the param is ABSENT from the matched route — so a
   * `:id` vs `param('userId')` typo screams at first navigation instead of silently
   * producing `undefined` URLs. Runtime check only (no type-level path parsing).
   */
  param(name: string): Signal<string>;
  /** `true` only on the prefetch path (no real activation) — lets a factory tune behavior. */
  readonly isPrefetch: boolean;
  /** The injector the factory runs in (route env injector on activation). */
  readonly injector: Injector;
};

/**
 * @internal Builds {@link RouteDataContext.param} over a params signal (shared by the live
 * resolver ctx and the prefetch ctx). Memoized per name; warns once per name.
 */
export function paramAccessor(
  params: Signal<Record<string, string>>,
): (name: string) => Signal<string> {
  const cache = new Map<string, Signal<string>>();
  return (name) => {
    let sig = cache.get(name);
    if (!sig) {
      let warned = false;
      sig = computed(() => {
        const value = params()[name];
        if (value === undefined) {
          if (isDevMode() && !warned) {
            warned = true;
            console.error(
              `[mmstack/router-core] ctx.param('${name}'): no such param on the matched route — check the route's path definition for a typo.`,
            );
          }
          return '';
        }
        return value;
      });
      cache.set(name, sig);
    }
    return sig;
  };
}

/** Builds the route's data from the context. User code — the only place a resource lib is referenced. */
export type RouteDataFactory<T> = (ctx: RouteDataContext) => T;

/** @internal Looks like a resource: a `status()` we can watch. Shared with the prefetcher. */
export type StatusBearing = { status: () => string };

/** @internal */
export function isStatusBearing(value: unknown): value is StatusBearing {
  return !!value && typeof (value as StatusBearing).status === 'function';
}

/** @internal The resource(s) a factory returned: the value itself, or the first-level
 * members of a composite (`{ user, posts }`). Shared with the prefetcher. */
export function statusBearers(value: unknown): StatusBearing[] {
  if (isStatusBearing(value)) return [value];
  if (value && typeof value === 'object')
    return Object.values(value).filter(isStatusBearing);
  return [];
}

export type CreateRouteDataOptions = {
  /**
   * Error hook for the route's data: fires when any status-bearing resource the factory
   * returned (or any first-level member of a composite return) TRANSITIONS into
   * `status() === 'error'` — first load, reloads, and param re-fetches alike. Runs on the
   * LIVE path only: prefetch errors are speculative and never fire this.
   *
   * This is the "what does the app do next" lever — redirect, toast-and-stay, log:
   * ```ts
   * createRouteData(USER, factory, {
   *   onError: (err, ctx) => ctx.injector.get(Router).navigateByUrl('/not-found'),
   * });
   * ```
   * WITHOUT it the default stands: the outlet swaps on settle-by-error and the component
   * renders the slot's `error()` — the in-view error-boundary pattern.
   */
  onError?: (error: unknown, ctx: RouteDataContext) => void;
};

/** A typed handle linking a route's `providers` ({@link provideRouteData}), its `resolve` slot
 * ({@link createRouteData}) and its readers ({@link injectRouteData}). */
export interface RouteDataKey<T> {
  readonly description: string;
  /** @internal */
  readonly token: InjectionToken<RouteDataSlot<T>>;
}

export function routeDataKey<T>(description: string): RouteDataKey<T> {
  return {
    description,
    token: new InjectionToken<RouteDataSlot<T>>(`mmRouteData:${description}`),
  };
}

/** @internal Per-route memoization slot, so a re-running resolver never recreates the value. */
export class RouteDataSlot<T> {
  private ready = false;
  private value!: T;

  ensure(make: () => T): T {
    if (!this.ready) {
      this.value = make();
      this.ready = true;
    }
    return this.value;
  }

  get isReady(): boolean {
    return this.ready;
  }

  read(): T {
    return this.value;
  }
}

/**
 * Route `providers` helper: provides the per-route transition scope (so the resource the
 * resolver creates registers somewhere the {@link TransitionRouterOutlet} can coordinate)
 * and the memoization slot for `key`. Pair with {@link createRouteData} in the route's
 * `resolve` map and {@link injectRouteData} in the component.
 */
export function provideRouteData<T>(
  key: RouteDataKey<T>,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideTransitionScope(),
    { provide: key.token, useFactory: () => new RouteDataSlot<T>() },
  ]);
}

/**
 * Creates an Angular `ResolveFn` that fires the route's data at the resolve phase — before
 * the component constructs, in the route's injector, with the matched params in hand — and
 * is non-blocking (returns the value synchronously; the resource loads async while the
 * outlet holds the previous view). Memoized per route via the slot, so it runs the factory
 * once even if the resolver re-runs.
 *
 * @example
 * ```ts
 * const USER = routeDataKey<ResourceRef<User>>('user');
 * {
 *   path: 'users/:id',
 *   providers: [provideRouteData(USER)],
 *   resolve: {
 *     user: createRouteData(USER, (ctx) =>
 *       queryResource(() => `/api/users/${ctx.params()['id']}`, {
 *         defaultValue: null,
 *         register: 'suspend',
 *       }),
 *     ),
 *   },
 *   component: UserComponent,
 * }
 * // in UserComponent: readonly user = injectRouteData(USER);
 * ```
 */
export function createRouteData<T>(
  key: RouteDataKey<T>,
  factory: RouteDataFactory<T>,
  options?: CreateRouteDataOptions,
): ResolveFn<T> {
  const resolver: ResolveFn<T> = (snapshot) => {
    const slot = inject(key.token, { optional: true });
    if (!slot)
      throw new Error(
        `[mmstack/router-core] createRouteData("${key.description}") needs provideRouteData(${key.description}) in the same route's providers.`,
      );

    return slot.ensure(() => {
      const injector = inject(Injector);
      const router = inject(Router);
      const params = liveParams(router, snapshot);
      const ctx: RouteDataContext = {
        params,
        param: paramAccessor(params),
        queryParams: liveQueryParams(router, snapshot),
        isPrefetch: false,
        injector,
      };
      const value = factory(ctx);
      const onError = options?.onError;
      if (onError) watchForErrors(value, onError, ctx);
      return value;
    });
  };

  // Tag the resolver so the prefetch path (withRouteData) can discover and run the same
  // factory on preload-intent, keyed by route path — without re-declaring it.
  (resolver as RouteDataTagged)[ROUTE_DATA_TAG] = {
    description: key.description,
    factory: factory as RouteDataFactory<unknown>,
  };

  return resolver;
}

/**
 * @internal Fire `onError` on every TRANSITION into `'error'` of any returned status-bearer.
 * The effect lives in the route's injection context (created inside `slot.ensure`), so it
 * dies with the route — and it exists only on the live path (the prefetch tag carries the
 * factory alone, never options, so speculative warms can't redirect the app).
 */
function watchForErrors(
  value: unknown,
  onError: (error: unknown, ctx: RouteDataContext) => void,
  ctx: RouteDataContext,
): void {
  const bearers = statusBearers(value);
  if (!bearers.length) return;
  const prev = bearers.map(() => '');
  effect(() => {
    bearers.forEach((bearer, i) => {
      const status = bearer.status();
      const was = prev[i];
      prev[i] = status;
      if (status !== 'error' || was === 'error') return;
      const error =
        (bearer as { error?: () => unknown }).error?.() ?? undefined;
      untracked(() => onError(error, ctx));
    });
  });
}

/** @internal */
export const ROUTE_DATA_TAG = Symbol('mmRouteData');

/** @internal */
export type RouteDataTag = {
  readonly description: string;
  readonly factory: RouteDataFactory<unknown>;
};

type RouteDataTagged = { [ROUTE_DATA_TAG]?: RouteDataTag };

/** @internal Read the `{ factory }` tag off a resolver created by {@link createRouteData}. */
export function readRouteDataTag(fn: unknown): RouteDataTag | null {
  return typeof fn === 'function'
    ? ((fn as RouteDataTagged)[ROUTE_DATA_TAG] ?? null)
    : null;
}

/**
 * Tag ANY resolver as prefetchable: `withRouteData()`'s hover/visible pipeline runs
 * `prefetch(ctx)` speculatively — same ephemeral root-parented injector as route-data
 * factories, `ctx.isPrefetch: true`, params extracted from the link URL — while navigation
 * runs the wrapped resolver unchanged. For resolvers whose speculative work is idempotent
 * and cache-shaped: warming translations, priming a dataset, anything a hover may safely
 * start. (`createRouteData` resolvers are already tagged — don't double-tag those.)
 *
 * ```ts
 * resolve: {
 *   i18n: withPrefetch(quoteNs.resolveNamespaceTranslation, {
 *     description: 'quote-i18n',
 *     prefetch: (ctx) => quoteNs.warmNamespaceTranslation(ctx.params()['locale']),
 *   }),
 * }
 * ```
 *
 * Prefetch runs are deduped per link URL + `description`; a returned status-bearing
 * resource is awaited for teardown like any route-data factory, a plain promise just runs.
 */
export function withPrefetch<T>(
  resolver: ResolveFn<T>,
  options: {
    description: string;
    prefetch: (ctx: RouteDataContext) => unknown;
  },
): ResolveFn<T> {
  const tagged: ResolveFn<T> = (route, state) => resolver(route, state);
  (tagged as RouteDataTagged)[ROUTE_DATA_TAG] = {
    description: options.description,
    factory: options.prefetch as RouteDataFactory<unknown>,
  };
  return tagged;
}

/** Read the route data produced by {@link createRouteData} for `key`. */
export function injectRouteData<T>(key: RouteDataKey<T>): T {
  const slot = inject(key.token, { optional: true });
  if (!slot)
    throw new Error(
      `[mmstack/router-core] No route data "${key.description}" in scope. Add provideRouteData(${key.description}) to the route's providers and createRouteData(...) to its resolve map.`,
    );
  if (!slot.isReady)
    throw new Error(
      `[mmstack/router-core] Route data "${key.description}" was not resolved. Wire createRouteData(${key.description}, ...) into the route's resolve map.`,
    );
  return slot.read();
}

// ——— live params, derived from router state (independent of resolver re-runs) ———

function liveParams(
  router: Router,
  snapshot: ActivatedRouteSnapshot,
): Signal<Record<string, string>> {
  const tick = navigationTick(router);
  return computed(
    () => {
      tick();
      const node =
        findByConfig(router.routerState.snapshot.root, snapshot.routeConfig) ??
        snapshot;
      return toRecord(node.paramMap);
    },
    { equal: recordsEqual },
  );
}

function liveQueryParams(
  router: Router,
  snapshot: ActivatedRouteSnapshot,
): Signal<Record<string, string>> {
  const tick = navigationTick(router);
  return computed(
    () => {
      tick();
      return toRecord(
        router.routerState.snapshot.root.queryParamMap ??
          snapshot.queryParamMap,
      );
    },
    { equal: recordsEqual },
  );
}

function navigationTick(router: Router): Signal<unknown> {
  return toSignal(
    router.events.pipe(filter((e) => e instanceof NavigationEnd)),
    { initialValue: null },
  );
}

function findByConfig(
  root: ActivatedRouteSnapshot,
  config: Route | null,
): ActivatedRouteSnapshot | null {
  if (!config) return null;
  const stack: ActivatedRouteSnapshot[] = [root];
  while (stack.length) {
    const node = stack.shift();
    if (!node) continue;
    if (node.routeConfig === config) return node;
    stack.push(...node.children);
  }
  return null;
}

function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function toRecord(pm: ParamMap): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const key of pm.keys) {
    const value = pm.get(key);
    if (value != null) rec[key] = value;
  }
  return rec;
}
