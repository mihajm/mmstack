import { computed, inject } from '@angular/core';
import {
  createUrlTreeFromSnapshot,
  Router,
  type ResolveFn,
} from '@angular/router';
import { BreadcrumbStore } from './breadcrumb.store';

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
import { Breadcrumb, createInternalBreadcrumb } from './breadcrumb.type';

/**
 * Creates and registers a breadcrumb for a specific route.
 * This function is designed to be used as an Angular Route `ResolveFn`.
 * It handles the registration of the breadcrumb with the `BreadcrumbStore`
 * and ensures automatic deregistration when the route is destroyed.
 *
 * @param factory A function that returns a `CreateBreadcrumbOptions` object.
 * @see CreateBreadcrumbOptions
 *
 * @example
 * ```typescript
 * export const appRoutes: Routes = [
 *   {
 *     path: 'home',
 *     component: HomeComponent,
 *     resolve: {
 *       breadcrumb: createBreadcrumb(() => ({
 *         label: 'Home',
 *       });
 *     },
 *     path: 'users/:userId',
 *     component: UserProfileComponent,
 *     resolve: {
 *       breadcrumb: createBreadcrumb(() => {
 *         const userStore = inject(UserStore);
 *         return {
 *            label: () => userStore.user().name ?? 'Loading...
 *        };
 *      })
 *     },
 *   }
 * ];
 * ```
 */
export function createBreadcrumb(
  factory: () => CreateBreadcrumbOptions,
): ResolveFn<void> {
  return async (route) => {
    const router = inject(Router);
    const store = inject(BreadcrumbStore);
    const resolver = injectSnapshotPathResolver();

    const fp = resolver(route);
    if (store.has(fp)) return Promise.resolve();

    const tree = createUrlTreeFromSnapshot(
      route,
      [],
      route.queryParams,
      route.fragment,
    );

    const provided = factory();

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
