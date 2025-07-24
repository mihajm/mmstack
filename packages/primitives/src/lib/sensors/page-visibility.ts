import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  Signal,
  signal,
} from '@angular/core';

/**
 * Creates a read-only signal that tracks the page's visibility state.
 *
 * It uses the browser's Page Visibility API to reactively report if the
 * current document is `'visible'`, `'hidden'`, or in another state.
 * The primitive is SSR-safe and automatically cleans up its event listeners
 * when the creating context is destroyed.
 *
 * @param debugName Optional debug name for the signal.
 * @returns A read-only `Signal<DocumentVisibilityState>`. On the server,
 * it returns a static signal with a value of `'visible'`.
 *
 * @example
 * ```ts
 * import { Component, effect } from '@angular/core';
 * import { pageVisibility } from '@mmstack/primitives';
 *
 * @Component({
 * selector: 'app-visibility-tracker',
 * template: `<p>Page is currently: {{ visibilityState() }}</p>`
 * })
 * export class VisibilityTrackerComponent {
 * readonly visibilityState = pageVisibility();
 *
 * constructor() {
 * effect(() => {
 * if (this.visibilityState() === 'hidden') {
 * console.log('Page is hidden, pausing expensive animations...');
 * } else {
 * console.log('Page is visible, resuming activity.');
 * }
 * });
 * }
 * }
 * ```
 */
export function pageVisibility(
  debugName = 'pageVisibility',
): Signal<DocumentVisibilityState> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return computed(() => 'visible', { debugName });
  }

  const visibility = signal(document.visibilityState, { debugName });

  const onVisibilityChange = () => visibility.set(document.visibilityState);

  document.addEventListener('visibilitychange', onVisibilityChange);

  inject(DestroyRef).onDestroy(() =>
    document.removeEventListener('visibilitychange', onVisibilityChange),
  );

  return visibility.asReadonly();
}
