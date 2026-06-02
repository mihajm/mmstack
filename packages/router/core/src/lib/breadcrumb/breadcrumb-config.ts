import { inject, InjectionToken } from '@angular/core';
import { ResolvedLeafRoute } from '../util';

/**
 * A function that returns a custom label generation function.
 * The outer function is called in a root injection context
 * The returned function takes a `ResolvedLeafRoute` and produces a string label for the breadcrumb.
 * As the inner function is wrapped in a computed, changes to signals called within it will update the breadcrumb label reactively.
 */
type GenerateBreadcrumbFn = () => (leaf: ResolvedLeafRoute) => string;

/**
 * Configuration options for the breadcrumb system.
 * Use `provideBreadcrumbConfig` to supply these options to your application.
 */

export type BreadcrumbConfig = {
  /**
   * Defines how breadcrumb labels are generated.
   * - If set to `'manual'`, breadcrumbs will only be displayed if manually registered
   * via `createBreadcrumb`. Automatic generation based on routes is disabled.
   * - Alternatively provide a custom label generation function
   * If left undefined, the system will automatically generate labels based on the route's title, data, or path.
   * @see GenerateBreadcrumbFn
   * @example
   * ```typescript
   * // For custom label generation:
   * // const myCustomLabelGenerator = () => (leaf: ResolvedLeafRoute) => {
   * //   return leaf.route.data?.['customTitle'] || leaf.route.routeConfig?.path || 'Default';
   * // };
   * //
   * // config: { generation: myCustomLabelGenerator }
   * ```
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
