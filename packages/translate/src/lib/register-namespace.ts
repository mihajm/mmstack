import {
  computed,
  inject,
  Injectable,
  isDevMode,
  isSignal,
  untracked,
  type Signal,
} from '@angular/core';
import { ResolveFn } from '@angular/router';
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

export function addSignalFn<
  TMap extends AnyStringRecord,
  TFn extends TFunction<TMap>,
>(
  fn: TFn,
  store: TranslationStore,
  keyMap: Map<string, string>,
): TFunctionWithSignalConstructor<TMap, TFn> {
  const withSig = fn as TFunctionWithSignalConstructor<TMap, TFn>;

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

    if (variables === undefined) return store.buildSimpleKeySignal(flatPath);

    const varsFn = variables;
    const varsSignal = isSignal(varsFn)
      ? varsFn
      : computed(() => varsFn(), {
          equal: createEqualsRecord(Object.keys(varsFn())),
        });

    return computed(() => store.formatMessage(flatPath, varsSignal()));
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

    return store.formatMessage(k, variables);
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

  // Pre-wrap loaders once so the rest of the pipeline — including the
  // dynamic-locale loader in `TranslationStore`, which reads `.namespace`
  // and `.flat` directly off the result — always sees a `CompiledTranslation`
  // regardless of which loader shape the caller used.
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

  // Tracks whether the default locale's translation has been loaded by any prior
  // resolver call. Captured in closure across navigations on purpose — concurrent
  // resolves may each see `false` and both queue a default preload; that's harmless
  // because `store.register` is idempotent (same payload overwrites with the same
  // value). Do not add locking here.
  let defaultTranslationLoaded = false;
  const resolver: ResolveFn<void> = async (snapshot) => {
    const store = inject(TranslationStore);

    const locale = injectResolveParamLocale(snapshot);

    const defaultLocale = injectDefaultLocale();
    const shouldPreloadDefault =
      injectIntlConfig()?.preloadDefaultLocale ?? false;

    const tPromise = unwrappedOther[locale] as LocaleLoader | undefined;

    const promise = tPromise ?? unwrappedDefault;
    if (!promise && isDevMode()) {
      return console.warn(`No translation found for locale: ${locale}`);
    }

    if (promise === unwrappedDefault && defaultTranslationLoaded) return;

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

      if (promise === unwrappedDefault || defaultT)
        defaultTranslationLoaded = true;
    } catch {
      if (isDevMode()) {
        console.warn(`Failed to load translation for locale: ${locale}`);
      }
    } finally {
      if (locale !== untracked(store.locale)) store.locale.set(locale);
    }
  };

  return {
    injectNamespaceT: injectT,
    resolveNamespaceTranslation: resolver,
  };
}

type UntypedTFunction<TNS extends string> = {
  (key: `${TNS}.${string}`, args?: Record<string, string>): string;
  asSignal: (
    key: `${TNS}.${string}`,
    args?: () => Record<string, string>,
  ) => Signal<string>;
};

/**
 * Registers a type-unsafe namespace, meant for remote loading of unknown key-value pairs using mmstack/translate infrastructure
 * The resolver & t function work the same as they would with typed namespaces, but without type safety
 */
export function registerRemoteNamespace<TNS extends string>(
  ns: TNS,
  defaultTranslation: () => Promise<Record<string, string>>,
  other: Record<string, () => Promise<Record<string, string>>>,
) {
  const keyMap = new Map<string, string>();

  // The dynamic-locale loader in TranslationStore reads `.namespace` and `.flat`
  // off the loader result, so on-demand loaders must return CompiledTranslation.
  // Wrap the raw remote fetchers once here at registration time rather than every
  // resolver call.
  const compileLoader =
    <TLocale extends string>(
      loader: () => Promise<Record<string, string>>,
      locale: TLocale,
    ) =>
    () => loader().then((raw) => compileTranslation(raw, ns, locale));

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

  // See `defaultTranslationLoaded` in `registerNamespace` for rationale —
  // intentionally racy, safe via idempotent `store.register`.
  let defaultTranslationLoaded = false;
  const resolver: ResolveFn<void> = async (snapshot) => {
    const store = inject(TranslationStore);

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

    try {
      const promises = [promise()];

      if (
        shouldPreloadDefault &&
        !defaultTranslationLoaded &&
        promise !== defaultTranslation
      )
        promises.push(defaultTranslation());

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

      if (promise === defaultTranslation || defaultT)
        defaultTranslationLoaded = true;
    } catch {
      if (isDevMode()) {
        console.warn(`Failed to load translation for locale: ${locale}`);
      }
    } finally {
      if (locale !== untracked(store.locale)) store.locale.set(locale);
    }
  };

  return {
    injectNamespaceT: injectT,
    resolveNamespaceTranslation: resolver,
  };
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

  const fn = (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
    let k = map.get(key);

    if (k === undefined) {
      k = replaceWithDelim(key);
      map.set(key, k);
    }

    return store.formatMessage(k, params);
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

    if (!params) return store.buildSimpleKeySignal(k);

    const paramsSignal = isSignal(params)
      ? params
      : computed(() => params(), {
          equal: createEqualsRecord(Object.keys(params())),
        });

    return computed(() => store.formatMessage(k, paramsSignal()));
  };

  return fn;
}
