import {
  computed,
  inject,
  isDevMode,
  isSignal,
  LOCALE_ID,
  Signal,
} from '@angular/core';
import { keys } from '@mmstack/object';
import {
  inferCompiledTranslationContent,
  inferCompiledTranslationShape,
} from './create-namespace';
import { KEY_DELIM } from './flatten';
import { INTERNAL_SYMBOL } from './internal-symbol';
import { injectDefaultLocale, TranslationStore } from './translation.store';
import {
  CompiledTranslation,
  SignalTFunction,
  TAllFunction,
  TFunction,
  TranslationMap,
  UnknownStringKeyObject,
} from './types';

type TypedTAllFunction<T extends CompiledTranslation<UnknownStringKeyObject>> =
  TAllFunction<T> & {
    [INTERNAL_SYMBOL]: {
      content: inferCompiledTranslationContent<T>;
      map: TranslationMap<inferCompiledTranslationContent<T>>;
    };
  };

type TFunctionWithSignalConstructor<T extends UnknownStringKeyObject> =
  TFunction<T> & {
    asSignal: SignalTFunction<T>;
  };

export function injectAllT<
  T extends CompiledTranslation<UnknownStringKeyObject>,
>() {
  type $Map = TranslationMap<inferCompiledTranslationContent<T>>;

  const store = inject(TranslationStore);

  const fn: TAllFunction<T> = <K extends keyof $Map>(
    ns: T['namespace'],
    key: K,
    ...args: $Map[K] extends [string, infer Vars] ? [variables: Vars] : []
  ): string => {
    const variables = args[0] as Record<string, any> | undefined;
    const stringKey = key as string;

    const flatPath = stringKey.replaceAll('.', KEY_DELIM);

    return store.formatMessage(`${ns}${KEY_DELIM}${flatPath}`, variables);
  };

  return fn as TypedTAllFunction<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createEqualsRecord<T extends Record<string, any>>(
  keys: (keyof T)[] = [],
) {
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

export function registerNamespace<
  TDefault extends CompiledTranslation<UnknownStringKeyObject>,
  TOther extends CompiledTranslation<
    inferCompiledTranslationShape<TDefault>,
    string
  >,
>(def: TDefault, other: Record<string, () => Promise<TOther>>) {
  type $Content = inferCompiledTranslationContent<TDefault>;
  type $Map = TranslationMap<$Content>;

  const ns = def.namespace;

  const injectT = (): TFunctionWithSignalConstructor<$Content> => {
    const store = inject(TranslationStore);

    const translate = (<K extends keyof $Map>(
      key: K,
      ...args: $Map[K] extends [string, infer Vars] ? [variables: Vars] : []
    ): string => {
      const variables = args[0] as Record<string, any> | undefined;
      const stringKey = key as string;

      const flatPath = stringKey.replaceAll('.', KEY_DELIM);

      return store.formatMessage(`${ns}${KEY_DELIM}${flatPath}`, variables);
    }) as TFunctionWithSignalConstructor<$Content>;

    translate.asSignal = <K extends keyof $Map>(
      key: K,
      ...args: $Map[K] extends [string, infer Vars]
        ? [variables: () => Vars]
        : []
    ): Signal<string> => {
      const variables = args[0] as () => Record<string, any> | undefined;
      const stringKey = key as string;

      const flatPath = stringKey.replaceAll('.', KEY_DELIM);

      const varsFn = variables === undefined ? () => undefined : variables;
      const varsSignal = isSignal(varsFn)
        ? varsFn
        : computed(varsFn, {
            equal: createEqualsRecord(keys(varsFn() as object)),
          });

      return computed(() => store.formatMessage(flatPath, varsSignal()));
    };

    return translate;
  };

  const resolver = async () => {
    const locale = inject(LOCALE_ID);
    const store = inject(TranslationStore);

    store.register(ns, {
      [injectDefaultLocale()]: def.flat,
    });

    if (locale === injectDefaultLocale()) return;

    const promise = other[locale] as () => Promise<TOther>;

    if (!promise && isDevMode()) {
      return console.warn(`No translation found for locale: ${locale}`);
    }

    try {
      const translation = await promise();

      if (translation.locale !== locale && isDevMode()) {
        return console.warn(
          `Expected locale to be ${locale} but got ${translation.locale}`,
        );
      }

      store.register(ns, {
        [locale]: translation.flat,
      });
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
