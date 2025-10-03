import {
  computed,
  inject,
  isDevMode,
  isSignal,
  Signal,
  untracked,
} from '@angular/core';
import { CompiledTranslation, inferCompiledTranslationMap } from './compile';
import { replaceWithDelim } from './delim';
import { UnknownStringKeyObject } from './string-key-object.type';
import { TranslationStore } from './translation-store';

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
  TOther extends CompiledTranslation<UnknownStringKeyObject, string>,
>(
  defaultTranslation: () => Promise<TDefault>,
  other: Record<string, () => Promise<TOther>>,
) {
  type $Map = inferCompiledTranslationMap<TDefault>;
  type $BaseTFN = TFunction<$Map>;
  type $TFN = TFunctionWithSignalConstructor<$Map, $BaseTFN>;

  const injectT = (): $TFN => {
    const store = inject(TranslationStore);

    return addSignalFn(createT(store), store);
  };

  let defaultTranslationLoaded = false;
  const resolver = async () => {
    const store = inject(TranslationStore);
    const locale = untracked(store.locale);
    const tPromise = other[locale] as (() => Promise<TOther>) | undefined;

    const promise = tPromise ?? defaultTranslation;
    if (!promise && isDevMode()) {
      return console.warn(`No translation found for locale: ${locale}`);
    }

    if (promise === defaultTranslation && defaultTranslationLoaded) return;

    try {
      const translation = await promise();

      if (
        promise !== defaultTranslation &&
        translation.locale !== locale &&
        isDevMode()
      ) {
        return console.warn(
          `Expected locale to be ${locale} but got ${translation.locale}`,
        );
      }

      store.registerOnDemandLoaders(translation.namespace, other);

      store.register(translation.namespace, {
        [locale]: translation.flat,
      });
      if (promise === defaultTranslation) {
        defaultTranslationLoaded = true;
      }
    } catch {
      if (isDevMode()) {
        console.warn(`Failed to load translation for locale: ${locale}`);
      }
    }
  };

  return {
    injectNamespaceT: injectT,
    resolveNamespaceTranslation: resolver,
  };
}
