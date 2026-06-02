import { inject, InjectionToken, type Provider } from '@angular/core';
import { type IsActiveMatchOptions } from '@angular/router';
import { type CreateNavItem } from './nav';

/**
 * Per-scope fallback descriptor: a static array or a factory returning one.
 */
export type NavDefaultsForScope<TMeta = Record<string, unknown>> =
  | CreateNavItem<TMeta>[]
  | (() => CreateNavItem<TMeta>[]);

/**
 * Global configuration for the nav system.
 * @see provideNavConfig
 */
export type NavConfig<TMeta = Record<string, unknown>> = {
  /**
   * Default match options used when computing `NavItem.active`. Per-item `activeMatch`
   * (and the router's built-in `subsetMatchOptions`) are still merged on top.
   */
  activeMatch?: Partial<IsActiveMatchOptions>;
  /**
   * Fallback nav items rendered when no route in the active chain has registered items
   * for the requested scope. Relative `link`s resolve from `/`.
   *
   * Forms:
   * - Array (or factory): fallback for the default (unnamed) scope.
   * - Record: keys match the `name` passed to `createNavItems`. The unnamed scope can
   *   also be provided via this record using the empty-string key `''`.
   *
   * A route that wants to render an *empty* nav explicitly should register
   * `createNavItems([])`, which shadows these defaults via the normal deepest-wins rule.
   */
  defaults?:
    | NavDefaultsForScope<TMeta>
    | Record<string, NavDefaultsForScope<TMeta>>;
};

/** @internal */
const token = new InjectionToken<NavConfig>('@mmstack/router-core:nav-config');

/**
 * Provides global configuration for the nav system. The factory form runs in
 * an injection context, so it can use `inject()` to build defaults from app
 * state.
 *
 * @param config Either a literal {@link NavConfig} object or a factory
 *   `() => NavConfig`. Optional — without it, the nav system uses Angular's
 *   default `activeMatch` options and renders nothing in scopes that have no
 *   registered items.
 * @returns A `Provider` to add to your app's providers array.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideRouter(routes),
 *     provideNavConfig({
 *       activeMatch: { queryParams: 'ignored' },
 *       defaults: [
 *         { label: 'Home', link: '/' },
 *         { label: 'Docs', link: '/docs' },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```ts
 * // Factory form — read defaults from a service
 * provideNavConfig(() => {
 *   const role = inject(AuthStore).role();
 *   return {
 *     defaults: {
 *       main: role === 'admin' ? adminNav : guestNav,
 *     },
 *   };
 * });
 * ```
 */
export function provideNavConfig(
  config?: NavConfig | (() => NavConfig),
): Provider {
  const fn = typeof config === 'function' ? config : () => ({ ...config });
  return {
    provide: token,
    useFactory: fn,
  };
}

/** @internal */
export function injectNavConfig(): NavConfig {
  return inject(token, { optional: true }) ?? {};
}
