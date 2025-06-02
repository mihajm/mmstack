import { inject, InjectionToken } from '@angular/core';
import { ResolvedLeafRoute } from './breadcrumb.type';

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
const token = new InjectionToken<BreadcrumbConfig>('MMSTACK_BREADCRUMB_CONFIG');

/**
 * Provides configuration for the breadcrumb system.
 * @param config - A partial `BreadcrumbConfig` object with the desired settings. *
 * @see BreadcrumbConfig
 * @example
 * ```typescript
 * // In your app.module.ts or a standalone component's providers:
 * // import { provideBreadcrumbConfig } from './breadcrumb.config'; // Adjust path
 * // import { ResolvedLeafRoute } from './breadcrumb.type'; // Adjust path
 *
 * // const customLabelStrategy: GenerateBreadcrumbFn = () => {
 * //   return (leaf: ResolvedLeafRoute): string => {
 * //     // Example: Prioritize a 'navTitle' data property
 * //     if (leaf.route.data?.['navTitle']) {
 * //       return leaf.route.data['navTitle'];
 * //     }
 * //     // Fallback to a default mechanism
 * //     return leaf.route.title || leaf.segment.resolved || 'Unnamed';
 * //   };
 * // };
 *
 * export const appConfig = [
 *  // ...rest
 *  provideBreadcrumbConfig({
 *   generation: customLabelStrategy, // or 'manual' to disable auto-generation
 *  }),
 * ]
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
