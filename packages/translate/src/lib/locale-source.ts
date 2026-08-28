import { InjectionToken, type Provider, type Signal } from '@angular/core';

export const LOCALE_SOURCE = new InjectionToken<Signal<string | null>>(
  'mmstack-locale-source',
);

/**
 * Couples the store's active locale to an external reactive source.
 */
export function provideLocaleSource(source: Signal<string | null>): Provider {
  return { provide: LOCALE_SOURCE, useValue: source };
}
