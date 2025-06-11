import {
  computed,
  effect,
  inject,
  Injectable,
  Signal,
  untracked,
} from '@angular/core';
import { mapArray, mutable } from '@mmstack/primitives';
import { injectLeafRoutes, ResolvedLeafRoute } from '../util/leaf.store';
import { injectBreadcrumbConfig } from './breadcrumb.config';
import {
  Breadcrumb,
  createInternalBreadcrumb,
  getBreadcrumbInternals,
  InternalBreadcrumb,
  isInternalBreadcrumb,
} from './breadcrumb.type';

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
  private readonly leafRoutes = injectLeafRoutes();

  private readonly all = mapArray(
    this.leafRoutes,
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

  constructor() {
    const activePaths = computed(() => this.leafRoutes().map((l) => l.path));

    let firstNav = true;

    effect(() => {
      const paths = activePaths();

      if (firstNav) {
        firstNav = false;
        return;
      }

      if (!paths.length) return this.map.inline((m) => m.clear());
      this.map.inline((m) => {
        for (const key of m.keys()) {
          if (paths.includes(key)) continue;
          m.delete(key);
        }
      });
    });
  }

  register(breadcrumb: InternalBreadcrumb) {
    this.map.inline((m) => m.set(breadcrumb.id, breadcrumb));
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
