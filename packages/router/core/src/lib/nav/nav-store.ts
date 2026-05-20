import {
  computed,
  EnvironmentInjector,
  inject,
  Injectable,
  runInInjectionContext,
  type Signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { mutable } from '@mmstack/primitives';
import { injectLeafRoutes } from '../util';
import {
  createInternalNavItem,
  type CreateNavItem,
  type InternalNavItem,
  type NavItem,
  NEVER_TRUE,
} from './nav';
import { injectNavConfig, type NavDefaultsForScope } from './nav-config';

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
  private readonly router = inject(Router);
  private readonly config = injectNavConfig();
  private readonly injector = inject(EnvironmentInjector);
  private readonly defaultsCache = new Map<
    ScopeName,
    AnyInternalNavItem[] | null
  >();

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
      if (scopeMap) {
        const leaves = this.leafRoutes();
        for (let i = leaves.length - 1; i >= 0; i--) {
          const items = scopeMap.get(leaves[i].path);
          if (items) {
            return items.filter((it) => !it.hidden()) as NavItem<TMeta>[];
          }
        }
      }

      const defaults = this.getDefaultItems(name);
      if (defaults) {
        return defaults.filter((it) => !it.hidden()) as NavItem<TMeta>[];
      }
      return [];
    });
  }

  private getDefaultItems(scope: ScopeName): AnyInternalNavItem[] | null {
    const cached = this.defaultsCache.get(scope);
    if (cached !== undefined) return cached;

    const built = this.buildDefaultItems(scope);
    this.defaultsCache.set(scope, built);
    return built;
  }

  private buildDefaultItems(scope: ScopeName): AnyInternalNavItem[] | null {
    const defaults = this.config.defaults;
    if (!defaults) return null;

    let entry: NavDefaultsForScope | undefined;
    if (Array.isArray(defaults) || typeof defaults === 'function') {
      if (scope === DEFAULT_NAV_SCOPE) entry = defaults;
    } else {
      const key = scope === DEFAULT_NAV_SCOPE ? '' : scope;
      entry = (defaults as Record<string, NavDefaultsForScope>)[key];
    }
    if (!entry) return null;
    const resolved = entry;

    return untracked(() =>
      runInInjectionContext(this.injector, () => {
        const inputs =
          typeof resolved === 'function' ? resolved() : resolved;
        const rootSnapshot = this.router.routerState.snapshot.root;
        const prefix =
          scope === DEFAULT_NAV_SCOPE
            ? '__defaults__'
            : `__defaults__:${scope}`;
        return inputs.map((input: CreateNavItem, i) =>
          createInternalNavItem(
            input,
            this.router,
            rootSnapshot,
            this.config.activeMatch,
            NEVER_TRUE,
            NEVER_TRUE,
            `${prefix}#${i}`,
          ),
        ) as AnyInternalNavItem[];
      }),
    );
  }
}

/**
 * Returns a reactive list of nav items for the requested scope.
 *
 * The returned signal reflects the nearest active ancestor route that registered items
 * for `name` via `createNavItems`. If no active route has registered items for the
 * scope, falls back to `NavConfig.defaults` (when provided via `provideNavConfig`).
 * Hidden items are filtered out.
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
