import {
  computed,
  effect,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  LOCALE_ID,
  Provider,
  resource,
  Signal,
  signal,
  untracked,
  WritableSignal,
} from '@angular/core';
import { createIntl, createIntlCache, IntlConfig } from '@formatjs/intl';
import { CompiledTranslation } from './compile';
import { prependDelim } from './delim';
import { UnknownStringKeyObject } from './string-key-object.type';

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
  readonly loadQueue = signal<string[]>([]);
  readonly locale = signal(inject(LOCALE_ID));
  private readonly defaultLocale = injectDefaultLocale();
  private readonly translations = signal<
    Record<string, Record<string, string>>
  >({
    [this.defaultLocale]: {},
  });

  private readonly onDemandLoaders = new Map<
    string,
    Record<
      string,
      () => Promise<CompiledTranslation<UnknownStringKeyObject, string>>
    >
  >();

  private readonly nonMessageConfig = computed(() => ({
    ...this.config,
    locale: this.locale(),
  }));

  private readonly messages = computed(
    () =>
      this.translations()[this.locale()] ??
      this.translations()[this.defaultLocale] ??
      {},
  );

  readonly dynamicLocaleLoader = resource({
    params: computed(() => this.loadQueue().at(0) ?? null),
    loader: async ({ params: newLocale, abortSignal }) => {
      if (!newLocale) return;

      const currentTranslations = untracked(this.translations);

      const loadPromises: Promise<{
        namespace: string;
        flat: Record<string, string>;
      } | null>[] = [];

      for (const [namespace, loaders] of this.onDemandLoaders.entries()) {
        const loader = loaders[newLocale];
        if (loader) {
          const hasNamespaceForLocale =
            currentTranslations[newLocale] &&
            Object.keys(currentTranslations[newLocale]).some((key) =>
              key.startsWith(`${prependDelim(namespace, '').slice(0, -1)}`),
            );

          if (!hasNamespaceForLocale) {
            loadPromises.push(
              loader()
                .then((translation) => {
                  if (abortSignal.aborted) return null;
                  return {
                    namespace: translation.namespace,
                    flat: translation.flat,
                  };
                })
                .catch((err) => {
                  if (isDevMode()) {
                    console.error(
                      '[Translate] Failed to load',
                      namespace,
                      newLocale,
                      err,
                    );
                  }

                  return null;
                }),
            );
          }
        }
      }

      return Promise.all(loadPromises)
        .then((res) => res.filter((r) => r !== null))
        .then((res) => ({
          locales: res,
          locale: newLocale,
        }));
    },
  });

  readonly intl = computed(() =>
    createIntl(
      {
        ...this.nonMessageConfig(),
        messages: this.messages(),
      },
      this.cache,
    ),
  );

  constructor() {
    effect(() => {
      if (
        // should never be in error state, but best to check in case something throws
        this.dynamicLocaleLoader.error() ||
        this.dynamicLocaleLoader.isLoading()
      )
        return;
      const dynamicLocales = this.dynamicLocaleLoader.value();

      if (!dynamicLocales) return;
      for (const locale of dynamicLocales.locales) {
        this.register(locale.namespace, {
          [dynamicLocales.locale]: locale.flat,
        });
      }
      this.loadQueue.update((q) =>
        q.filter((l) => l !== dynamicLocales.locale),
      );
      this.locale.set(dynamicLocales.locale);
    });
  }

  formatMessage(key: string, values?: Record<string, string | number>) {
    const message = this.translations()[this.locale()]?.[key] ?? '';

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
    this.translations.update((cur) => {
      return Object.entries(flat).reduce(
        (acc, [locale, translation]) => {
          const localeTranslation = acc[locale] ?? {};

          const withNS = Object.entries(translation ?? {}).reduce(
            (acc, [key, value]) => {
              acc[prependDelim(namespace, key)] = value;
              return acc;
            },
            {} as Record<string, string>,
          );

          acc[locale] = {
            ...localeTranslation,
            ...withNS,
          };

          return acc;
        },
        { ...cur },
      );
    });
  }

  registerOnDemandLoaders(
    namespace: string,
    loaders: Record<string, () => Promise<any>>,
  ) {
    this.onDemandLoaders.set(namespace, loaders);
  }

  hasLocaleLoaders(locale: string): boolean {
    return Array.from(this.onDemandLoaders.values()).some(
      (loaders) => loaders[locale],
    );
  }
}

export function injectIntl() {
  return inject(TranslationStore).intl;
}

/**
 * Inject a dynamic locale signal that supports runtime language switching.
 *
 * @returns A writable signal with the current locale and loading state.
 * Only allows switching to locales that have registered loaders.
 *
 * @example
 * ```typescript
 * const locale = injectDynamicLocale();
 *
 * // Switch language (triggers automatic translation loading)
 * locale.set('sl-SI');
 *
 * // Check loading state
 * if (locale.isLoading()) {
 *   // Show spinner
 * }
 * ```
 */
export function injectDynamicLocale(): WritableSignal<string> & {
  isLoading: Signal<boolean>;
} {
  const store = inject(TranslationStore);

  const source = computed(() => store.locale()) as WritableSignal<string> & {
    isLoading: Signal<boolean>;
  };

  const set = (value: string) => {
    if (
      value === untracked(source) ||
      !store.hasLocaleLoaders(value) ||
      untracked(store.loadQueue).includes(value)
    )
      return;
    store.loadQueue.update((q) => [...q, value]);
  };
  source.set = set;
  source.update = (updater: (value: string) => string) => {
    const next = updater(untracked(source));
    source.set(next);
  };
  source.asReadonly = () => source;

  source.isLoading = store.dynamicLocaleLoader.isLoading;

  return source;
}
