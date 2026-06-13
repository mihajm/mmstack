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
 * Mirrors {@link createBreadcrumb} / {@link createTitle} — designed to be used
 * in a route's `resolve` map.
 *
 * Scope override semantics: when multiple routes in the active chain register
 * items under the same scope, the deepest active registration wins. Navigating
 * away restores the shallower registration. To explicitly render an empty nav
 * (shadowing a default), pass `[]`.
 *
 * @typeParam TMeta Optional per-item metadata type — flows through the
 *   registered items so consumers reading via {@link injectNavItems} get
 *   typed access to `item.meta`.
 * @param itemsOrFactory Either a static array of {@link CreateNavItem} or a
 *   factory `() => CreateNavItem<TMeta>[]` invoked inside an injection
 *   context (so it can use `inject()` for dynamic items).
 * @param options Optional `{ name }` for registering multiple scopes on a
 *   single route. Omit to target the default (unnamed) scope.
 * @returns An Angular `ResolveFn<void>` to wire into a route's `resolve` map.
 *   The resolver registers items as a side effect; the resolved value itself
 *   is unused.
 *
 * @example
 * ```ts
 * // Single default-scope nav
 * {
 *   path: 'app',
 *   resolve: {
 *     _nav: createNavItems([
 *       { label: 'Dashboard', link: 'dashboard' },
 *       { label: 'Reports', link: 'reports' },
 *     ]),
 *   },
 * }
 *
 * // Multiple scopes
 * {
 *   path: 'app',
 *   resolve: {
 *     mainNav: createNavItems([...], { name: 'main' }),
 *     sideNav: createNavItems([...], { name: 'side' }),
 *   },
 * }
 *
 * // Factory using inject()
 * createNavItems(() => {
 *   const auth = inject(AuthStore);
 *   return auth.canAdmin() ? adminItems : userItems;
 * });
 * ```
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
        store.trackNavigation,
      ),
    );

    store.register(scope, routePath, items as InternalNavItem<unknown>[]);

    return Promise.resolve();
  };
}
