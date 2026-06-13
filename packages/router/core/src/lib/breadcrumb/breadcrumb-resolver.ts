import { computed, inject } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  createUrlTreeFromSnapshot,
  Router,
  type ResolveFn,
} from '@angular/router';
import { BreadcrumbStore } from './breadcrumb-store';

/**
 * Options for defining a breadcrumb.
 *
 */
type CreateBreadcrumbOptions = {
  /**
   * The visible text for the breadcrumb.
   * Can be a static string or a function for dynamic labels.
   */
  label: string | (() => string);
  /**
   * An accessible label for the breadcrumb item.
   * Defaults to the value of `label` if not provided.
   * Can be a static string or a function returning a string for dynamic ARIA labels.
   */
  ariaLabel?: string | (() => string);
  /**
   * If `true`, the route resolver will wait until the `label` signal has a value before `resolving`
   */
  awaitValue?: boolean;
};

import { until } from '@mmstack/primitives';
import { injectSnapshotPathResolver } from '../util';
import { Breadcrumb, createInternalBreadcrumb } from './breadcrumb';

/**
 * Creates and registers a breadcrumb for a specific route. Designed to be used
 * as an Angular Route `ResolveFn` in the route's `resolve` map.
 *
 * Accepts a static label, a static options object, or a factory returning
 * either — use a factory when you need `inject()` to read dynamic data.
 *
 * @param factoryOrValue One of: a literal label string (shorthand for
 *   `{ label: <string> }`), a static {@link CreateBreadcrumbOptions} object,
 *   or a factory `(route) => string | CreateBreadcrumbOptions` invoked inside an
 *   injection context (so it can use `inject()`) and receiving the route's
 *   `ActivatedRouteSnapshot` — params/data are idiomatically reachable:
 *   `createBreadcrumb((route) => 'Order ' + route.params['id'])`.
 * @returns An Angular `ResolveFn<void>` to wire into a route's `resolve` map.
 *   The resolver registers the breadcrumb as a side effect; the resolved value
 *   itself is unused.
 *
 * @see CreateBreadcrumbOptions
 *
 * @example
 * ```ts
 * export const appRoutes: Routes = [
 *   {
 *     path: 'home',
 *     component: HomeComponent,
 *     resolve: {
 *       // shorthand for { label: 'Home' }
 *       breadcrumb: createBreadcrumb('Home'),
 *     },
 *   },
 *   {
 *     path: 'users/:userId',
 *     component: UserProfileComponent,
 *     resolve: {
 *       breadcrumb: createBreadcrumb(() => {
 *         const userStore = inject(UserStore);
 *         return {
 *           label: () => userStore.user().name ?? 'Loading…',
 *         };
 *       }),
 *     },
 *   },
 * ];
 * ```
 */
export function createBreadcrumb(
  factoryOrValue:
    | ((route: ActivatedRouteSnapshot) => CreateBreadcrumbOptions | string)
    | string
    | CreateBreadcrumbOptions,
): ResolveFn<void> {
  const factory =
    typeof factoryOrValue === 'string'
      ? (): CreateBreadcrumbOptions => ({ label: factoryOrValue })
      : typeof factoryOrValue === 'function'
        ? (route: ActivatedRouteSnapshot): CreateBreadcrumbOptions => {
            const result = factoryOrValue(route);
            return typeof result === 'string' ? { label: result } : result;
          }
        : () => factoryOrValue;

  return async (route) => {
    const router = inject(Router);
    const store = inject(BreadcrumbStore);
    const resolver = injectSnapshotPathResolver();

    const fp = resolver(route);

    // path only — query params / fragment must NOT be baked into a breadcrumb link
    // (they'd be frozen at resolve time; the store overlays the live leaf link anyway)
    const tree = createUrlTreeFromSnapshot(route, []);

    const provided = factory(route);

    const link = computed(() => router.serializeUrl(tree));

    const { label, ariaLabel = label } = provided;

    const bc: Breadcrumb = {
      id: fp,
      ariaLabel:
        typeof ariaLabel === 'string'
          ? computed(() => ariaLabel)
          : computed(ariaLabel),
      label:
        typeof label === 'string' ? computed(() => label) : computed(label),
      link,
    };

    store.register(
      createInternalBreadcrumb(
        bc,
        computed(() => route.data?.['skipBreadcrumb'] !== true),
      ),
    );

    if (provided.awaitValue) await until(bc.label, (v) => !!v);

    return Promise.resolve();
  };
}
