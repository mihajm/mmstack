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
  type ResourceStatus,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
} from '@angular/router';
import { createIntl, createIntlCache, type IntlConfig } from '@formatjs/intl';
import { filter, map } from 'rxjs';
import { type CompiledTranslation } from './compile';
import { prependDelim } from './delim';
import { type UnknownStringKeyObject } from './string-key-object.type';

type BaseConfig = Omit<IntlConfig, 'locale' | 'messages'> & {
  /** Checks next locale is in provided array before switching locales */
  supportedLocales?: string[];
  /** Preloads the default locale ensuring sync fallback, not necessary for most cases as it will lazily load automatically when needed */
  preloadDefaultLocale?: boolean;
  /**
   * Opt into lifecycle-aware caching of translation signals. When `true`, the
   * internal caches hold signals via `WeakRef` and rely on consumers (the `t`
   * functions returned by `injectNamespaceT` / `injectUnsafeT`) to pin signals
   * for the lifetime of their injection context (typically a component). When
   * a consumer is destroyed, signals it pinned become weakly held and may be
   * collected; the corresponding cache entries are then dropped via
   * `FinalizationRegistry`.
   *
   * Default `false` — caches grow with the set of translation keys ever read
   * and never shrink. That's fine for almost every app (translation keys are
   * a bounded set). Turn this on only for very large apps where measured
   * memory pressure from cached signals matters, or for apps that construct
   * translation keys dynamically (an anti-pattern, but this contains the leak).
   *
   * Cost when enabled: each cache hit goes through `WeakRef.deref()`, each
   * `t()` consumer holds a `Set` of pinned signals + a `DestroyRef.onDestroy`
   * hook. Negligible in practice but non-zero.
   */
  releaseCachedSignals?: boolean;
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

/**
 * Configures the `@mmstack/translate` intl layer at app bootstrap. Sets up the
 * default locale, supported-locale list, format defaults, and (optionally) a
 * route-based locale param name or a custom locale-storage adapter.
 *
 * When `defaultLocale` (or the first entry in `supportedLocales`) is provided,
 * it's also wired as Angular's `LOCALE_ID` so Angular pipes and CLDR fall
 * back to the same locale.
 *
 * @param config Intl configuration: extends `@formatjs/intl`'s `IntlConfig`
 *   with `supportedLocales`, `preloadDefaultLocale`, `releaseCachedSignals`,
 *   and either `localeParamName` (route-based) or `localeStorage` (dynamic).
 * @returns A providers array to spread into `bootstrapApplication`'s `providers`.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     ...provideIntlConfig({
 *       defaultLocale: 'en-US',
 *       supportedLocales: ['en-US', 'de-DE', 'sl-SI'],
 *       preloadDefaultLocale: true,
 *       localeStorage: {
 *         read: () => localStorage.getItem('locale'),
 *         write: (locale) => localStorage.setItem('locale', locale),
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
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

/**
 * Returns the intl config object provided via {@link provideIntlConfig}, or
 * `undefined` if no config was registered. Useful for reading flags like
 * `preloadDefaultLocale` from inside custom resolvers or services.
 *
 * @returns The active intl config, or `undefined` if none was provided.
 */
export function injectIntlConfig() {
  return inject(CONFIG_TOKEN, { optional: true }) ?? undefined;
}

/**
 * Returns the configured default locale. Falls back to Angular's `LOCALE_ID`
 * if no `defaultLocale` was set in {@link provideIntlConfig}, and finally to
 * `'en-US'`.
 *
 * @returns The resolved default locale string.
 *
 * @example
 * ```ts
 * const defaultLocale = injectDefaultLocale(); // e.g. 'en-US'
 * ```
 */
export function injectDefaultLocale() {
  return injectIntlConfig()?.defaultLocale ?? inject(LOCALE_ID) ?? 'en-US';
}

/**
 * Returns the array of supported locales as configured via
 * {@link provideIntlConfig}. If no `supportedLocales` was set, returns an
 * array containing just the resolved default locale.
 *
 * @returns The supported-locales array (never empty).
 *
 * @example
 * ```ts
 * const locales = injectSupportedLocales(); // e.g. ['en-US', 'de-DE', 'sl-SI']
 * ```
 */
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

/**
 * @internal
 * Reads `key` from the deepest route of a snapshot tree — the deepest match wins,
 * mirroring `paramsInheritanceStrategy: 'always'` semantics from the root's perspective.
 */
function readDeepestParam(
  root: ActivatedRouteSnapshot,
  key: string,
): string | null {
  let cur: ActivatedRouteSnapshot | null = root;
  let found: string | null = null;
  while (cur) {
    found = cur.paramMap.get(key) ?? found;
    cur = cur.firstChild;
  }
  return found;
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

export type SignalCache<V extends WeakKey> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
};

/**
 * Factory for the two signal caches inside `TranslationStore`. In default
 * (strong) mode it returns a plain `Map` wrapper — entries live for the
 * lifetime of the store. In weak mode it returns a `Map<string, WeakRef<V>>`
 * paired with a `FinalizationRegistry` that drops outer entries once their
 * value is collected. Weak mode relies on consumers (the `t` functions) to
 * pin values for their own lifetime via a `DestroyRef`-bound `Set`.
 */
export function createSignalCache<V extends WeakKey>(
  weak: boolean,
): SignalCache<V> {
  if (!weak) {
    const map = new Map<string, V>();
    return {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value);
      },
    };
  }

  const map = new Map<string, WeakRef<V>>();
  const registry = new FinalizationRegistry<string>((key) => {
    const ref = map.get(key);
    if (ref && ref.deref() === undefined) map.delete(key);
  });
  return {
    get: (key) => map.get(key)?.deref(),
    set: (key, value) => {
      map.set(key, new WeakRef(value));
      registry.register(value, key);
    },
  };
}

@Injectable({
  providedIn: 'root',
})
export class TranslationStore {
  private readonly cache = createIntlCache();
  private readonly config = injectIntlConfig();
  /**
   * Reflects `provideIntlConfig({ releaseCachedSignals })`. Read by the `t`
   * functions in `register-namespace.ts` to decide whether to pin signals
   * via a `DestroyRef`-bound `Set`. Public so consumers can build their own
   * `t`-like helpers without re-reading the config.
   */
  readonly cacheIsWeak = this.config?.releaseCachedSignals ?? false;
  private readonly simpleKeyMap: SignalCache<Signal<string>> =
    createSignalCache(this.cacheIsWeak);
  private readonly paramKeyMap: SignalCache<
    WeakMap<Record<string, string | number>, Signal<string>>
  > = createSignalCache(this.cacheIsWeak);
  readonly loadQueue = signal<string[]>([]);
  readonly locale: WritableSignal<string>;
  private readonly defaultLocale = injectDefaultLocale();
  private readonly translations = signal<
    Record<string, Record<string, string>>
  >({
    [this.defaultLocale]: {},
  });
  private attemptedFallbackLoad = false;
  /**
   * Locales queued purely to fetch fallback DATA (missing-key default-locale loads).
   * Completing such a load must never change the user's active locale.
   */
  private readonly dataOnlyLoads = new Set<string>();
  /** Keys already warned about in dev mode, so a missing key logs once, not per render. */
  private readonly warnedMissingKeys = new Set<string>();

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
        // Default error handling, overridable via the config's own `onError`:
        // MISSING_TRANSLATION is the DESIGNED fallback path here — the store always
        // supplies the default-locale message as `defaultMessage` — so formatjs's
        // default screaming-stack-trace handler is pure noise for it, in tests AND
        // in production. Real errors (e.g. FORMAT_ERROR from a missing variable)
        // still surface in dev mode.
        onError: (err) => {
          if ((err as { code?: string })?.code === 'MISSING_TRANSLATION')
            return;
          if (isDevMode()) console.error(err);
        },
        ...this.nonMessageConfig(),
        messages: this.messages(),
      },
      this.cache,
    ),
  );

  constructor() {
    this.locale = initLocale(proxyToGlobalSingleton(signal('en-US')));
    const paramName = this.config?.localeParamName;
    if (paramName) {
      const router = inject(Router);
      const param = toSignal(
        router.events.pipe(
          filter((e) => e instanceof NavigationEnd),
          map(() =>
            readDeepestParam(router.routerState.snapshot.root, paramName),
          ),
        ),
        {
          initialValue: readDeepestParam(
            router.routerState.snapshot.root,
            paramName,
          ),
        },
      );

      effect(() => {
        const loc = param();
        if (
          !loc ||
          loc === untracked(this.locale) ||
          untracked(this.loadQueue).includes(loc)
        )
          return;
        // loaders exist → queue the load (the dequeue effect switches once data lands);
        // no loaders → nothing to load, switch directly
        if (this.hasLocaleLoaders(loc))
          this.loadQueue.update((q) => [...q, loc]);
        else this.locale.set(loc);
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

      for (const locale of dynamicLocales.locales) {
        this.register(locale.namespace, {
          [dynamicLocales.locale]: locale.flat,
        });
      }

      const requested = dynamicLocales.locale;
      const dataOnly = this.dataOnlyLoads.delete(requested);

      // ALWAYS dequeue
      this.loadQueue.update((q) => q.filter((l) => l !== requested));

      const hasTranslations =
        dynamicLocales.locales.length > 0 || !!this.translations()[requested];

      if (!hasTranslations && !dataOnly && isDevMode()) {
        console.warn(
          `[Translate] No translations could be loaded for locale "${requested}" — locale not switched. ` +
            `Calling locale.set('${requested}') again will retry.`,
        );
      }

      // a fallback DATA load must never change the user's active locale
      if (!dataOnly && hasTranslations) this.locale.set(requested);
    });
  }

  buildSimpleKeySignal(key: string) {
    const found = this.simpleKeyMap.get(key);
    if (found) return found;

    const sig = computed(() => this.formatMessageInternal(key));
    this.simpleKeyMap.set(key, sig);
    return sig;
  }

  // Angular Ivy emits ɵɵpureFunctionN for inline object literals in template
  // expressions, so `{...}` passed to t() in a template returns the same
  // reference across CD passes until its inputs change. We exploit that by
  // caching per-(key, paramsObj) computeds, collapsing repeated CD passes to
  // a memoized signal read instead of a full ICU re-format.
  //
  // Returns both the signal and the inner WeakMap container — in `weak` cache
  // mode the caller must pin BOTH against its own lifetime, otherwise the
  // FinalizationRegistry on the outer map will reclaim the container as soon
  // as the only strong reference (the cache's WeakRef) becomes irrelevant.
  buildParamKeySignal(
    key: string,
    values: Record<string, string | number>,
  ): {
    signal: Signal<string>;
    container: WeakMap<Record<string, string | number>, Signal<string>>;
  } {
    let container = this.paramKeyMap.get(key);
    if (!container) {
      container = new WeakMap();
      this.paramKeyMap.set(key, container);
    }
    let signal = container.get(values);
    if (!signal) {
      signal = computed(() => this.formatMessageInternal(key, values));
      container.set(values, signal);
    }
    return { signal, container };
  }

  formatMessage(key: string, values?: Record<string, string | number>) {
    if (values === undefined) return this.buildSimpleKeySignal(key)();

    return this.buildParamKeySignal(key, values).signal();
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
      if (isDevMode() && !this.warnedMissingKeys.has(key)) {
        this.warnedMissingKeys.add(key);
        console.warn(
          `[Translate] Missing translation for key "${key}" (locale "${untracked(this.locale)}", fallback "${this.defaultLocale}") — rendering ''.`,
        );
      }

      if (this.attemptedFallbackLoad) return '';

      this.attemptedFallbackLoad = true;
      untracked(() => {
        if (!this.loadQueue().includes(this.defaultLocale)) {
          // data-only: fetch the default locale's messages as fallback content
          // WITHOUT switching the app's active locale to it
          this.dataOnlyLoads.add(this.defaultLocale);
          this.loadQueue.update((q) => [...q, this.defaultLocale]);
        }
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
    // new loaders can satisfy keys that previously had nothing to fall back to —
    // allow the missing-key fallback to attempt another default-locale load
    this.attemptedFallbackLoad = false;
  }

  /**
   * @internal Upgrade a queued data-only load into a user locale switch — used when
   * `locale.set(x)` is called while `x` is already in flight as a fallback data load.
   */
  markSwitchIntent(locale: string) {
    this.dataOnlyLoads.delete(locale);
  }

  hasLocaleLoaders(locale: string): boolean {
    return Array.from(this.onDemandLoaders.values()).some(
      (loaders) => loaders[locale],
    );
  }
}

/**
 * Returns the underlying `IntlShape` instance from `@formatjs/intl` used by
 * the translation store. Use this when you need direct access to formatjs
 * APIs (e.g. `formatRelativeTime`, manual `formatMessage` calls with raw ICU
 * strings) that aren't already wrapped by the `formatX` helpers in this
 * package.
 *
 * @returns The active `IntlShape` instance (signal-backed; updates on locale changes).
 *
 * @example
 * ```ts
 * const intl = injectIntl();
 * effect(() => {
 *   const formatted = intl().formatMessage(
 *     { id: 'custom.id', defaultMessage: 'Hello {name}' },
 *     { name: 'Alice' },
 *   );
 * });
 * ```
 */
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
/**
 * The dynamic locale loader's READ surface — locale switches load translation chunks
 * through an internal resource; this exposes its status without the mutating ref.
 * Structurally a `ResourceLike`, so it plugs straight into `@mmstack/primitives`'
 * coordination: register it into a transition scope and a locale switch drives
 * suspense/transition pending like any resource —
 *
 * ```ts
 * // once, in a component under your scope/suspense boundary:
 * registerResource(injectLocaleLoadState(), { suspends: false });
 * // switching inside a transition then reveals the new locale in ONE frame:
 * const t = startTransition(() => locale.set('de'));
 * ```
 */
export function injectLocaleLoadState(): {
  readonly status: Signal<ResourceStatus>;
  readonly isLoading: Signal<boolean>;
  hasValue(): boolean;
} {
  const loader = inject(TranslationStore).dynamicLocaleLoader;
  return {
    status: loader.status,
    isLoading: loader.isLoading,
    hasValue: () => loader.hasValue(),
  };
}

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
    if (value === untracked(source)) return;

    if (untracked(store.loadQueue).includes(value)) {
      // already in flight — if it was queued as a fallback DATA load, upgrade it to a
      // user switch so the locale flips once the load completes
      store.markSwitchIntent(value);
      return;
    }

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
