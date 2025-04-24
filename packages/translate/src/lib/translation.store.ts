import {
  computed,
  inject,
  Injectable,
  InjectionToken,
  LOCALE_ID,
  Provider,
} from '@angular/core';
import { createIntl, createIntlCache, IntlConfig } from '@formatjs/intl';
import { entries, remap } from '@mmstack/object';
import { mutable } from '@mmstack/primitives';
import { KEY_DELIM } from './flatten';

const CONFIG_TOKEN = new InjectionToken<
  Omit<IntlConfig, 'locale' | 'messages'>
>('mmstack-intl-config');

export function provideIntlConfig(
  config: Omit<IntlConfig, 'locale' | 'messages'>,
): Provider {
  return {
    useValue: config,
    provide: CONFIG_TOKEN,
  };
}

export function injectIntlConfig() {
  return inject(CONFIG_TOKEN, { optional: true }) ?? undefined;
}

export function injectDefaultLocale() {
  return injectIntlConfig()?.defaultLocale ?? 'en-US';
}

@Injectable({
  providedIn: 'root',
})
export class TranslationStore {
  private readonly cache = createIntlCache();
  private readonly config = injectIntlConfig();
  private readonly locale = inject(LOCALE_ID);
  private readonly defaultLocale = injectDefaultLocale();
  private readonly translations = mutable<
    Record<string, Record<string, string>>
  >({
    [this.defaultLocale]: {},
  });

  private readonly nonMessageConfig = computed(() => ({
    ...this.config,
    locale: this.locale,
  }));

  private readonly messages = computed(
    () =>
      this.translations()[this.locale] ??
      this.translations()[this.defaultLocale] ??
      {},
  );

  readonly intl = computed(() =>
    createIntl(
      {
        ...this.nonMessageConfig(),
        messages: this.messages(),
      },
      this.cache,
    ),
  );

  formatMessage(key: string, values?: Record<string, string | number>) {
    const message = this.translations()[this.locale]?.[key] ?? '';
    if (!message) return '';

    return this.intl().formatMessage(
      { id: key, defaultMessage: message },
      values,
    );
  }

  register(
    namespace: string,
    flat: Partial<Record<string, Record<string, string>>>,
  ) {
    this.translations.mutate((cur) => {
      return entries(flat).reduce((acc, [locale, translation]) => {
        const localeTranslation = acc[locale] ?? {};

        acc[locale] = {
          ...localeTranslation,
          ...remap(translation ?? {}, (key, value) => ({
            value,
            key: `${namespace}${KEY_DELIM}${key}`,
          })),
        };

        return acc;
      }, cur);
    });
  }
}

export function injectIntl() {
  return inject(TranslationStore).intl;
}
