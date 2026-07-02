import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  isDevMode,
  isSignal,
  makeStateKey,
  PLATFORM_ID,
  TransferState,
  untracked,
  type Signal,
} from '@angular/core';
import { type ResolveFn } from '@angular/router';
import {
  compileTranslation,
  type CompiledTranslation,
  type inferCompiledTranslationMap,
  type inferCompiledTranslationNamespace,
} from './compile';
import { replaceWithDelim } from './delim';
import { injectResolveParamLocale } from './resolver-locale';
import {
  type AnyStringRecord,
  type UnknownStringKeyObject,
} from './string-key-object.type';
import {
  injectDefaultLocale,
  injectIntlConfig,
  TranslationStore,
} from './translation-store';

function createEqualsRecord<T extends AnyStringRecord>(keys: (keyof T)[] = []) {
  let keyMatcher: (a: T, b: T) => boolean;

  if (keys.length === 0) {
    keyMatcher = () => true;
  } else if (keys.length === 1) {
    const key = keys[0];
    keyMatcher = (a, b) => a[key] === b[key];
  } else {
    keyMatcher = (a, b) => {
      return keys.every((k) => a[k] === b[k]);
    };
  }

  return (a?: T, b?: T): boolean => {
    if (a === b) return true;
    if (!a && !b) return true;
    if (!a || !b) return false;
    return keyMatcher(a, b);
  };
}

type TFunction<TMap extends AnyStringRecord> = <
  TKey extends keyof TMap & string,
>(
  key: TKey,
  ...args: TMap[TKey] extends void ? [] : [TMap[TKey]]
) => string;

type SignalTFunction<TMap extends AnyStringRecord> = <
  TKey extends keyof TMap & string,
>(
  key: TKey,
  ...args: TMap[TKey] extends void ? [] : [() => TMap[TKey]]
) => Signal<string>;

type TFunctionWithSignalConstructor<
  TMap extends AnyStringRecord,
  TFN extends TFunction<TMap>,
> = TFN & {
  asSignal: SignalTFunction<TMap>;
};

/**
 * Returns a pinning callback when the store is configured for weak-cache mode,
 * otherwise `null`. The callback adds objects (signals / WeakMap containers)
 * to a per-consumer `Set` so they stay strongly reachable while the consumer
 * lives. On `DestroyRef.onDestroy` the set is cleared, releasing strong refs
 * so the cache's `WeakRef` entries become collectable.
 *
 * Must be invoked in an injection context (it consumes `DestroyRef`). That's
 * already guaranteed by the call sites in `createT` and `addSignalFn`, both
 * of which run inside `inject(TranslationStore)`-bearing factories.
 */
function createPinner(
  store: TranslationStore,
): ((sig: object, container?: object) => void) | null {
  if (!store.cacheIsWeak) return null;
  const pinned = new Set<object>();
  inject(DestroyRef).onDestroy(() => pinned.clear());
  return (sig: object, container?: object) => {
    pinned.add(sig);
    if (container) pinned.add(container);
  };
}

export function addSignalFn<
  TMap extends AnyStringRecord,
  TFn extends TFunction<TMap>,
>(
  fn: TFn,
  store: TranslationStore,
  keyMap: Map<string, string>,
): TFunctionWithSignalConstructor<TMap, TFn> {
  const withSig = fn as TFunctionWithSignalConstructor<TMap, TFn>;
  const pin = createPinner(store);

  const asSignal = <TKey extends keyof TMap & string>(
    key: TKey,
    variables?: () => AnyStringRecord,
  ): Signal<string> => {
    const stringKey = key as string;

    let flatPath = keyMap.get(stringKey);

    if (flatPath === undefined) {
      flatPath = replaceWithDelim(stringKey);
      keyMap.set(stringKey, flatPath);
    }

    if (variables === undefined) {
      const sig = store.buildSimpleKeySignal(flatPath);
      pin?.(sig);
      return sig;
    }

    const varsFn = variables;
    const varsSignal = isSignal(varsFn)
      ? varsFn
      : computed(() => varsFn(), {
          equal: createEqualsRecord(Object.keys(varsFn())),
        });

    return computed(() => {
      const vars = varsSignal();
      const { signal, container } = store.buildParamKeySignal(flatPath, vars);
      pin?.(signal, container);
      return signal();
    });
  };

  withSig.asSignal = asSignal as unknown as TFunctionWithSignalConstructor<
    TMap,
    TFn
  >['asSignal'];

  return withSig;
}

export function createT<TMap extends AnyStringRecord>(
  store: TranslationStore,
  keyMap = new Map<string, string>(),
): TFunction<TMap> {
  const pin = createPinner(store);

  const fn = <TKey extends keyof TMap & string>(
    key: TKey,
    variables?: AnyStringRecord,
  ): string => {
    const stringKey = key as string;

    let k = keyMap.get(stringKey);

    if (k === undefined) {
      k = replaceWithDelim(stringKey);
      keyMap.set(stringKey, k);
    }

    if (variables === undefined) {
      const sig = store.buildSimpleKeySignal(k);
      pin?.(sig);
      return sig();
    }

    const { signal, container } = store.buildParamKeySignal(k, variables);
    pin?.(signal, container);
    return signal();
  };

  return fn as unknown as TFunction<TMap>;
}

/**
 * Shape accepted by a namespace loader: a direct `CompiledTranslation`, or an
 * ES-module-style object exposing one as `default` or `translation`. Lets
 * callers write `() => import('./quote.namespace')` instead of the more
 * verbose `() => import('./quote.namespace').then((m) => m.default)`.
 */
export type LoadedTranslation<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T | { default: T } | { translation: T };

function isCompiledTranslation(
  value: unknown,
): value is CompiledTranslation<UnknownStringKeyObject, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    'flat' in value &&
    'namespace' in value
  );
}

/**
 * @internal exported for unit testing
 *
 * Unwraps a loader result to a `CompiledTranslation`. Detection order:
 *   1. value is already a `CompiledTranslation` (has `flat` + `namespace`)
 *   2. value has a `default` export holding a `CompiledTranslation` (ESM default)
 *   3. value has a `translation` export holding a `CompiledTranslation` (named export)
 */
export function resolveTranslationModule<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
>(loaded: LoadedTranslation<T>): T {
  if (isCompiledTranslation(loaded)) return loaded as T;
  if (loaded && typeof loaded === 'object') {
    const def = (loaded as { default?: unknown }).default;
    if (isCompiledTranslation(def)) return def as T;
    const tr = (loaded as { translation?: unknown }).translation;
    if (isCompiledTranslation(tr)) return tr as T;
  }
  throw new Error(
    '[@mmstack/translate] Loader did not return a CompiledTranslation. Expected the value from `createNamespace` / `createTranslation`, or a module exporting one as `default` or `translation`.',
  );
}

/**
 * Registers a translation namespace and returns helpers for consuming it:
 *
 * - `injectNamespaceT()` — an injection helper that yields a type-safe `t(key, vars?)`
 *   function (plus `t.asSignal(key, vars?)` for reactive keys) bound to this namespace.
 * - `resolveNamespaceTranslation` — an Angular `ResolveFn` you attach to a route's
 *   `resolve` so the relevant locale's translations are loaded before the route activates.
 *
 * Loaders are lazy: the default-locale translation is loaded only when needed
 * (or eagerly if `preloadDefaultLocale` is set in the intl config), and each
 * non-default locale loader runs only when its locale is the active one.
 *
 * @typeParam TDefault The `CompiledTranslation` type of the default-locale loader.
 * @param defaultTranslation Loader for the default locale. May return a
 *   `CompiledTranslation` directly, or an ES-module-style object exposing one
 *   as `default` or `translation`.
 * @param other Map of `locale → loader`, each loader returning a translation
 *   matching the default's namespace.
 * @returns A value that destructures either as a tuple
 *   `[injectFn, resolveFn]` (preferred — lets each call site pick its own
 *   names per namespace) or as an object
 *   `{ injectNamespaceT, resolveNamespaceTranslation }` (kept for backwards
 *   compatibility).
 *
 * @example
 * ```ts
 * // translations/app.namespace.ts
 * export const app = createNamespace('app', {
 *   greeting: 'Hello {name}!',
 *   nav: { home: 'Home' },
 * });
 *
 * export const appDE = app.createTranslation('de', {
 *   greeting: 'Hallo {name}!',
 *   nav: { home: 'Startseite' },
 * });
 *
 * // app-routes.ts — tuple destructure lets you name things per namespace
 * const [injectAppT, resolveApp] = registerNamespace(
 *   () => import('./translations/app.namespace').then((m) => m.app.translation),
 *   {
 *     de: () => import('./translations/app.namespace').then((m) => m.appDE),
 *   },
 * );
 *
 * export const routes: Routes = [
 *   {
 *     path: ':locale',
 *     resolve: { _t: resolveApp },
 *     // ...
 *   },
 * ];
 *
 * // in a component / service:
 * class HomeComponent {
 *   private readonly t = injectAppT();
 *   readonly greeting = this.t('app.greeting', { name: 'Alice' });
 *   readonly liveGreeting = this.t.asSignal('app.greeting', () => ({ name: name() }));
 * }
 * ```
 *
 * @example
 * ```ts
 * // Object form still works (back-compat):
 * const { injectNamespaceT, resolveNamespaceTranslation } = registerNamespace(...);
 * ```
 */
export function registerNamespace<
  TDefault extends CompiledTranslation<UnknownStringKeyObject, string>,
>(
  defaultTranslation: () => Promise<LoadedTranslation<TDefault>>,
  other: Record<
    string,
    () => Promise<
      LoadedTranslation<
        CompiledTranslation<
          UnknownStringKeyObject,
          inferCompiledTranslationNamespace<TDefault>,
          string
        >
      >
    >
  >,
) {
  type $Map = inferCompiledTranslationMap<TDefault>;
  type $BaseTFN = TFunction<$Map>;
  type $TFN = TFunctionWithSignalConstructor<$Map, $BaseTFN>;

  const keyMap = new Map<string, string>();

  const unwrappedDefault = (): Promise<TDefault> =>
    defaultTranslation().then(resolveTranslationModule);

  type LocaleLoader = () => Promise<
    CompiledTranslation<
      UnknownStringKeyObject,
      inferCompiledTranslationNamespace<TDefault>,
      string
    >
  >;
  const unwrappedOther: Record<string, LocaleLoader> = Object.fromEntries(
    Object.entries(other).map(([loc, loader]) => [
      loc,
      () => loader().then(resolveTranslationModule) as ReturnType<LocaleLoader>,
    ]),
  );

  const injectT = (): $TFN => {
    const store = inject(TranslationStore);

    return addSignalFn(createT(store, keyMap), store, keyMap);
  };

  let defaultTranslationLoaded = false;
  const loadedLocales = new Set<string>();

  /**
   * Load + register translations for `locale` WITHOUT touching the active locale — the
   * shared core of the resolver and {@link warm}. Idempotent via the closure guards.
   * `'ready'` = the locale's data is usable (the resolver may switch to it);
   * `'default-cached'` preserves the resolver's historical no-switch behavior for the
   * repeat default-fallback path.
   */
  const loadForLocale = async (
    store: TranslationStore,
    locale: string,
    defaultLocale: string,
    shouldPreloadDefault: boolean,
  ): Promise<'ready' | 'default-cached' | 'failed'> => {
    const tPromise = unwrappedOther[locale] as LocaleLoader | undefined;

    const promise = tPromise ?? unwrappedDefault;
    if (!promise) {
      if (isDevMode())
        console.warn(`No translation found for locale: ${locale}`);
      return 'failed';
    }

    if (promise === unwrappedDefault && defaultTranslationLoaded)
      return 'default-cached';

    // already loaded on a previous run — nothing to fetch or register
    if (tPromise && loadedLocales.has(locale)) return 'ready';

    try {
      const promises = [promise()];

      if (
        shouldPreloadDefault &&
        !defaultTranslationLoaded &&
        promise !== unwrappedDefault
      )
        promises.push(unwrappedDefault());

      const translations = await Promise.allSettled(promises);

      const fulfilled = translations.map((t) =>
        t.status === 'fulfilled' ? t.value : null,
      );

      if (fulfilled.at(0) === null && fulfilled.at(1) === null)
        throw new Error('Failed to load translations');

      const [t, defaultT] = fulfilled;

      const ns = t?.namespace ?? defaultT?.namespace;
      if (!ns) throw new Error('No namespace found in translation');

      if (isDevMode() && t && t.locale !== locale && t.locale)
        console.warn(`Expected locale to be ${locale} but got ${t.locale}`);

      store.registerOnDemandLoaders(ns, {
        ...unwrappedOther,
        [defaultLocale]: unwrappedDefault,
      });

      const toRegister: Record<string, Record<string, string>> = {};
      if (t) toRegister[locale] = t.flat;
      if (defaultT) toRegister[defaultLocale] = defaultT.flat;

      store.register(ns, toRegister);

      if (t) loadedLocales.add(locale);
      if (promise === unwrappedDefault || defaultT)
        defaultTranslationLoaded = true;
      return 'ready';
    } catch {
      if (isDevMode()) {
        console.warn(
          `Failed to load translation for locale: ${locale} — locale switch skipped.`,
        );
      }
      return 'failed';
    }
  };

  const resolver: ResolveFn<void> = async (snapshot) => {
    const store = inject(TranslationStore);

    const locale = injectResolveParamLocale(snapshot);
    const defaultLocale = injectDefaultLocale();
    const shouldPreloadDefault =
      injectIntlConfig()?.preloadDefaultLocale ?? false;

    const result = await loadForLocale(
      store,
      locale,
      defaultLocale,
      shouldPreloadDefault,
    );

    // only switch on success — switching to a locale whose load failed would render
    // wholesale fallbacks (or '') with no signal to the router that anything failed
    if (result === 'ready' && locale !== untracked(store.locale))
      store.locale.set(locale);
  };

  /**
   * Speculatively load + register this namespace's translations for `locale` (the
   * ACTIVE locale when omitted) WITHOUT switching — the warm half of hover-prefetch.
   * Pair with `@mmstack/router-core`'s `withPrefetch` so hovering a link loads the
   * locale chunk before navigation (idempotent; the later resolver run is then instant):
   *
   * ```ts
   * resolve: {
   *   i18n: withPrefetch(ns.resolveNamespaceTranslation, {
   *     description: 'quote-i18n',
   *     prefetch: (ctx) => ns.warmNamespaceTranslation(ctx.params()['locale']),
   *   }),
   * }
   * ```
   */
  const warm = async (locale?: string): Promise<void> => {
    const store = inject(TranslationStore);
    const defaultLocale = injectDefaultLocale();
    const shouldPreloadDefault =
      injectIntlConfig()?.preloadDefaultLocale ?? false;
    await loadForLocale(
      store,
      locale || untracked(store.locale),
      defaultLocale,
      shouldPreloadDefault,
    );
  };

  return Object.assign([injectT, resolver, warm] as const, {
    injectNamespaceT: injectT,
    resolveNamespaceTranslation: resolver,
    warmNamespaceTranslation: warm,
  });
}

type UntypedTFunction<TNS extends string> = {
  (key: `${TNS}.${string}`, args?: Record<string, string | number>): string;
  asSignal: (
    key: `${TNS}.${string}`,
    args?: () => Record<string, string | number>,
  ) => Signal<string>;
};

/**
 * Registers a type-unsafe namespace for translations loaded from a remote
 * source where the key/value shape isn't known at compile time. The resolver
 * and `t` function work the same as {@link registerNamespace}, except keys are
 * typed only as `${ns}.${string}` and parameters are `Record<string, string>`
 * with no per-key validation.
 *
 * @typeParam TNS The namespace string literal type.
 * @param ns The namespace identifier (e.g. `'remote'`).
 * @param defaultTranslation Loader returning a raw `Record<string, string>` of
 *   flattened keys → translated values for the default locale.
 * @param other Map of `locale → loader`, each loader returning the same raw
 *   record shape.
 * @returns A value that destructures either as a tuple `[injectFn, resolveFn]`
 *   or as an object `{ injectNamespaceT, resolveNamespaceTranslation }` (back-compat).
 *
 * @example
 * ```ts
 * const [injectCmsT, resolveCms] = registerRemoteNamespace(
 *   'cms',
 *   () => fetch('/i18n/cms/en.json').then((r) => r.json()),
 *   {
 *     de: () => fetch('/i18n/cms/de.json').then((r) => r.json()),
 *   },
 * );
 *
 * // in a component:
 * const t = injectCmsT();
 * t('cms.banner.title', { campaign: 'Summer' }); // typed as string
 * ```
 */
export function registerRemoteNamespace<TNS extends string>(
  ns: TNS,
  defaultTranslation: () => Promise<Record<string, string>>,
  other: Record<string, () => Promise<Record<string, string>>>,
) {
  const keyMap = new Map<string, string>();

  // TransferState plumbing: remote translations fetched during SSR
  let transferState: TransferState | null = null;
  let onServer = false;

  const loadRaw = (
    loader: () => Promise<Record<string, string>>,
    locale: string,
  ): Promise<Record<string, string>> => {
    const key = makeStateKey<Record<string, string>>(
      `@mmstack/translate:${ns}:${locale}`,
    );

    if (!onServer && transferState?.hasKey(key)) {
      return Promise.resolve(transferState.get(key, {}));
    }

    return loader().then((raw) => {
      if (onServer) transferState?.set(key, raw);
      return raw;
    });
  };

  const compileLoader =
    <TLocale extends string>(
      loader: () => Promise<Record<string, string>>,
      locale: TLocale,
    ) =>
    () =>
      loadRaw(loader, locale).then((raw) =>
        compileTranslation(raw, ns, locale),
      );

  const compiledOther: Record<
    string,
    () => Promise<CompiledTranslation<UnknownStringKeyObject, TNS>>
  > = Object.fromEntries(
    Object.entries(other).map(([loc, loader]) => [
      loc,
      compileLoader(loader, loc),
    ]),
  );

  const injectT = (): UntypedTFunction<TNS> => {
    const store = inject(TranslationStore);

    return addSignalFn(
      createT(store, keyMap),
      store,
      keyMap,
    ) as UntypedTFunction<TNS>;
  };

  let defaultTranslationLoaded = false;

  const loadedLocales = new Set<string>();
  const resolver: ResolveFn<void> = async (snapshot) => {
    const store = inject(TranslationStore);

    // capture for loadRaw — the resolver always runs in an injection context
    transferState = inject(TransferState, { optional: true });
    onServer = isPlatformServer(inject(PLATFORM_ID));

    const locale = injectResolveParamLocale(snapshot);

    const defaultLocale = injectDefaultLocale();
    const shouldPreloadDefault =
      injectIntlConfig()?.preloadDefaultLocale ?? false;

    const tPromise = other[locale] as (typeof other)[string] | undefined;

    const promise = tPromise ?? defaultTranslation;

    if (!promise && isDevMode()) {
      return console.warn(`No translation found for locale: ${locale}`);
    }

    if (promise === defaultTranslation && defaultTranslationLoaded) return;

    // already fetched on a previous navigation — just sync the locale, skip the refetch
    if (tPromise && loadedLocales.has(locale)) {
      if (locale !== untracked(store.locale)) store.locale.set(locale);
      return;
    }

    let loaded = false;
    try {
      const requestedLocale =
        promise === defaultTranslation ? defaultLocale : locale;
      const promises = [loadRaw(promise, requestedLocale)];

      if (
        shouldPreloadDefault &&
        !defaultTranslationLoaded &&
        promise !== defaultTranslation
      )
        promises.push(loadRaw(defaultTranslation, defaultLocale));

      const translations = await Promise.allSettled(promises);

      const fulfilled = translations.map((t) =>
        t.status === 'fulfilled' ? t.value : null,
      );

      if (fulfilled.at(0) === null && fulfilled.at(1) === null)
        throw new Error('Failed to load translations');

      const [baseT, baseDefaultT] = fulfilled;

      const t = baseT ? compileTranslation(baseT, ns, locale) : null;
      const defaultT = baseDefaultT
        ? compileTranslation(baseDefaultT, ns, defaultLocale)
        : null;

      if (isDevMode() && t && t.locale !== locale && t.locale)
        console.warn(`Expected locale to be ${locale} but got ${t.locale}`);

      store.registerOnDemandLoaders(ns, {
        ...compiledOther,
        [defaultLocale]: compileLoader(defaultTranslation, defaultLocale),
      });

      const toRegister: Record<string, Record<string, string>> = {};
      if (t) toRegister[locale] = t.flat;
      if (defaultT) toRegister[defaultLocale] = defaultT.flat;

      store.register(ns, toRegister);

      if (t) loadedLocales.add(locale);
      if (promise === defaultTranslation || defaultT)
        defaultTranslationLoaded = true;
      loaded = true;
    } catch {
      if (isDevMode()) {
        console.warn(
          `Failed to load translation for locale: ${locale} — locale switch skipped.`,
        );
      }
    } finally {
      // only switch on success — see registerNamespace's resolver for rationale
      if (loaded && locale !== untracked(store.locale))
        store.locale.set(locale);
    }
  };

  return Object.assign([injectT, resolver] as const, {
    injectNamespaceT: injectT,
    resolveNamespaceTranslation: resolver,
  });
}

@Injectable({
  providedIn: 'root',
})
export class UnsafeTKeyMap {
  readonly map = new Map<string, string>();
}

/**
 * Power-user escape hatch that returns a fully untyped translation function.
 * Intended for use alongside {@link injectAddTranslations} when translations
 * are added imperatively (e.g. from a remote API), or for cross-namespace
 * lookups where the typed API would be impractical.
 *
 * @example
 * ```ts
 * const t = injectUnsafeT();
 * t('any.namespace.key', { name: 'Alice', count: 3 });
 * const sig = t.asSignal('any.namespace.key', () => ({ name: name() }));
 * ```
 */
export function injectUnsafeT() {
  const store = inject(TranslationStore);
  const map = inject(UnsafeTKeyMap).map;
  const pin = createPinner(store);

  const fn = (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
    let k = map.get(key);

    if (k === undefined) {
      k = replaceWithDelim(key);
      map.set(key, k);
    }

    if (params === undefined) {
      const sig = store.buildSimpleKeySignal(k);
      pin?.(sig);
      return sig();
    }

    const { signal, container } = store.buildParamKeySignal(k, params);
    pin?.(signal, container);
    return signal();
  };

  fn.asSignal = (
    key: string,
    params?: () => Record<string, string | number>,
  ): Signal<string> => {
    let k = map.get(key);

    if (k === undefined) {
      k = replaceWithDelim(key);
      map.set(key, k);
    }

    if (!params) {
      const sig = store.buildSimpleKeySignal(k);
      pin?.(sig);
      return sig;
    }

    const paramsSignal = isSignal(params)
      ? params
      : computed(() => params(), {
          equal: createEqualsRecord(Object.keys(params())),
        });

    return computed(() => {
      const vars = paramsSignal();
      const { signal, container } = store.buildParamKeySignal(k, vars);
      pin?.(signal, container);
      return signal();
    });
  };

  return fn;
}
