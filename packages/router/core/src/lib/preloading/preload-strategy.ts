import { inject, Injectable } from '@angular/core';
import { PreloadingStrategy, type Route, Router } from '@angular/router';
import { EMPTY, filter, finalize, Observable, switchMap, take } from 'rxjs';
import { createRoutePredicate, findPath } from '../util';
import { PreloadRequester } from './preload-requester';

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

@Injectable({
  providedIn: 'root',
})
export class PreloadStrategy implements PreloadingStrategy {
  private readonly loading = new Set<string>();
  private readonly router = inject(Router);
  private readonly req = inject(PreloadRequester);

  preload(route: Route, load: () => Observable<any>): Observable<any> {
    if (noPreload(route) || hasSlowConnection()) return EMPTY;

    const fp = findPath(this.router.config, route);

    if (this.loading.has(fp)) return EMPTY;

    const predicate = createRoutePredicate(fp);
    return this.req.preloadRequested$.pipe(
      filter((path) => path === fp || predicate(path)),
      take(1),
      switchMap(() => load()),
      finalize(() => this.loading.delete(fp)),
    );
  }
}
