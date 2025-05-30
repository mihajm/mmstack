// The following functions are adapted from ngx-quicklink,
// (https://github.com/mgechev/ngx-quicklink)
// Copyright (c) Minko Gechev and contributors, licensed under the MIT License.

import { PRIMARY_OUTLET, Route } from '@angular/router';

function isPrimaryRoute(route: Route): boolean {
  return route.outlet === PRIMARY_OUTLET || !route.outlet;
}

export const findPath = (config: Route[], route: Route): string => {
  const configQueue = config.slice();
  const parent = new Map<Route, Route>();
  const visited = new Set<Route>();

  while (configQueue.length) {
    const el = configQueue.shift();
    if (!el) {
      continue;
    }

    visited.add(el);

    if (el === route) {
      break;
    }

    (el.children || []).forEach((childRoute: Route) => {
      if (!visited.has(childRoute)) {
        parent.set(childRoute, el);
        configQueue.push(childRoute);
      }
    });

    const lazyRoutes = (el as any)._loadedRoutes || [];
    if (Array.isArray(lazyRoutes)) {
      lazyRoutes.forEach((lazyRoute: Route) => {
        if (lazyRoute && !visited.has(lazyRoute)) {
          parent.set(lazyRoute, el);
          configQueue.push(lazyRoute);
        }
      });
    }
  }

  let path = '';
  let currentRoute: Route | undefined = route;

  while (currentRoute) {
    const currentPath = currentRoute.path || '';
    if (isPrimaryRoute(currentRoute)) {
      path = `/${currentPath}${path}`;
    } else {
      path = `/(${currentRoute.outlet}:${currentPath})${path}`;
    }
    currentRoute = parent.get(currentRoute);
  }

  let normalizedPath = path.replaceAll(/\/+/g, '/');

  if (normalizedPath !== '/' && normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  return normalizedPath;
};
