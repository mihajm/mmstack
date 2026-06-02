import { inject, Injectable } from '@angular/core';
import { type PreloadingStrategy, type Route, Router } from '@angular/router';
import { EMPTY, filter, finalize, type Observable, switchMap, take } from 'rxjs';
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

/**
 * Demand-driven preloading strategy for Angular's router. Unlike Angular's
 * built-in `PreloadAllModules`, this strategy preloads a lazy route only
 * when something explicitly requests it via {@link PreloadRequester} (e.g.
 * the `mmLink` directive on hover or visibility, or {@link injectTriggerPreload}
 * called imperatively).
 *
 * Skips preloading when:
 * - the route has `data.preload === false`
 * - the network is on `2g` or in `saveData` mode (cheap-data-mode users)
 * - a load for the same path is already in flight
 *
 * Wire this into `provideRouter` to enable the `mmLink` preload pipeline:
 *
 * @example
 * ```ts
 * import { PreloadStrategy } from '@mmstack/router-core';
 * import { provideRouter, withPreloading } from '@angular/router';
 *
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideRouter(routes, withPreloading(PreloadStrategy)),
 *   ],
 * });
 *
 * // Then in templates, `mmLink` (or `injectTriggerPreload`) requests
 * // preloads that this strategy executes:
 * // <a [mmLink]="'/users'">Users</a>
 * ```
 *
 * @example
 * ```ts
 * // Opt a route out of preloading:
 * export const routes: Routes = [
 *   { path: 'admin', loadChildren: () => import('./admin'), data: { preload: false } },
 * ];
 * ```
 */
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
