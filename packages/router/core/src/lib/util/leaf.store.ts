import { computed, inject, Injectable, type Signal } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  Router,
  type RouterStateSnapshot,
} from '@angular/router';
import { url } from '../url';

/**
 * A flattened view of one route in the active router chain, used by the
 * breadcrumb and title subsystems. Each `ResolvedLeafRoute` describes one
 * "step" in the chain from root to current leaf.
 *
 * Exposed publicly because custom breadcrumb generators (see
 * {@link BreadcrumbConfig}'s `generation` callback) receive instances of
 * this type and need to read its fields.
 *
 * - `route` — the underlying `ActivatedRouteSnapshot`.
 * - `segment.path` — the route config segment (e.g. `:userId`).
 * - `segment.resolved` — the resolved value of that segment (e.g. `'42'`).
 * - `path` — the full route-config path from root (with raw segments like `:userId`).
 * - `link` — the full resolved URL from root (with substituted values).
 */
export type ResolvedLeafRoute = {
  route: ActivatedRouteSnapshot;
  segment: {
    path: string;
    resolved: string;
  };
  path: string;
  link: string;
};

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

@Injectable({
  providedIn: 'root',
})
export class RouteLeafStore {
  readonly leaves = leafRoutes();
}

export function injectLeafRoutes() {
  const store = inject(RouteLeafStore);
  return store.leaves;
}
