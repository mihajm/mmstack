import { inject, type Injector, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type Event,
  EventType,
  type NavigationEnd,
  Router,
} from '@angular/router';
import { filter, map } from 'rxjs/operators';

/**
 * Type guard to check if a Router Event is a NavigationEnd event.
 * @internal
 */
function isNavigationEnd(e: Event): e is NavigationEnd {
  return 'type' in e && e.type === EventType.NavigationEnd;
}

/**
 * A signal that increments on every successful navigation — INCLUDING navigations whose
 * resulting URL string equals the previous one (initial landing on `/`, `onSameUrlNavigation:
 * 'reload'`, redirect-back-to-same-URL). Use this, not the URL string, to key recomputation
 * of anything derived from router state snapshots.
 *
 * @param router The `Router` instance to observe.
 * @param injector Required when calling outside an injection context — the underlying
 *   subscription's lifetime needs a `DestroyRef`.
 *
 * @example
 * ```ts
 * const tick = navigationEndTick(inject(Router));
 * const leafSnapshot = computed(() => {
 *   tick(); // recompute per navigation, even same-URL reloads
 *   let leaf = router.routerState.snapshot.root;
 *   while (leaf.firstChild) leaf = leaf.firstChild;
 *   return leaf;
 * });
 * ```
 */
export function navigationEndTick(
  router: Router,
  injector?: Injector,
): Signal<number> {
  let tick = 0;
  return toSignal(
    router.events.pipe(
      filter(isNavigationEnd),
      map(() => ++tick),
    ),
    { initialValue: 0, ...(injector ? { injector } : {}) },
  );
}

/**
 * Creates a Signal that tracks the current router URL.
 *
 * The signal emits the URL string reflecting the router state *after* redirects
 * have completed for each successful navigation. It initializes with the router's
 * current URL state.
 *
 * @returns {Signal<string>} A Signal emitting the `urlAfterRedirects` upon successful navigation.
 *
 * @example
 * ```ts
 * import { Component, effect } from '@angular/core';
 * import { url } from '@mmstack/router-core'; // Adjust import path
 *
 * @Component({
 * selector: 'app-root',
 * template: `Current URL: {{ currentUrl() }}`
 * })
 * export class AppComponent {
 * currentUrl = url();
 *
 * constructor() {
 * effect(() => {
 * console.log('Navigation ended. New URL:', this.currentUrl());
 * // e.g., track page view with analytics
 * });
 * }
 * }
 * ```
 */
export function url(
  router?: Router,
  opt?: {
    /**
     * Injector for the underlying subscription. Required when calling outside an
     * injection context (passing `router` alone is not enough — the subscription
     * lifetime still needs a `DestroyRef`).
     */
    injector?: Injector;
  },
): Signal<string> {
  if (!router) router = inject(Router);

  return toSignal(
    router.events.pipe(
      filter(isNavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    {
      initialValue: router.url,
      ...(opt?.injector ? { injector: opt.injector } : {}),
    },
  );
}
