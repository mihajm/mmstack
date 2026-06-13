import { computed, inject, Injectable, type Signal } from '@angular/core';
import { indexArray, mutable } from '@mmstack/primitives';
import { injectLeafRoutes, type ResolvedLeafRoute } from '../util/leaf.store';
import { createStagedApply } from '../util/staged-apply';
import {
  type Breadcrumb,
  createInternalBreadcrumb,
  getBreadcrumbInternals,
  type InternalBreadcrumb,
  isInternalBreadcrumb,
} from './breadcrumb';
import { injectBreadcrumbConfig } from './breadcrumb-config';

function uppercaseFirst(str: string): string {
  const lcs = str.toLowerCase();
  return lcs.charAt(0).toUpperCase() + lcs.slice(1);
}

function removeMatrixAndQueryParams(path: string): string {
  const [cleanPath] = path.split(';');
  return cleanPath.split('?')[0];
}

function parsePathSegment(pathSegment: string): string {
  return pathSegment
    .split('/')
    .flatMap((part) => part.split('.'))
    .flatMap((part) => part.split('-'))
    .map((part) => uppercaseFirst(removeMatrixAndQueryParams(part)))
    .join(' ');
}

function generateLabel(leaf: ResolvedLeafRoute): string {
  // read the RAW config title, not the resolved one — for routes using createTitle the
  // resolved title has already been run through the configured parser/prefix, which
  // would leak "App - Home" style strings into breadcrumbs
  const configTitle = leaf.route.routeConfig?.title;
  const title =
    (typeof configTitle === 'string' ? configTitle : undefined) ??
    leaf.route.data?.['title'];

  if (title && typeof title === 'string') return title;
  if (leaf.segment.path.includes(':')) return leaf.segment.resolved;

  return parsePathSegment(leaf.segment.path);
}

function autoGenerateBreadcrumb(
  id: string,
  leaf: Signal<ResolvedLeafRoute>,
  autoGenerateFn: Signal<(leaf: ResolvedLeafRoute) => string>,
): Breadcrumb {
  const label = computed(() => autoGenerateFn()(leaf()));

  return createInternalBreadcrumb(
    {
      id,
      label,
      ariaLabel: label,
      link: computed(() => leaf().link),
    },
    computed(
      () =>
        leaf().route.data?.['skipBreadcrumb'] !== true &&
        id !== '' &&
        id !== '/' &&
        leaf().segment.path !== '' &&
        leaf().segment.path !== '/' &&
        !leaf().segment.path.endsWith('/') &&
        !!label(),
    ),
    false,
  );
}

function injectGenerateLabelFn() {
  const { generation } = injectBreadcrumbConfig();

  if (typeof generation !== 'function') return computed(() => generateLabel);

  const provided = generation();
  return computed(() => provided);
}

function injectIsManual() {
  return injectBreadcrumbConfig().generation === 'manual';
}

function exposeActiveSignal(
  crumbSignal: Signal<Breadcrumb>,
  manual: boolean,
): Signal<Breadcrumb> & {
  active: Signal<boolean>;
} {
  const active = manual
    ? computed(() => {
        const crumb = crumbSignal();

        return (
          isInternalBreadcrumb(crumb) &&
          getBreadcrumbInternals(crumb).registered &&
          getBreadcrumbInternals(crumb).active()
        );
      })
    : computed(() => {
        const crumb = crumbSignal();
        if (!isInternalBreadcrumb(crumb)) return true;
        return getBreadcrumbInternals(crumb).active();
      });

  const sig = crumbSignal as Signal<Breadcrumb> & {
    active: Signal<boolean>;
  };

  sig.active = active;

  return sig;
}

@Injectable({
  providedIn: 'root',
})
export class BreadcrumbStore {
  private readonly map = mutable<Map<string, InternalBreadcrumb>>(new Map());
  private readonly isManual = injectIsManual();
  private readonly autoGenerateLabelFn = injectGenerateLabelFn();
  private readonly leafRoutes = injectLeafRoutes();

  private readonly all = indexArray(
    this.leafRoutes,
    (leaf) => {
      const stableId = computed(() => leaf().path);

      const cache: {
        id: string | null;
        auto: InternalBreadcrumb | null;
        found: InternalBreadcrumb | null;
        wrapped: InternalBreadcrumb | null;
      } = { id: null, auto: null, found: null, wrapped: null };

      return exposeActiveSignal(
        computed(() => {
          const id = stableId();

          if (cache.id !== id) {
            cache.id = id;
            cache.auto = null;
            cache.found = null;
            cache.wrapped = null;
          }

          const found = this.map().get(id);

          if (!found) {
            cache.found = null;
            cache.wrapped = null;
            return (cache.auto ??= autoGenerateBreadcrumb(
              id,
              leaf,
              this.autoGenerateLabelFn,
            ) as InternalBreadcrumb);
          }

          // ALL registered crumbs get the live leaf link
          if (cache.found !== found) {
            cache.found = found;
            cache.wrapped = {
              ...found,
              link: computed(() => leaf().link),
            };
          }

          return cache.wrapped as InternalBreadcrumb;
        }),
        this.isManual,
      );
    },
    {
      equal: (a, b) => a.link === b.link,
    },
  );

  private readonly crumbs = computed((): Signal<Breadcrumb>[] =>
    this.all().filter((c) => c.active()),
  );

  readonly unwrapped = computed(() => this.crumbs().map((c) => c()));

  // staged: a breadcrumb registered during a navigation must not appear (or replace an
  // existing label) until that navigation actually commits — see createStagedApply
  private readonly stagedApply = createStagedApply<InternalBreadcrumb>(
    (id, breadcrumb) => this.map.inline((m) => m.set(id, breadcrumb)),
  );

  register(breadcrumb: InternalBreadcrumb) {
    this.stagedApply(breadcrumb.id, breadcrumb);
  }
}

/**
 * Injects and provides access to a reactive list of breadcrumbs.
 *
 * The breadcrumbs are ordered and reflect the current active navigation path.
 * @see Breadcrumb
 * @returns `Signal<Breadcrumb[]>`
 *
 * @example
 * ```typescript
 * @Component({
 * selector: 'app-breadcrumbs',
 * template: `
 *  <nav aria-label="breadcrumb">
 *    <ol>
 *      @for (crumb of breadcrumbs(); track crumb.id) {
 *        <li>
 *          <a [routerLink]="crumb.link()" [attr.aria-label]="crumb.ariaLabel()">{{ crumb.label() }}</a>
 *        </li>
 *      }
 *    </ol>
 *  </nav>
 * `
 * })
 * export class MyBreadcrumbsComponent {
 *  breadcrumbs = injectBreadcrumbs();
 * }
 * ```
 */
export function injectBreadcrumbs() {
  const store = inject(BreadcrumbStore);
  return store.unwrapped;
}
