import {
  computed,
  InjectionToken,
  isSignal,
  type Provider,
  type Signal,
} from '@angular/core';
import { inject } from '@angular/core/primitives/di';
import { injectDynamicLocale } from '../translation-store';

function equalLocale(a: { locale: string }, b: { locale: string }): boolean {
  return a.locale === b.locale;
}

export function createFormatterProvider<T extends { locale: string }>(
  formatterName: string,
  libraryDefaults: Omit<T, 'locale'>,
  nonLocaleEqual: (a: Omit<T, 'locale'>, b: Omit<T, 'locale'>) => boolean,
) {
  const token = new InjectionToken(
    `@mmstack/translate:format-${formatterName}-config`,
    {
      factory: (): Signal<T> => {
        const loc = injectDynamicLocale();
        return computed(
          () =>
            ({
              ...libraryDefaults,
              locale: loc(),
            }) as T,
          { equal: equalLocale },
        );
      },
    },
  );

  const provider = (
    valueOrFn:
      | Omit<Partial<T>, 'locale'>
      | (() => Omit<Partial<T>, 'locale'> | Signal<Omit<Partial<T>, 'locale'>>),
  ): Provider => {
    const fnProvider =
      typeof valueOrFn === 'function'
        ? (valueOrFn as () =>
            | Omit<Partial<T>, 'locale'>
            | Signal<Omit<Partial<T>, 'locale'>>)
        : () => valueOrFn;

    return {
      provide: token,
      useFactory: () => {
        const loc = injectDynamicLocale();

        const providedDefaultsOrSignal = fnProvider();

        if (isSignal(providedDefaultsOrSignal))
          return computed(
            () =>
              ({
                ...libraryDefaults,
                ...providedDefaultsOrSignal(),
                locale: loc(),
              }) as T,
            {
              equal: (a, b) => equalLocale(a, b) && nonLocaleEqual(a, b),
            },
          );

        const defaults = {
          ...libraryDefaults,
          ...providedDefaultsOrSignal,
        };

        return computed(
          () =>
            ({
              ...defaults,
              locale: loc(),
            }) as T,
          {
            equal: equalLocale,
          },
        );
      },
    };
  };

  const injectFn = (): Signal<T> => inject(token as any);

  return [provider, injectFn] as const;
}

export type inferProvideParameter<
  T extends ReturnType<typeof createFormatterProvider>[0],
> = Parameters<T>[0];
