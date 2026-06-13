import { computed, inject, Injectable, type Signal } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  Router,
  type RouterStateSnapshot,
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

/**
 * Known limitations (by design, documented rather than handled):
 * - Only the PRIMARY outlet chain is walked. Routes rendered in named (auxiliary)
 *   outlets don't contribute leaves — their titles/breadcrumbs/nav registrations
 *   are keyed by paths that never appear in this chain, so they simply stay inert.
 * - Registrations in the title/breadcrumb/nav stores are keyed by route-config
 *   paths and are NOT evicted when the config changes via `Router.resetConfig`.
 *   Stale entries are only reachable if the new config reuses the same path —
 *   in which case re-resolving overwrites them. Apps that hot-swap configs with
 *   overlapping paths but different meaning should re-register via resolvers.
 */
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

      // empty-path children serialize to the same path as their parent — keep the
      // DEEPEST snapshot so the component-bearing child's `title`/`data` win over
      // the shell parent's
      const existingIdx = routes.findIndex((r) => r.path === path);
      if (existingIdx >= 0) routes[existingIdx] = entry;
      else routes.push(entry);

      // walk the PRIMARY outlet — an aux outlet's child can sort first in `children`
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
