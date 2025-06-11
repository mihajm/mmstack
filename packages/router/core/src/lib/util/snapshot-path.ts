import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';

export function injectSnapshotPathResolver() {
  const router = inject(Router);

  return (route: ActivatedRouteSnapshot) => {
    const segments = route.pathFromRoot.flatMap(
      (snap) => snap.routeConfig?.path ?? [],
    );

    const joinedSegments = segments.filter(Boolean).join('/');

    return router.serializeUrl(router.parseUrl(joinedSegments));
  };
}
