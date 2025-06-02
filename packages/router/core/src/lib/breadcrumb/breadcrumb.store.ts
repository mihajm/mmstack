import { computed, inject, Injectable, Signal, untracked } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { mapArray, mutable } from '@mmstack/primitives';
import { url } from '../url';
import { injectBreadcrumbConfig } from './breadcrumb.config';
import {
  Breadcrumb,
  createInternalBreadcrumb,
  getBreadcrumbInternals,
  InternalBreadcrumb,
  isInternalBreadcrumb,
  ResolvedLeafRoute,
} from './breadcrumb.type';

function leafRoutes(): Signal<ResolvedLeafRoute[]> {
  const router = inject(Router);

  const getLeafRoutes = (
    snapshot: RouterStateSnapshot,
  ): ResolvedLeafRoute[] => {
    const routes: ResolvedLeafRoute[] = [];
    let route: ActivatedRouteSnapshot | null = snapshot.root;
    const processed = new Set<string>();

    while (route) {
      const allSegments = route.pathFromRoot.flatMap(
        (snap) => snap.routeConfig?.path ?? [],
      );

      const segments = allSegments.filter(Boolean);

      const path = router.serializeUrl(router.parseUrl(segments.join('/')));

      if (processed.has(path)) {
        route = route.firstChild;
        continue;
      }
      processed.add(path);

      const parts = route.pathFromRoot
        .flatMap((snap) => snap.url ?? [])
        .map((u) => u.path)
        .filter(Boolean);

      const link = router.serializeUrl(router.parseUrl(parts.join('/')));

      routes.push({
        route,
        segment: {
          path: segments.at(-1) ?? '',
          resolved: parts.at(-1) ?? '',
        },
        path,
        link,
      });
      route = route.firstChild;
    }

    return routes;
  };

  const currentUrl = url();

  const leafRoutes = computed(() => {
    currentUrl();
    return getLeafRoutes(router.routerState.snapshot);
  });

  return leafRoutes;
}

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
  const title = leaf.route.title ?? leaf.route.data?.['title'];

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

  private readonly all = mapArray(
    leafRoutes(),
    (leaf) => {
      const stableId = computed(() => leaf().path);

      return exposeActiveSignal(
        computed(
          () => {
            const id = stableId();

            const found = this.map().get(id);

            if (!found)
              return autoGenerateBreadcrumb(id, leaf, this.autoGenerateLabelFn);

            if (!id.includes(':')) return found;

            return {
              ...found,
              link: computed(() => leaf().link),
            };
          },
          {
            equal: (a, b) => a.id === b.id,
          },
        ),
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

  register(breadcrumb: InternalBreadcrumb) {
    this.map.inline((m) => m.set(breadcrumb.id, breadcrumb));

    return () => {
      this.map.inline((m) => m.delete(breadcrumb.id));
    };
  }

  has(id: string): boolean {
    return untracked(this.map).has(id);
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
 *          <a [href]="crumb.link()" [attr.aria-label]="crumb.ariaLabel()">{{ crumb.label() }}</a>
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
