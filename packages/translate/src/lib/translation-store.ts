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

type BaseConfig = Omit<IntlConfig, 'locale' | 'messages'> & {
  /** Checks next locale is in provided array before switching locales */
  supportedLocales?: string[];
  /** Preloads the default locale ensuring sync fallback, not necessary for most cases as it will lazily load automatically when needed */
  preloadDefaultLocale?: boolean;
};

type RouteBasedConfig = BaseConfig & {
  /** Auto-resolution when using a locale parameter via angular router */
  localeParamName?: string;
  localeStorage?: never;
};

type LocaleStorage = {
  /** Called once on init to restore the last selected locale. Return `null` if nothing is stored. Values not in `supportedLocales` are ignored. */
  read: () => string | null;
  /** Called whenever the active locale changes. Fires once on init with the resolved initial value. */
  write: (locale: string) => void;
};

type DynamicConfig = BaseConfig & {
  /** Custom storage mechanism for last set locale, it will be read on init & set the locale to the last value if it is still valid */
  localeStorage?: LocaleStorage;
  localeParamName?: never;
};

type Config = RouteBasedConfig | DynamicConfig;

const CONFIG_TOKEN = new InjectionToken<Config>('mmstack-intl-config');

export function provideIntlConfig(config: Config): Provider[] {
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

/**
 * @internal
 * @deprecated will be removed when ng23 drops
 */
export function readLocaleUnsafe() {
  return STORE_LOCALE();
}

export function injectLocaleInternal() {
  return STORE_LOCALE;
}

function proxyToGlobalSingleton(
  src: WritableSignal<string>,
): WritableSignal<string> {
  const originalSet = src.set;

  src.set = (next) => {
    originalSet(next);
    STORE_LOCALE.set(next);
  };

  src.update = (updater) => {
    src.set(updater(untracked(src)));
  };

  return src;
}

function isDynamicConfig(
  cfg?: Config,
): cfg is DynamicConfig & { localeStorage: LocaleStorage } {
  return !!cfg && 'localeStorage' in cfg && !!cfg.localeStorage;
}

function initLocale(src: WritableSignal<string>) {
  const config = injectIntlConfig();
  const defaultValue = injectDefaultLocale();

  if (!isDynamicConfig(config)) {
    src.set(defaultValue);
    return src;
  }

  let next: string | null = null;
  try {
    const stored = config.localeStorage.read();

    if (
      stored !== null &&
      (!config.supportedLocales || config.supportedLocales.includes(stored))
    ) {
      next = stored;
    }
  } catch (e) {
    if (isDevMode())
      console.error(
        '[Translate] Failed to read stored locale from localeStorage',
        e,
      );
  }

  src.set(next ?? defaultValue);
  effect(() => {
    try {
      config.localeStorage.write(src());
    } catch (e) {
      if (isDevMode())
        console.error('[Translate] Failed to write locale to localeStorage', e);
    }
  });

  return src;
}

@Injectable({
  providedIn: 'root',
})
export class TranslationStore {
  private readonly simpleKeyMap = new Map<string, Signal<string>>();
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
    request: computed(() => this.loadQueue().at(0) ?? null),
    loader: async ({ request: newLocale, abortSignal }) => {
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
    this.locale = proxyToGlobalSingleton(initLocale(signal('en-US')));
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

  buildSimpleKeySignal(key: string) {
    const found = this.simpleKeyMap.get(key);
    if (found) return found;

    const sig = computed(() => this.formatMessageInternal(key));
    this.simpleKeyMap.set(key, sig);
    return sig;
  }

  formatMessage(key: string, values?: Record<string, string | number>) {
    if (values === undefined) return this.buildSimpleKeySignal(key)();

    return this.formatMessageInternal(key, values);
  }

  private formatMessageInternal(
    key: string,
    values?: Record<string, string | number>,
  ) {
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

/**
 * Power-user escape hatch for adding translations imperatively (e.g. content
 * loaded from a remote API after bootstrap). Returns a function that registers
 * a flat per-locale map of keys under a given namespace
 *
 * Pair with {@link injectUnsafeT} to read the added keys without compile-time
 * constraints.
 *
 * @example
 * ```ts
 * const addTranslations = injectAddTranslations();
 * addTranslations('remote', {
 *   'en-US': { greeting: 'Hi {name}' },
 *   'sl-SI': { greeting: 'Zdravo {name}' },
 * });
 * ```
 */
export function injectAddTranslations() {
  const store = inject(TranslationStore);
  const supportedLocales = injectIntlConfig()?.supportedLocales;
  const supportedLocalesSet = supportedLocales
    ? new Set(supportedLocales)
    : null;

  const validate = supportedLocalesSet
    ? (translations: Record<string, Record<string, string>>) => {
        const clean: Record<string, Record<string, string>> = {};
        const invalidLocales: string[] = [];

        for (const [locale, translation] of Object.entries(translations)) {
          if (!supportedLocalesSet.has(locale)) {
            invalidLocales.push(locale);
            continue;
          }
          clean[locale] = translation;
        }

        if (isDevMode() && invalidLocales.length > 0)
          console.warn(
            `[Translate] Attempted to add translations for unsupported locales: ${invalidLocales.join(', ')}. These translations were ignored. Supported locales are: ${(supportedLocales ?? []).join(', ')}.`,
          );

        return clean;
      }
    : (translations: Record<string, Record<string, string>>) => translations;

  return (ns: string, translations: Record<string, Record<string, string>>) => {
    store.register(ns, validate(translations));
  };
}
