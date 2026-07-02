import {
  computed,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  Injector,
  makeEnvironmentProviders,
  type Signal,
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
  /** `true` only on the prefetch path (no real activation) — lets a factory tune behavior. */
  readonly isPrefetch: boolean;
  /** The injector the factory runs in (route env injector on activation). */
  readonly injector: Injector;
};

/** Builds the route's data from the context. User code — the only place a resource lib is referenced. */
export type RouteDataFactory<T> = (ctx: RouteDataContext) => T;

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
      const ctx: RouteDataContext = {
        params: liveParams(router, snapshot),
        queryParams: liveQueryParams(router, snapshot),
        isPrefetch: false,
        injector,
      };
      return factory(ctx);
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
      return mergedParams(node);
    },
    { equal: recordsEqual },
  );
}

/**
 * Merge the ancestor chain's params (root → node), so a child factory sees inherited parent
 * params (e.g. a parent route's `:orgId`) regardless of Angular's `paramsInheritanceStrategy`.
 * This matches the prefetch path, which extracts params from the full config path — a child's
 * own param shadows a same-named ancestor's (it's last in `pathFromRoot`).
 */
function mergedParams(node: ActivatedRouteSnapshot): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const n of node.pathFromRoot) Object.assign(rec, toRecord(n.paramMap));
  return rec;
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
