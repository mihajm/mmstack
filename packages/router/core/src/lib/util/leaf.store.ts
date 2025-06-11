import { computed, inject, Injectable, Signal } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { url } from '../url';

/**
 * @internal
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
