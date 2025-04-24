import { flattenTranslation } from './flatten';
import { INTERNAL_SYMBOL, InternalSymbol } from './internal-symbol';
import {
  CompiledTranslation,
  inferTranslationShape,
  UnknownStringKeyObject,
} from './types';

export type inferCompiledTranslationShape<
  T extends CompiledTranslation<UnknownStringKeyObject>,
> = T[InternalSymbol]['shape'];

export type inferCompiledTranslationContent<
  T extends CompiledTranslation<UnknownStringKeyObject>,
> = T[InternalSymbol]['translation'];

export function createNamespace<
  TNS extends string,
  T extends UnknownStringKeyObject,
>(ns: TNS, translation: T) {
  type $Shape = inferTranslationShape<T>;

  const createTranslation = <TLocale extends string>(
    locale: TLocale,
    translation: $Shape,
  ) => {
    return {
      locale,
      flat: flattenTranslation(translation),
      namespace: ns,
      [INTERNAL_SYMBOL]: {
        shape: {} as $Shape,
        translation: {} as T,
      },
    };
  };

  return {
    createTranslation,
    translation: {
      flat: flattenTranslation(translation),
      namespace: ns,
      [INTERNAL_SYMBOL]: {
        shape: {} as $Shape,
        translation: {} as T,
      },
    },
  } as const;
}
