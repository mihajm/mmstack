import { inject, InjectionToken } from '@angular/core';
import { ResolvedLeafRoute } from '../util';

/**
 * Returns a label generator. The outer function runs in a root injection context;
 * the returned function is wrapped in a computed, so signals it reads update labels reactively.
 */
type GenerateBreadcrumbFn = () => (leaf: ResolvedLeafRoute) => string;

/**
 * Configuration options for the breadcrumb system.
 * Use `provideBreadcrumbConfig` to supply these options to your application.
 */
export type BreadcrumbConfig = {
  /**
   * Defines how breadcrumb labels are generated.
   * - `'manual'`: only manually registered breadcrumbs (via `createBreadcrumb`) are shown.
   * - a {@link GenerateBreadcrumbFn}: custom label generation.
   * - undefined: labels are auto-generated from the route's title, data, or path.
   */
  generation?: 'manual' | GenerateBreadcrumbFn;
};

/**
 * @internal
 */
const token = new InjectionToken<BreadcrumbConfig>(
  '@mmstack/router-core:breadcrumb-config',
);

/**
 * Provides configuration for the breadcrumb system.
 *
 * @param config A partial {@link BreadcrumbConfig}. The `generation` field controls
 *   automatic label generation: `'manual'` disables it (breadcrumbs only show when
 *   {@link createBreadcrumb} explicitly registers them); a function provides a
 *   custom label generator instead of the default route-title-based one.
 * @returns A `Provider` to add to your app's providers array.
 *
 * @see BreadcrumbConfig
 *
 * @example
 * ```ts
 * // Disable automatic generation — breadcrumbs only appear when createBreadcrumb is used
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideRouter(routes),
 *     provideBreadcrumbConfig({ generation: 'manual' }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```ts
 * // Custom label strategy — outer fn runs in injection context, inner is reactive
 * const customLabelStrategy = () => (leaf: ResolvedLeafRoute) =>
 *   leaf.route.data?.['navTitle'] ?? leaf.route.title ?? 'Unnamed';
 *
 * provideBreadcrumbConfig({ generation: customLabelStrategy });
 * ```
 */
export function provideBreadcrumbConfig(config: Partial<BreadcrumbConfig>) {
  return {
    provide: token,
    useValue: {
      ...config,
    },
  };
}

/**
 * @internal
 */
export function injectBreadcrumbConfig(): BreadcrumbConfig {
  return (
    inject(token, {
      optional: true,
    }) ?? {}
  );
}
