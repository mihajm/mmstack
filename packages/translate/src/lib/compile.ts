import { prependDelim } from './delim';
import { inferTranslationParamMap } from './parameterize.type';
import { UnknownStringKeyObject } from './string-key-object.type';

const INTERNAL_SYMBOL = Symbol.for('mmstack-translate-internal');

type InternalSymbol = typeof INTERNAL_SYMBOL;

type inferTranslationShape<T extends UnknownStringKeyObject> = {
  [K in keyof T]: T[K] extends UnknownStringKeyObject
    ? inferTranslationShape<T[K]>
    : string;
};

export type CompiledTranslation<
  T extends UnknownStringKeyObject,
  TNS extends string,
  TLocale extends string = string,
> = {
  flat: Record<string, string>;
  locale?: TLocale;
  namespace: TNS;
  [INTERNAL_SYMBOL]: {
    shape: inferTranslationShape<T>;
    map: inferTranslationParamMap<TNS, T>;
  };
};

export type mergeTranslationMaps<
  TMain extends CompiledTranslation<UnknownStringKeyObject, string>,
  TOther extends CompiledTranslation<UnknownStringKeyObject, string>,
> = Omit<TMain, InternalSymbol> & {
  [INTERNAL_SYMBOL]: {
    shape: inferCompiledTranslationShape<TMain>;
    map: inferCompiledTranslationMap<TOther> &
      inferCompiledTranslationMap<TMain>;
  };
};

export type inferCompiledTranslationNamespace<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T['namespace'];

export type inferCompiledTranslationShape<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T[InternalSymbol]['shape'];

export type inferCompiledTranslationMap<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T[InternalSymbol]['map'];

function isTranslationObject(t: unknown): t is UnknownStringKeyObject {
  return typeof t === 'object' && t !== null;
}

function flattenTranslation<T extends UnknownStringKeyObject>(obj: T) {
  return Object.entries(obj).reduce(
    (acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = value;
      } else if (isTranslationObject(value)) {
        Object.entries(flattenTranslation(value)).forEach(
          ([nestedKey, nestedValue]) => {
            acc[prependDelim(key, nestedKey)] = nestedValue;
          },
        );
      }

      return acc;
    },
    {} as Record<string, string>,
  );
}

export function compileTranslation<
  T extends UnknownStringKeyObject,
  TNS extends string,
  TLocale extends string = string,
>(
  translation: T,
  ns: TNS,
  locale?: TLocale,
): CompiledTranslation<T, TNS, TLocale> {
  return {
    locale,
    flat: flattenTranslation(translation),
    namespace: ns,
    [INTERNAL_SYMBOL]: {
      shape: {} as inferTranslationShape<T>,
      map: {} as inferTranslationParamMap<TNS, T>,
    },
  };
}
