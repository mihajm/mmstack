import { inject } from '@angular/core';
import {
  Router,
  type CanMatchFn,
  type Route,
  type UrlSegment,
} from '@angular/router';
import {
  injectDefaultLocale,
  injectSupportedLocales,
} from './translation-store';

/**
 * Guard that validates the locale parameter against supported locales.
 * Redirects to default locale if the locale is invalid.
 *
 * @param prefixSegments Optional array of path segments preceding the locale segment.
 * if (you wanted to match /app/:locale/... you would pass ['app'] here) & the function would match the second parameter + redirect accordingly
 *
 * @example
 * ```typescript
 * {
 *   path: ':locale',
 *   canMatch: [canMatchLocale()],
 *   children: [...]
 * }
 * ```
 */
export function canMatchLocale(prefixSegments: string[] = []): CanMatchFn {
  return (_route: Route, segments: UrlSegment[]) => {
    const supportedLocales = injectSupportedLocales();

    const locale = segments.at(prefixSegments.length)?.path;

    if (!locale || !supportedLocales.includes(locale))
      return inject(Router).createUrlTree([
        ...prefixSegments,
        injectDefaultLocale(),
      ]);

    return true;
  };
}
