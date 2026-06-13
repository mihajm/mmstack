import { inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type PreloadingStrategy, type Route, Router } from '@angular/router';
import { EMPTY, type Observable, switchMap, timer } from 'rxjs';
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

function preloadDelay(route: Route): number {
  const delay = route.data?.['preloadDelay'];
  return typeof delay === 'number' && delay > 0 ? delay : 0;
}

type RegisteredLoader = {
  predicate: (path: string) => boolean;
  load: () => Observable<unknown>;
  delay: number;
};

/**
 * Demand-driven preloading strategy for Angular's router. Unlike Angular's
 * built-in `PreloadAllModules`, this strategy preloads a lazy route only
 * when something explicitly requests it via {@link PreloadRequester} (e.g.
 * the `mmLink` directive on hover or visibility, or {@link injectTriggerPreload}
 * called imperatively).
 *
 * `preload()` itself completes immediately — loaders are registered and
 * triggered on demand. This keeps `RouterPreloader`'s internal queue moving,
 * so lazy routes discovered by later navigations register correctly too.
 *
 * Skips preloading when:
 * - the route has `data.preload === false`
 * - the network is on `2g` or in `saveData` mode (cheap-data-mode users)
 * - a load for the same path is already in flight (or already loaded)
 *
 * Set `data.preloadDelay` (milliseconds) on a route to debounce hover-intent:
 * the load starts only after the delay elapses following the first request —
 * useful to avoid loading on accidental pointer flybys.
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
 * // Opt a route out of preloading / add hover-intent delay:
 * export const routes: Routes = [
 *   { path: 'admin', loadChildren: () => import('./admin'), data: { preload: false } },
 *   { path: 'reports', loadChildren: () => import('./reports'), data: { preloadDelay: 150 } },
 * ];
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class PreloadStrategy implements PreloadingStrategy {
  private readonly loaders = new Map<string, RegisteredLoader>();
  private readonly loading = new Set<string>();
  private readonly router = inject(Router);
  private readonly req = inject(PreloadRequester);

  constructor() {
    this.req.preloadRequested$
      .pipe(takeUntilDestroyed())
      .subscribe((path) => this.trigger(path));
  }

  preload(route: Route, load: () => Observable<any>): Observable<any> {
    if (!noPreload(route)) {
      const fp = findPath(this.router.config, route);
      // (re-)register the loader; actual loading happens on demand in trigger().
      // Returning EMPTY (completing immediately) is load-bearing: RouterPreloader
      // concatMaps these per navigation — a never-completing observable here would
      // stall registration of every lazy route discovered after this one.
      if (!this.loading.has(fp)) {
        this.loaders.set(fp, {
          predicate: createRoutePredicate(fp),
          load,
          delay: preloadDelay(route),
        });
      }
    }

    return EMPTY;
  }

  private trigger(path: string): void {
    if (this.loaders.size === 0 || hasSlowConnection()) return;

    for (const [fp, loader] of this.loaders) {
      if (this.loading.has(fp)) continue;
      if (path !== fp && !loader.predicate(path)) continue;

      this.loading.add(fp);

      const load$ =
        loader.delay > 0
          ? timer(loader.delay).pipe(switchMap(() => loader.load()))
          : loader.load();

      load$.subscribe({
        // loaded — drop the loader; `loading` keeps the path marked done so a
        // re-registration before Angular flags the route as loaded can't re-fire
        complete: () => this.loaders.delete(fp),
        // failed (e.g. chunk fetch error) — allow a retry on the next request
        error: () => this.loading.delete(fp),
      });
    }
  }
}
