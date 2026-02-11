import {
  computed,
  effect,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  LOCALE_ID,
  type Provider,
  resource,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { createIntl, createIntlCache, type IntlConfig } from '@formatjs/intl';
import { type CompiledTranslation } from './compile';
import { prependDelim } from './delim';
import { pathParam } from './path-param';
import { type UnknownStringKeyObject } from './string-key-object.type';

const CONFIG_TOKEN = new InjectionToken<
  Omit<IntlConfig, 'locale' | 'messages'> & {
    supportedLocales?: string[];
    preloadDefaultLocale?: boolean;
    localeParamName?: string;
  }
>('mmstack-intl-config');

export function provideIntlConfig(
  config: Omit<IntlConfig, 'locale' | 'messages'> & {
    /** Checks next locale is in provided array before switching locales */
    supportedLocales?: string[];
    /** Preloads the default locale ensuring sync fallback, not necessary for most cases as it will lazily load automatically when needed */
    preloadDefaultLocale?: boolean;
    /** Auto-resolution when using a locale parameter via angular router */
    localeParamName?: string;
  },
): Provider[] {
  const providers: Provider[] = [
    {
      useFactory: (localeId: string) => {
        const next = {
          ...config,
        };

        const defaultLocale =
          config.defaultLocale ?? config.supportedLocales?.at(0) ?? localeId;

        if (
          next.supportedLocales &&
          !next.supportedLocales.includes(defaultLocale)
        ) {
          next.supportedLocales = [...next.supportedLocales, defaultLocale];
        }

        return next;
      },
      deps: [LOCALE_ID],
      provide: CONFIG_TOKEN,
    },
  ];

  const defaultLocale = config.defaultLocale ?? config.supportedLocales?.at(0);

  if (!defaultLocale) return providers;

  providers.push({
    provide: LOCALE_ID,
    useValue: defaultLocale,
  });

  return providers;
}

export function injectIntlConfig() {
  return inject(CONFIG_TOKEN, { optional: true }) ?? undefined;
}

export function injectDefaultLocale() {
  return injectIntlConfig()?.defaultLocale ?? inject(LOCALE_ID) ?? 'en-US';
}

export function injectSupportedLocales() {
  return injectIntlConfig()?.supportedLocales ?? [injectDefaultLocale()];
}

/**
 * @internal
 * the actual locale signal used to store the current locale string
 */
const STORE_LOCALE = signal('en-US');

export function injectLocaleInternal() {
  try {
    return injectDynamicLocale();
  } catch {
    return STORE_LOCALE;
  }
}

@Injectable({
  providedIn: 'root',
})
export class TranslationStore {
  private readonly cache = createIntlCache();
  private readonly config = injectIntlConfig();
  readonly loadQueue = signal<string[]>([]);
  readonly locale: WritableSignal<string>;
  private readonly defaultLocale = injectDefaultLocale();
  private readonly translations = signal<
    Record<string, Record<string, string>>
  >({
    [this.defaultLocale]: {},
  });
  private attemptedFallbackLoad = false;

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
    this.locale = STORE_LOCALE;
    this.locale.set(injectDefaultLocale());
    const paramName = this.config?.localeParamName;
    if (paramName) {
      const param = pathParam(paramName);

      effect(() => {
        const loc = param();
        if (
          !loc ||
          loc === untracked(this.locale) ||
          untracked(this.loadQueue).includes(loc)
        )
          return;
        if (this.hasLocaleLoaders(loc)) this.locale.set(loc);
        else this.loadQueue.update((q) => [...q, loc]);
      });
    }

    effect(() => {
      if (
        // should never be in error state, but best to check in case something throws
        this.dynamicLocaleLoader.error() ||
        this.dynamicLocaleLoader.isLoading()
      )
        return;
      const dynamicLocales = this.dynamicLocaleLoader.value();

      if (!dynamicLocales) return;

      // Register loaded translations
      for (const locale of dynamicLocales.locales) {
        this.register(locale.namespace, {
          [dynamicLocales.locale]: locale.flat,
        });
      }

      const hasTranslations =
        dynamicLocales.locales.length > 0 ||
        this.translations()[dynamicLocales.locale];

      if (hasTranslations) {
        this.loadQueue.update((q) =>
          q.filter((l) => l !== dynamicLocales.locale),
        );
        this.locale.set(dynamicLocales.locale);
      }
    });
  }

  formatMessage(key: string, values?: Record<string, string | number>) {
    const message =
      this.translations()[this.locale()]?.[key] ??
      this.translations()[this.defaultLocale]?.[key] ??
      '';

    if (!message) {
      if (this.attemptedFallbackLoad) return '';

      this.attemptedFallbackLoad = true;
      untracked(() => {
        if (!this.loadQueue().includes(this.defaultLocale))
          this.loadQueue.update((q) => [...q, this.defaultLocale]);
      });
      return '';
    }

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
  const supportedLocales = injectIntlConfig()?.supportedLocales;

  const source = computed(() => store.locale()) as WritableSignal<string> & {
    isLoading: Signal<boolean>;
  };

  const inSupportedLocales =
    supportedLocales === undefined
      ? () => true
      : (locale: string) => supportedLocales.includes(locale);

  const set = (value: string) => {
    if (
      value === untracked(source) ||
      untracked(store.loadQueue).includes(value)
    )
      return;

    if (!inSupportedLocales(value)) {
      if (isDevMode())
        console.warn(
          `[Translate] Locale "${value}" is not in supportedLocales, switch prevented. Available options are:`,
          supportedLocales,
        );

      return;
    }

    if (isDevMode() && !store.hasLocaleLoaders(value))
      console.warn(
        `[Translate] No loaders registered for locale "${value}". Switching to this locale will have no effect.`,
      );

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
