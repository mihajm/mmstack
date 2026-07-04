import { computed, inject, Injectable, Signal } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { navigationEndTick } from '../url';

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

// Only the primary outlet chain is walked; aux-outlet routes stay inert.
function leafRoutes(): Signal<ResolvedLeafRoute[]> {
  const router = inject(Router);

  const getLeafRoutes = (
    snapshot: RouterStateSnapshot,
  ): ResolvedLeafRoute[] => {
    const routes: ResolvedLeafRoute[] = [];
    let route: ActivatedRouteSnapshot | null = snapshot.root;

    while (route) {
      const allSegments = route.pathFromRoot.flatMap(
        (snap) => snap.routeConfig?.path ?? [],
      );

      const segments = allSegments.filter(Boolean);

      const path = router.serializeUrl(router.parseUrl(segments.join('/')));

      const parts = route.pathFromRoot
        .flatMap((snap) => snap.url ?? [])
        .map((u) => u.path)
        .filter(Boolean);

      const link = router.serializeUrl(router.parseUrl(parts.join('/')));

      const entry: ResolvedLeafRoute = {
        route,
        segment: {
          path: segments.at(-1) ?? '',
          resolved: parts.at(-1) ?? '',
        },
        path,
        link,
      };

      // empty-path children share their parent's path; keep the deepest snapshot
      const existingIdx = routes.findIndex((r) => r.path === path);
      if (existingIdx >= 0) routes[existingIdx] = entry;
      else routes.push(entry);

      route =
        route.children?.find((c) => c.outlet === 'primary') ??
        route.firstChild;
    }

    return routes;
  };

  const tick = navigationEndTick(router);

  const leafRoutes = computed(() => {
    tick();
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
