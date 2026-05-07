import {
  computed,
  inject,
  isDevMode,
  isSignal,
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
import { injectResolveParamLocale } from './resovler-locale';
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

export function registerNamespace<
  TDefault extends CompiledTranslation<UnknownStringKeyObject, string>,
>(
  defaultTranslation: () => Promise<TDefault>,
  other: Record<
    string,
    () => Promise<
      CompiledTranslation<
        UnknownStringKeyObject,
        inferCompiledTranslationNamespace<TDefault>,
        string
      >
    >
  >,
) {
  type $Map = inferCompiledTranslationMap<TDefault>;
  type $BaseTFN = TFunction<$Map>;
  type $TFN = TFunctionWithSignalConstructor<$Map, $BaseTFN>;

  const keyMap = new Map<string, string>();

  const injectT = (): $TFN => {
    const store = inject(TranslationStore);

    return addSignalFn(createT(store, keyMap), store, keyMap);
  };

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

      const fullfilled = translations.map((t) =>
        t.status === 'fulfilled' ? t.value : null,
      );

      if (fullfilled.at(0) === null && fullfilled.at(1) === null)
        throw new Error('Failed to load translations');

      const [t, defaultT] = fullfilled;

      const ns = t?.namespace ?? defaultT?.namespace;
      if (!ns) throw new Error('No namespace found in translation');

      if (isDevMode() && t && t.locale !== locale && t.locale)
        console.warn(`Expected locale to be ${locale} but got ${t.locale}`);

      store.registerOnDemandLoaders(ns, {
        ...other,
        [defaultLocale]: defaultTranslation,
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

  const injectT = (): UntypedTFunction<TNS> => {
    const store = inject(TranslationStore);

    return addSignalFn(
      createT(store, keyMap),
      store,
      keyMap,
    ) as UntypedTFunction<TNS>;
  };

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

      const fullfilled = translations.map((t) =>
        t.status === 'fulfilled' ? t.value : null,
      );

      if (fullfilled.at(0) === null && fullfilled.at(1) === null)
        throw new Error('Failed to load translations');

      const [baseT, baseDefaultT] = fullfilled;

      const t = baseT ? compileTranslation(baseT, ns, locale) : null;
      const defaultT = baseDefaultT
        ? compileTranslation(baseDefaultT, ns, defaultLocale)
        : null;

      if (isDevMode() && t && t.locale !== locale && t.locale)
        console.warn(`Expected locale to be ${locale} but got ${t.locale}`);

      store.registerOnDemandLoaders(ns, {
        ...other,
        [defaultLocale]: defaultTranslation,
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
