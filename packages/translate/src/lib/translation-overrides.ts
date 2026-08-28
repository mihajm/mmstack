import { InjectionToken, type Provider, type Signal } from '@angular/core';
import { type UnknownStringKeyObject } from './string-key-object.type';

/**
 * Reactive translation data overlaid on top of whatever the store has
 * registered: locale → namespace → nested translation object (the same shape
 * `createNamespace` takes). Keys present here win over registered keys;
 * everything else falls through to the registered translations.
 */
export type TranslationOverrides = Partial<
  Record<string, Record<string, UnknownStringKeyObject>>
>;

export const TRANSLATION_OVERRIDES = new InjectionToken<
  Signal<TranslationOverrides | null>
>('mmstack-translation-overrides');

/**
 * Couples the `TranslationStore` directly to an external reactive source —
 * the store's read surface becomes a pure derivation over
 * `overrides() + registered translations`, with zero effects and zero
 * loading. While the signal emits `null` the store behaves exactly as
 * without the provider.
 */
export function provideTranslationOverrides(
  overrides: Signal<TranslationOverrides | null>,
): Provider {
  return { provide: TRANSLATION_OVERRIDES, useValue: overrides };
}
