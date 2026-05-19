import { computed, inject, Injectable, type Signal } from '@angular/core';
import { mutable } from '@mmstack/primitives';
import { injectLeafRoutes } from '../util';
import { type InternalNavItem, type NavItem } from './nav';

/** @internal */
export const DEFAULT_NAV_SCOPE: unique symbol = Symbol('mmstack.nav.default');

type ScopeName = string | typeof DEFAULT_NAV_SCOPE;

// Map stores items with an unknown meta — the public read API re-asserts TMeta.
type AnyInternalNavItem = InternalNavItem<unknown>;

@Injectable({ providedIn: 'root' })
export class NavStore {
  private readonly map = mutable<
    Map<ScopeName, Map<string, AnyInternalNavItem[]>>
  >(new Map());

  private readonly leafRoutes = injectLeafRoutes();

  /** @internal */
  register(
    scope: ScopeName,
    routePath: string,
    items: AnyInternalNavItem[],
  ): void {
    this.map.inline((m) => {
      let scopeMap = m.get(scope);
      if (!scopeMap) {
        scopeMap = new Map();
        m.set(scope, scopeMap);
      }
      scopeMap.set(routePath, items);
    });
  }

  /** @internal */
  scope<TMeta = Record<string, unknown>>(
    name: ScopeName,
  ): Signal<NavItem<TMeta>[]> {
    return computed(() => {
      const scopeMap = this.map().get(name);
      if (!scopeMap) return [];

      const leaves = this.leafRoutes();
      for (let i = leaves.length - 1; i >= 0; i--) {
        const items = scopeMap.get(leaves[i].path);
        if (items) {
          return items.filter((it) => !it.hidden()) as NavItem<TMeta>[];
        }
      }
      return [];
    });
  }
}

/**
 * Returns a reactive list of nav items for the requested scope.
 *
 * The returned signal reflects the nearest active ancestor route that registered items
 * for `name` via `createNavItems`. Hidden items are filtered out.
 *
 * @typeParam TMeta The shape of `NavItem.meta` for the consuming code. Untyped at the
 * registration site — this is a consumer-side assertion.
 *
 * @example
 * ```typescript
 * @Component({
 *   template: `
 *     @for (item of items(); track item) {
 *       <a [href]="item.link()" [class.active]="item.active()">{{ item.label() }}</a>
 *     }
 *   `,
 * })
 * export class TopBar {
 *   protected readonly items = injectNavItems();
 * }
 * ```
 */
export function injectNavItems<TMeta = Record<string, unknown>>(
  name?: string,
): Signal<NavItem<TMeta>[]> {
  const store = inject(NavStore);
  return store.scope<TMeta>(name ?? DEFAULT_NAV_SCOPE);
}
