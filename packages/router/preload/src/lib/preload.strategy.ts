import { inject, Injectable } from '@angular/core';
import { PreloadingStrategy, Route, Router } from '@angular/router';
import { EMPTY, filter, finalize, Observable, switchMap, take } from 'rxjs';
import { findPath } from './find-path';
import { PreloadService } from './preload.service';

function hasSlowConnection() {
  if (
    globalThis.window &&
    'navigator' in globalThis.window &&
    'connection' in globalThis.window.navigator &&
    typeof globalThis.window.navigator.connection === 'object' &&
    !!globalThis.window.navigator.connection
  ) {
    const is2g =
      'effectiveType' in globalThis.window.navigator.connection &&
      typeof globalThis.window.navigator.connection.effectiveType ===
        'string' &&
      globalThis.window.navigator.connection.effectiveType.endsWith('2g');
    if (is2g) return true;
    if (
      'saveData' in globalThis.window.navigator.connection &&
      typeof globalThis.window.navigator.connection.saveData === 'boolean' &&
      globalThis.window.navigator.connection.saveData
    )
      return true;
  }

  return false;
}

function noPreload(route: Route) {
  return route.data && route.data['preload'] === false;
}

function parsePathSegment(segmentString: string): {
  pathPart: string;
  matrixParams: Record<string, string>;
} {
  const parts = segmentString.split(';');
  const pathPart = parts[0];
  const matrixParams: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const [key, value = 'true'] = parts[i].split('=');
    if (key) {
      matrixParams[key] = value;
    }
  }
  return { pathPart, matrixParams };
}

function createRoutePredicate(path: string): (path: string) => boolean {
  const partPredicates = path
    .split('/')
    .filter((part) => !!part.trim())
    .map((configSegmentString) => {
      const { pathPart: configPathPart, matrixParams: configMatrixParams } =
        parsePathSegment(configSegmentString);

      let singlePathPartPredicate: (linkSegmentPathPart: string) => boolean;
      if (configPathPart.startsWith(':')) {
        singlePathPartPredicate = () => true;
      } else {
        singlePathPartPredicate = (linkSegmentPathPart: string) =>
          linkSegmentPathPart === configPathPart;
      }

      const configSegmentHasMatrixParams =
        Object.keys(configMatrixParams).length > 0;

      return (linkSegmentString: string) => {
        const { pathPart: linkPathPart, matrixParams: linkMatrixParams } =
          parsePathSegment(linkSegmentString);

        if (!singlePathPartPredicate(linkPathPart)) {
          return false;
        }

        if (!configSegmentHasMatrixParams) {
          return true;
        }

        return Object.entries(configMatrixParams).every(
          ([key, value]) =>
            linkMatrixParams.hasOwnProperty(key) &&
            linkMatrixParams[key] === value,
        );
      };
    });

  return (path: string) => {
    const linkPathOnly = path.split(/[?#]/).at(0) ?? '';
    if (!linkPathOnly && partPredicates.length > 0) return false;
    if (!linkPathOnly && partPredicates.length === 0) return true;

    const parts = linkPathOnly.split('/').filter((part) => !!part.trim());
    if (parts.length < partPredicates.length) return false;

    return parts.every((seg, idx) => {
      const pred = partPredicates.at(idx);
      if (!pred) return true;
      return pred(seg);
    });
  };
}

@Injectable({
  providedIn: 'root',
})
export class MMPreloadStrategy implements PreloadingStrategy {
  private readonly loading = new Set<string>();
  private readonly router = inject(Router);
  private readonly svc = inject(PreloadService);

  preload(route: Route, load: () => Observable<any>): Observable<any> {
    if (noPreload(route) || hasSlowConnection()) return EMPTY;

    const fp = findPath(this.router.config, route);

    if (this.loading.has(fp)) return EMPTY;

    const predicate = createRoutePredicate(fp);

    return this.svc.preloadRequested$.pipe(
      filter((path) => path === fp || predicate(path)),
      take(1),
      switchMap(() => load()),
      finalize(() => this.loading.delete(fp)),
    );
  }
}
