import { type Provider, signal } from '@angular/core';
import { createIntl, createIntlCache, type IntlShape } from '@formatjs/intl';
import { compileTranslation } from '../compile';
import { type UnknownStringKeyObject } from '../string-key-object.type';
import { TranslationStore } from '../translation-store';

/**
 * Options designed to feed into the mock translations function.
 */
export interface MockTranslationOptions {
  /**
   * If provided, allows overriding the default behavior of simply echoing translation keys back.
   * Format: Record of namespace -> (Translation shape similar to what you pass to `createNamespace`)
   *
   * Example:
   * ```ts
   * {
   *   home: { title: 'Mocked Title' },
   *   auth: { error: 'Mocked Error' }
   * }
   * ```
   */
  translations?: Record<string, UnknownStringKeyObject>;

  /**
   * When true, uses `@formatjs/intl` to process ICU message syntax (e.g. `{name}`, plurals, selects).
   * This gives you real variable interpolation in your test assertions.
   *
   * @default false — values are ignored and the raw message string is returned.
   *
   * @example
   * ```ts
   * provideMockTranslations({
   *   translations: { home: { greet: 'Hello {name}' } },
   *   formatValues: true,
   * })
   * // t('home.greet', { name: 'Alice' }) → 'Hello Alice'
   * ```
   */
  formatValues?: boolean;

  /**
   * The locale to use when `formatValues` is true.
   * @default 'en-US'
   */
  locale?: string;
}

/**
 * Provides an isolated mock `TranslationStore` usable across testing modules that use components
 * depending on `@mmstack/translate` APIs (like `Translate` directive, `Translator` pipe, or `injectNamespaceT`).
 *
 * This provider intercepts all translation logic, bypassing chunk loaders and Intl.
 * When a custom configuration isn't provided, formatMessage simply echoes the translation key, using dots `.`.
 *
 * ### Usage
 * ```typescript
 * TestBed.configureTestingModule({
 *   providers: [provideMockTranslations()]
 * });
 * ```
 */
export function provideMockTranslations(
  options?: MockTranslationOptions,
): Provider[] {
  // We compile the mock strings to flat delimiters just like the internal compile module.
  const mappedMocks: Record<string, string> = {};

  if (options?.translations) {
    for (const [namespace, translationObj] of Object.entries(
      options.translations,
    )) {
      const compiled = compileTranslation(translationObj, namespace);

      for (const [key, val] of Object.entries(compiled.flat)) {
        // e.g. from 'home::MMT_DELIM::title'
        const fullKey = `${namespace}::MMT_DELIM::${key}`;
        mappedMocks[fullKey] = val;
      }
    }
  }

  const locale = options?.locale ?? 'en-US';

  let intl: IntlShape | undefined;

  if (options?.formatValues) {
    intl = createIntl({ locale, messages: mappedMocks }, createIntlCache());
  }

  return [
    {
      provide: TranslationStore,
      useValue: {
        locale: signal(locale),
        formatMessage: (
          key: string,
          values?: Record<string, string | number>,
        ) => {
          const message = mappedMocks[key];

          if (!message) {
            // Fallback to echoing the key back in dot notation (more readable for unit assertions).
            return key.replaceAll('::MMT_DELIM::', '.');
          }

          if (intl) {
            return intl.formatMessage(
              { id: key, defaultMessage: message },
              values,
            );
          }

          return message;
        },
        hasLocaleLoaders: () => false,
        register: () => {
          // noop
        },
        registerOnDemandLoaders: () => {
          // noop
        },
        dynamicLocaleLoader: {
          isLoading: signal(false),
          value: signal(null),
          error: signal(null),
        },
        loadQueue: signal([]),
      },
    },
  ];
}
