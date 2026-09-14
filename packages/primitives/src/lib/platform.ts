import { inject, type Injector, PLATFORM_ID } from '@angular/core';

function platformId(injector?: Injector): unknown {
  return injector
    ? injector.get(PLATFORM_ID, null, { optional: true })
    : inject(PLATFORM_ID, { optional: true });
}

/**
 * Whether the current platform is the server, read from `PLATFORM_ID`. Pass an `Injector` to
 * resolve outside an injection context. An unresolved platform id counts as not the server.
 *
 * Kept local so the library never imports `@angular/common`; it agrees with Angular's own
 * `isPlatformServer` for every platform id.
 */
export function isServer(injector?: Injector): boolean {
  return platformId(injector) === 'server';
}

/**
 * Whether the current platform is the browser, read from `PLATFORM_ID`. Pass an `Injector` to
 * resolve outside an injection context. An unresolved platform id counts as not the browser.
 *
 * Kept local so the library never imports `@angular/common`; it agrees with Angular's own
 * `isPlatformBrowser` for every platform id.
 */
export function isBrowser(injector?: Injector): boolean {
  return platformId(injector) === 'browser';
}
