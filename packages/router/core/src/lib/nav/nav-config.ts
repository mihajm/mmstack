import { inject, InjectionToken, type Provider } from '@angular/core';
import { type IsActiveMatchOptions } from '@angular/router';

/**
 * Global configuration for the nav system.
 * @see provideNavConfig
 */
export type NavConfig = {
  /**
   * Default match options used when computing `NavItem.active`. Per-item `activeMatch`
   * (and the router's built-in `subsetMatchOptions`) are still merged on top.
   */
  activeMatch?: Partial<IsActiveMatchOptions>;
};

/** @internal */
const token = new InjectionToken<NavConfig>('@mmstack/router-core:nav-config');

/**
 * Provides global configuration for the nav system.
 *
 * @example
 * ```typescript
 * provideNavConfig({
 *   activeMatch: { queryParams: 'ignored' },
 * }),
 * ```
 */
export function provideNavConfig(config?: NavConfig): Provider {
  return {
    provide: token,
    useValue: { ...config },
  };
}

/** @internal */
export function injectNavConfig(): NavConfig {
  return inject(token, { optional: true }) ?? {};
}
