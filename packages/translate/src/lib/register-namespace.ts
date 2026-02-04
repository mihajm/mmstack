import {
  computed,
  inject,
  isDevMode,
  isSignal,
  type Signal,
  untracked,
} from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  ResolveFn,
  Router,
} from '@angular/router';
import {
  type CompiledTranslation,
  type inferCompiledTranslationMap,
  type inferCompiledTranslationNamespace,
} from './compile';
import { replaceWithDelim } from './delim';
import { type UnknownStringKeyObject } from './string-key-object.type';
import {
  injectDefaultLocale,
  injectIntlConfig,
  TranslationStore,
} from './translation-store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStringRecord = Record<string, any>;

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

function addSignalFn<TMap extends AnyStringRecord, TFn extends TFunction<TMap>>(
  fn: TFn,
  store: TranslationStore,
): TFunctionWithSignalConstructor<TMap, TFn> {
  const withSig = fn as TFunctionWithSignalConstructor<TMap, TFn>;

  const asSignal = <TKey extends keyof TMap & string>(
    key: TKey,
    ...args: TMap[TKey] extends void ? [] : [() => TMap[TKey]]
  ): Signal<string> => {
    const variables = args[0] as () => AnyStringRecord | undefined;
    const stringKey = key as string;

    const flatPath = replaceWithDelim(stringKey);

    const varsFn = variables ?? (() => undefined);
    const varsSignal = isSignal(varsFn)
      ? varsFn
      : computed(varsFn, {
          equal: createEqualsRecord(Object.keys(varsFn() ?? {})),
        });

    return computed(() => store.formatMessage(flatPath, varsSignal()));
  };

  withSig.asSignal = asSignal;

  return withSig;
}

export function createT<TMap extends AnyStringRecord>(
  store: TranslationStore,
): TFunction<TMap> {
  return <TKey extends keyof TMap & string>(
    key: TKey,
    ...args: TMap[TKey] extends void ? [] : [TMap[TKey]]
  ): string => {
    const variables = args[0] as AnyStringRecord | undefined;
    const stringKey = key as string;

    return store.formatMessage(replaceWithDelim(stringKey), variables);
  };
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

  const injectT = (): $TFN => {
    const store = inject(TranslationStore);

    return addSignalFn(createT(store), store);
  };

  let defaultTranslationLoaded = false;
  const resolver: ResolveFn<void> = async (snapshot) => {
    const store = inject(TranslationStore);

    let locale: string | null = null;

    const paramName = injectIntlConfig()?.localeParamName;

    const routerConfig = inject(Router)['options'];
    const alwaysInheritParams =
      typeof routerConfig === 'object' &&
      !!routerConfig &&
      routerConfig.paramsInheritanceStrategy === 'always';

    if (paramName) {
      locale = snapshot.paramMap.get(paramName);

      if (!locale && !alwaysInheritParams) {
        let currentRoute: ActivatedRouteSnapshot | null = snapshot;
        while (currentRoute && !locale) {
          locale = currentRoute.paramMap.get('locale');
          currentRoute = currentRoute.parent;
        }
      }
    }

    if (!locale) {
      locale = untracked(store.locale);
    }

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

      if (isDevMode() && t && t.locale !== locale && t.locale !== defaultLocale)
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
