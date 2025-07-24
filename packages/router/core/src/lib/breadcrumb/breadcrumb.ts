import { type Signal } from '@angular/core';

/**
 * Represents a single breadcrumb item within the navigation path.
 * All dynamic properties are represented as Angular Signals to enable reactivity.
 */
export type Breadcrumb = {
  /**
   * A unique identifier for the breadcrumb item. Generally the unresolved path for example `/posts/:id`.
   * Useful for `@for` tracking in templates.
   */
  id: string;
  /**
   * The visible text for the breadcrumb item.
   * Updated reactively as the url/link based on
   * either a provided definition, or the current route.
   */
  label: Signal<string>;
  /**
   * An accessible label for the breadcrumb item.
   * Defaults to the same value as `label` if not provided.
   */
  ariaLabel: Signal<string>;
  /**
   * The URL link for the breadcrumb item.
   * Updates as the route changes.
   */
  link: Signal<string>;
};

/**
 * @internal
 */
const INTERNAL_BREADCRUMB_SYMBOL = Symbol.for('MMSTACK_INTERNAL_BREADCRUMB');

/**
 * @internal
 */
export type InternalBreadcrumb = Breadcrumb & {
  [INTERNAL_BREADCRUMB_SYMBOL]: {
    active: Signal<boolean>;
    registered: boolean;
  };
};

/**
 * @internal
 */
export function getBreadcrumbInternals(breadcrumb: InternalBreadcrumb) {
  return (breadcrumb as InternalBreadcrumb)[INTERNAL_BREADCRUMB_SYMBOL];
}

/**
 * @internal
 */
export function createInternalBreadcrumb(
  bc: Breadcrumb,
  active: Signal<boolean>,
  registered = true,
): InternalBreadcrumb {
  return {
    ...bc,
    [INTERNAL_BREADCRUMB_SYMBOL]: {
      active,
      registered,
    },
  };
}

/**
 * @internal
 */
export function isInternalBreadcrumb(
  breadcrumb: Breadcrumb | InternalBreadcrumb,
): breadcrumb is InternalBreadcrumb {
  return !!(breadcrumb as InternalBreadcrumb)[INTERNAL_BREADCRUMB_SYMBOL];
}
