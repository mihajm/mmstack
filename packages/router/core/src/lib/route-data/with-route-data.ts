import { isPlatformServer } from '@angular/common';
import {
  createEnvironmentInjector,
  DestroyRef,
  effect,
  EnvironmentInjector,
  type EnvironmentProviders,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Route, Router } from '@angular/router';
import { provideTransitionScope } from '@mmstack/primitives';
import { PreloadRequester } from '../preloading/preload-requester';
import { extractRouteParams } from '../util/extract-params';
import { findPath } from '../util/find-path';
import {
  paramAccessor,
  readRouteDataTag,
  statusBearers,
  type RouteDataContext,
  type RouteDataTag,
} from './route-data';

const DEFAULT_PREFETCH_TIMEOUT = 30_000;

const PREFETCH_TIMEOUT = new InjectionToken<number>(
  '@mmstack/router-core:route-data-prefetch-timeout',
);

function isSettled(status: string): boolean {
  return status === 'resolved' || status === 'error' || status === 'local';
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
  private readonly onServer = isPlatformServer(inject(PLATFORM_ID));
  private readonly prefetchTimeout =
    inject(PREFETCH_TIMEOUT, { optional: true }) ?? DEFAULT_PREFETCH_TIMEOUT;
  private connected = false;
  /** linkPath::description already warmed — don't refetch on repeated hovers. */
  private readonly warmed = new Set<string>();

  connect(): void {
    if (this.connected || this.onServer) return;
    this.connected = true;
    this.req.preloadRequested$
      .pipe(takeUntilDestroyed(this.destroyRef))
      // scope 'code' = warm the chunk only — the link opted its DATA out (mmLink `preload`)
      .subscribe(({ path, scope }) => {
        if (scope === 'all') this.warm(path);
      });
  }

  private warm(linkPath: string): void {
    for (const { configPath, tag } of this.collectTagged()) {
      const extracted = extractRouteParams(configPath, linkPath);
      if (!extracted) continue;

      const dedupeKey = `${linkPath}::${tag.description}`;
      if (this.warmed.has(dedupeKey)) continue;
      this.warmed.add(dedupeKey);

      this.run(tag, extracted, dedupeKey);
    }
  }

  private run(
    tag: RouteDataTag,
    extracted: {
      params: Record<string, string>;
      query: Record<string, string>;
    },
    dedupeKey: string,
  ): void {
    // throwaway scope so registration is harmless; parented at root so the resource resolves
    // the shared (root) cache and writes the warm entry there.
    const ephemeral = createEnvironmentInjector(
      [provideTransitionScope()],
      this.rootInjector,
    );

    try {
      runInInjectionContext(ephemeral, () => {
        const params = signal(extracted.params);
        const ctx: RouteDataContext = {
          params,
          param: paramAccessor(params),
          queryParams: signal(extracted.query),
          isPrefetch: true,
          injector: ephemeral,
        };
        // the value itself, or each first-level member of a composite return
        const watched = statusBearers(tag.factory(ctx));

        if (!watched.length) {
          queueMicrotask(() => ephemeral.destroy());
          return;
        }

        let settled = false;
        // a failed warm should retry on the next hover: forget the dedupe entry
        const finish = (failed: boolean) => {
          settled = true;
          clearTimeout(timer);
          if (failed) this.warmed.delete(dedupeKey);
          queueMicrotask(() => ephemeral.destroy());
        };
        // safety net: never leak the injector if a request never settles
        const timer = setTimeout(() => {
          if (settled) return;
          this.warmed.delete(dedupeKey);
          ephemeral.destroy();
        }, this.prefetchTimeout);
        const ref = effect(() => {
          const statuses = watched.map((w) => w.status());
          if (!statuses.every(isSettled)) return;
          finish(statuses.includes('error'));
          ref.destroy();
        });
      });
    } catch (e) {
      // user code — a throwing factory must not kill the preload subscription or block retries
      this.warmed.delete(dedupeKey);
      ephemeral.destroy();
      if (isDevMode())
        console.warn(
          `[mmstack/router-core] route-data prefetch factory for "${tag.description}" threw:`,
          e,
        );
    }
  }

  private collectTagged(): { configPath: string; tag: RouteDataTag }[] {
    const out: { configPath: string; tag: RouteDataTag }[] = [];
    const visit = (routes: Route[]): void => {
      for (const route of routes) {
        if (route.resolve) {
          for (const slot of Object.values(route.resolve)) {
            const tag = readRouteDataTag(slot);
            if (tag)
              out.push({
                configPath: findPath(this.router.config, route),
                tag,
              });
          }
        }
        if (route.children) visit(route.children);
        const loaded = (route as Route & { _loadedRoutes?: Route[] })
          ._loadedRoutes;
        if (Array.isArray(loaded)) visit(loaded);
      }
    };
    visit(this.router.config);
    return out;
  }
}

/** Options for {@link withRouteData}. */
export type RouteDataOptions = {
  /**
   * How long (ms) a warmed prefetch may stay in flight before its throwaway injector is torn
   * down as a leak guard. Raise it for routes whose data legitimately takes a long time to
   * load. Defaults to 30000.
   */
  timeout?: number;
};

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
export function withRouteData(
  options?: RouteDataOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => inject(RouteDataPrefetcher).connect()),
    ...(options?.timeout != null
      ? [{ provide: PREFETCH_TIMEOUT, useValue: options.timeout }]
      : []),
  ]);
}
