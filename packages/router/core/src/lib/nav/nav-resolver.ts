import { inject } from '@angular/core';
import { type ResolveFn, Router } from '@angular/router';
import { injectSnapshotPathResolver } from '../util';
import {
  createInternalNavItem,
  type CreateNavItem,
  type InternalNavItem,
  NEVER_TRUE,
} from './nav';
import { injectNavConfig } from './nav-config';
import { DEFAULT_NAV_SCOPE, NavStore } from './nav-store';

/**
 * Registers a set of nav items for the activating route under the given scope.
 * Mirrors `createBreadcrumb` / `createTitle` — designed to be used in a route's
 * `resolve` map.
 *
 * Multiple scopes can be registered on a single route by giving each its own `name`
 * (and a unique key in the `resolve` map):
 *
 * ```typescript
 * resolve: {
 *   mainNav: createNavItems([...], { name: 'main' }),
 *   sideNav: createNavItems([...], { name: 'side' }),
 * }
 * ```
 *
 * Scope override semantics: when multiple routes in the active chain register items
 * under the same scope, the deepest active registration wins. Navigating away restores
 * the shallower registration.
 */
export function createNavItems<TMeta = Record<string, unknown>>(
  itemsOrFactory:
    | CreateNavItem<TMeta>[]
    | (() => CreateNavItem<TMeta>[]),
  options?: { name?: string },
): ResolveFn<void> {
  const factory =
    typeof itemsOrFactory === 'function'
      ? itemsOrFactory
      : () => itemsOrFactory;

  return async (route) => {
    const router = inject(Router);
    const store = inject(NavStore);
    const resolveRoutePath = injectSnapshotPathResolver();
    const config = injectNavConfig();

    const routePath = resolveRoutePath(route);
    const scope = options?.name ?? DEFAULT_NAV_SCOPE;

    const items = factory().map((input, i) =>
      createInternalNavItem<TMeta>(
        input,
        router,
        route,
        config.activeMatch,
        NEVER_TRUE,
        NEVER_TRUE,
        `${routePath}#${i}`,
      ),
    );

    store.register(scope, routePath, items as InternalNavItem<unknown>[]);

    return Promise.resolve();
  };
}
