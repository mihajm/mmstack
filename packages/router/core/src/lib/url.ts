import { inject, type Signal } from '@angular/core';
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
export function url(router?: Router): Signal<string> {
  if (!router) router = inject(Router);

  return toSignal(
    router.events.pipe(
      filter(isNavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    {
      initialValue: router.url,
    },
  );
}
