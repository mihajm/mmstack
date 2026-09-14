import { inject, PLATFORM_ID } from '@angular/core';

/**
 * Whether the current platform is the browser, read from `PLATFORM_ID` in the current injection
 * context. Kept local so the library never imports `@angular/common`; it agrees with Angular's own
 * `isPlatformBrowser` for every platform id.
 */
export function isBrowser(): boolean {
  return inject(PLATFORM_ID, { optional: true }) === 'browser';
}
