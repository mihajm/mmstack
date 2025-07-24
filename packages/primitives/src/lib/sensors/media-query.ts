import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  Signal,
} from '@angular/core';

/**
 * Creates a read-only signal that reactively tracks whether a CSS media query
 * string currently matches.
 *
 * It uses `window.matchMedia` to evaluate the query and listen for changes.
 * The primitive is SSR-safe (defaults to `false` on the server) and automatically
 * cleans up its event listeners when the creating context is destroyed.
 *
 * @param query The CSS media query string to evaluate (e.g., `'(min-width: 768px)'`, `'(prefers-color-scheme: dark)'`).
 * @param debugName Optional debug name for the signal.
 * @returns A read-only `Signal<boolean>` which is `true` if the media query
 * currently matches, and `false` otherwise.
 *
 * @remarks
 * - On the server, this signal will always return `false` by default.
 * - It automatically updates if the match status of the media query changes in the browser.
 * - Event listeners are cleaned up automatically via `DestroyRef` if created in an injection context.
 *
 * @example
 * ```ts
 * import { Component, effect } from '@angular/core';
 * import { mediaQuery } from '@mmstack/primitives';
 *
 * @Component({
 * selector: 'app-responsive-layout',
 * template: `
 * @if (isDesktop()) {
 * <p>Showing desktop layout.</p>
 * } @else {
 * <p>Showing mobile layout.</p>
 * }
 * `
 * })
 * export class ResponsiveLayoutComponent {
 * readonly isDesktop = mediaQuery('(min-width: 1024px)');
 *
 * constructor() {
 * effect(() => {
 * console.log('Is desktop view:', this.isDesktop());
 * });
 * }
 * }
 * ```
 */
export function mediaQuery(
  query: string,
  debugName = 'mediaQuery',
): Signal<boolean> {
  if (isPlatformServer(inject(PLATFORM_ID)))
    return computed(() => false, { debugName });

  const mediaQueryList = window.matchMedia(query);

  const state = signal(mediaQueryList.matches, { debugName: debugName });

  const handleChange = (event: MediaQueryListEvent) => {
    state.set(event.matches);
  };

  mediaQueryList.addEventListener('change', handleChange);

  inject(DestroyRef).onDestroy(() => {
    mediaQueryList.removeEventListener('change', handleChange);
  });

  return state.asReadonly();
}

/**
 * Creates a read-only signal that tracks the user's OS/browser preference
 * for a dark color scheme using the `(prefers-color-scheme: dark)` media query.
 *
 * This is a convenience wrapper around the generic `mediaQuery` primitive.
 * It's SSR-safe (defaults to `false` on the server) and automatically
 * cleans up its event listeners.
 *
 * @param debugName Optional debug name for the signal.
 * @returns A read-only `Signal<boolean>` which is `true` if a dark theme
 * is preferred, and `false` otherwise.
 * @see {mediaQuery} for the underlying implementation.
 *
 * @example
 * ```ts
 * const isDarkMode = prefersDarkMode();
 * effect(() => {
 * document.body.classList.toggle('dark-theme', isDarkMode());
 * });
 * ```
 */
export function prefersDarkMode(debugName?: string): Signal<boolean> {
  return mediaQuery('(prefers-color-scheme: dark)', debugName);
}

/**
 * Creates a read-only signal that tracks the user's OS/browser preference
 * for reduced motion using the `(prefers-reduced-motion: reduce)` media query.
 *
 * This is a convenience wrapper around the generic `mediaQuery` primitive.
 * It's SSR-safe (defaults to `false` on the server) and automatically
 * cleans up its event listeners.
 *
 * @param debugName Optional debug name for the signal.
 * @returns A read-only `Signal<boolean>` which is `true` if reduced motion
 * is preferred, and `false` otherwise.
 * @see {mediaQuery} for the underlying implementation.
 *
 * @example
 * ```ts
 * const reduceMotion = prefersReducedMotion();
 * effect(() => {
 * if (reduceMotion()) {
 * // Apply simplified animations or disable them
 * } else {
 * // Apply full animations
 * }
 * });
 * ```
 */
export function prefersReducedMotion(debugName?: string): Signal<boolean> {
  return mediaQuery('(prefers-reduced-motion: reduce)', debugName);
}
