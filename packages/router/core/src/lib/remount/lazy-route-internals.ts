import { type EnvironmentInjector } from '@angular/core';
import { type Route } from '@angular/router';

/**
 * @internal
 * The single place in this package that touches the router's private `Route` slots.
 *
 * Angular caches a lazy route's resolved children, injector, factory and component onto the
 * `Route` object itself under underscore-prefixed properties. Nothing about that is public API,
 * so every read and write of those names is funnelled through this module: when Angular renames
 * or restructures them, exactly one file breaks and `lazy-route-internals.spec.ts` says so.
 */

/** The private slots Angular writes a lazy route's resolved state into. */
export const LAZY_STATE_SLOTS = [
  '_loadedRoutes',
  '_loadedInjector',
  '_loadedNgModuleFactory',
  '_loadedComponent',
] as const;

/**
 * Slots this package must never find on a router-built `Route`. `_loader$` held the in-flight
 * load in older Angular versions; since the loader moved to a `WeakMap` inside
 * `RouterConfigLoader` there is no route-reachable handle on an in-flight load, which is why
 * invalidation orphans the whole `Route` object instead of clearing slots in place.
 */
export const RETIRED_LAZY_SLOTS = ['_loader$'] as const;

type LazyRoute = Route &
  Record<(typeof LAZY_STATE_SLOTS)[number] | '_injector', unknown>;

/** Where a route sits in the config, so it can be replaced without re-walking. */
export type RouteLocation = {
  readonly container: Route[];
  readonly index: number;
  readonly route: Route;
};

/** The tracked private slots this route currently owns, in declaration order. */
export function ownedLazySlots(route: Route): string[] {
  return LAZY_STATE_SLOTS.filter(
    (slot) => (route as LazyRoute)[slot] !== undefined,
  );
}

/** Names from {@link RETIRED_LAZY_SLOTS} that unexpectedly exist on this route. */
export function retiredLazySlots(route: Route): string[] {
  return RETIRED_LAZY_SLOTS.filter((slot) =>
    Object.hasOwn(route as object, slot),
  );
}

/** `true` once Angular has resolved (or is holding) lazy state for this route. */
export function hasLazyState(route: Route): boolean {
  return ownedLazySlots(route).length > 0;
}

/** The route's lazily-loaded children, or `undefined` if it has none loaded. */
export function loadedChildren(route: Route): Route[] | undefined {
  const loaded = (route as LazyRoute)._loadedRoutes;
  return Array.isArray(loaded) ? (loaded as Route[]) : undefined;
}

/** The injector Angular created for this route's lazy-loaded `NgModule`, if it has one. */
export function loadedInjector(route: Route): EnvironmentInjector | undefined {
  return (route as LazyRoute)._loadedInjector as
    | EnvironmentInjector
    | undefined;
}

function destroyInjectorSlot(
  route: Route,
  slot: '_injector' | '_loadedInjector',
): void {
  const injector = (route as LazyRoute)[slot] as
    | EnvironmentInjector
    | undefined;
  if (!injector) return;
  (route as LazyRoute)[slot] = undefined;
  try {
    injector.destroy();
  } catch {
    // already destroyed
  }
}

/**
 * Destroys the injectors an orphaned route owns through its lazy state: its own loaded-module
 * injector, and both the module and `providers` injectors of every route it loaded.
 *
 * Angular's `destroyUnusedInjectors` only reaches routes still in the config, so a route dropped
 * from it takes its DI with it. The route's own `_injector` is deliberately left alone — that one
 * belongs to the route's `providers` and is carried onto the replacement.
 */
export function destroyLazyInjectors(route: Route): void {
  destroyInjectorSlot(route, '_loadedInjector');
  const queue = [...(loadedChildren(route) ?? [])];
  while (queue.length) {
    const child = queue.shift();
    if (!child) continue;
    destroyInjectorSlot(child, '_injector');
    destroyInjectorSlot(child, '_loadedInjector');
    if (child.children) queue.push(...child.children);
    const loaded = loadedChildren(child);
    if (loaded) queue.push(...loaded);
  }
}

/**
 * A copy of `route` with every lazy-state slot dropped, so the router re-runs `loadChildren` /
 * `loadComponent` for it. The route's own `providers` injector (`_injector`) is carried over —
 * it is not lazy-load state, and dropping it would strand the live injector with no owner.
 */
export function withoutLazyState(route: Route): Route {
  const fresh = { ...route } as LazyRoute;
  for (const slot of LAZY_STATE_SLOTS) delete fresh[slot];
  return fresh;
}

/**
 * Finds the route carrying `marker: id` in `data`, walking eager `children` and lazily-loaded
 * subtrees alike. Returns its container so callers can swap it; route objects are never used as
 * keys because the config replaces them (`Router.resetConfig` shallow-copies every route).
 */
export function findMarkedRoute(
  config: Route[],
  marker: symbol,
  id: string,
): RouteLocation | null {
  const queue: Route[][] = [config];
  const seen = new Set<Route[]>();

  while (queue.length) {
    const container = queue.shift();
    if (!container || seen.has(container)) continue;
    seen.add(container);

    for (let index = 0; index < container.length; index++) {
      const route = container[index];
      if (route.data?.[marker] === id) return { container, index, route };
      if (route.children) queue.push(route.children);
      const loaded = loadedChildren(route);
      if (loaded) queue.push(loaded);
    }
  }

  return null;
}

/** Swaps the route at `location` for `next`, mutating the container the router already holds. */
export function replaceRouteAt(location: RouteLocation, next: Route): void {
  location.container[location.index] = next;
}
