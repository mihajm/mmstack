import {
  createEnvironmentInjector,
  DestroyRef,
  effect,
  EnvironmentInjector,
  type EnvironmentProviders,
  inject,
  Injectable,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { type Route, Router } from '@angular/router';
import { provideTransitionScope } from '@mmstack/primitives';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { findPath } from '../util/find-path';
import { extractRouteParams } from '../util/extract-params';
import { PreloadRequester } from '../preloading/preload-requester';
import {
  type RouteDataContext,
  type RouteDataTag,
  readRouteDataTag,
} from './route-data';

/** Looks like a resource: has a `status()` signal we can watch to know when to tear down. */
type StatusBearing = { status: () => string };

function isStatusBearing(value: unknown): value is StatusBearing {
  return (
    !!value &&
    typeof (value as StatusBearing).status === 'function'
  );
}

/**
 * Warms route DATA on preload-intent (the same `mmLink` hover/visible signal that loads the
 * code chunk). For a hovered link it finds routes carrying a {@link createRouteData} tag,
 * extracts params from the URL, and runs the factory in a throwaway injector parented at
 * root — so the resource fetches into the shared resource cache. The later navigation reads
 * the warm cache (deduped). Opt-in via {@link withRouteData}.
 *
 * Two-phase for lazily code-split routes: the first hover loads the chunk (the route's tag
 * isn't visible until then); a subsequent hover warms the data. Eager routes warm on the
 * first hover.
 */
@Injectable({ providedIn: 'root' })
export class RouteDataPrefetcher {
  private readonly router = inject(Router);
  private readonly req = inject(PreloadRequester);
  private readonly rootInjector = inject(EnvironmentInjector);
  private readonly destroyRef = inject(DestroyRef);
  private connected = false;
  /** linkPath::description already warmed — don't refetch on repeated hovers. */
  private readonly warmed = new Set<string>();

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.req.preloadRequested$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((linkPath) => this.warm(linkPath));
  }

  private warm(linkPath: string): void {
    for (const { configPath, tag } of this.collectTagged()) {
      const extracted = extractRouteParams(configPath, linkPath);
      if (!extracted) continue;

      const dedupeKey = `${linkPath}::${tag.description}`;
      if (this.warmed.has(dedupeKey)) continue;
      this.warmed.add(dedupeKey);

      this.run(tag, extracted);
    }
  }

  private run(
    tag: RouteDataTag,
    extracted: { params: Record<string, string>; query: Record<string, string> },
  ): void {
    // throwaway scope so registration is harmless; parented at root so the resource resolves
    // the shared (root) cache and writes the warm entry there.
    const ephemeral = createEnvironmentInjector(
      [provideTransitionScope()],
      this.rootInjector,
    );

    runInInjectionContext(ephemeral, () => {
      const ctx: RouteDataContext = {
        params: signal(extracted.params),
        queryParams: signal(extracted.query),
        isPrefetch: true,
        injector: ephemeral,
      };
      const value = tag.factory(ctx);

      if (isStatusBearing(value)) {
        let settled = false;
        const ref = effect(() => {
          const s = value.status();
          if (s === 'resolved' || s === 'error' || s === 'local') {
            settled = true;
            ref.destroy();
            queueMicrotask(() => ephemeral.destroy());
          }
        });
        // safety net: never leak the injector if the request never settles
        setTimeout(() => {
          if (!settled) ephemeral.destroy();
        }, 30_000);
      } else {
        queueMicrotask(() => ephemeral.destroy());
      }
    });
  }

  private collectTagged(): { configPath: string; tag: RouteDataTag }[] {
    const out: { configPath: string; tag: RouteDataTag }[] = [];
    const visit = (routes: Route[]): void => {
      for (const route of routes) {
        if (route.resolve) {
          for (const slot of Object.values(route.resolve)) {
            const tag = readRouteDataTag(slot);
            if (tag) out.push({ configPath: findPath(this.router.config, route), tag });
          }
        }
        if (route.children) visit(route.children);
        const loaded = (route as Route & { _loadedRoutes?: Route[] })._loadedRoutes;
        if (Array.isArray(loaded)) visit(loaded);
      }
    };
    visit(this.router.config);
    return out;
  }
}

/**
 * Router feature: wire route-data prefetch into the `mmLink` preload pipeline so hovering a
 * link warms its route's data (not just the lazy code chunk). Add alongside `provideRouter`.
 *
 * @example
 * ```ts
 * provideRouter(routes, withPreloading(PreloadStrategy)),
 * withRouteData(),
 * ```
 */
export function withRouteData(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => inject(RouteDataPrefetcher).connect()),
  ]);
}
