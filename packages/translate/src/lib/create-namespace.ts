import {
  CompiledTranslation,
  compileTranslation,
  inferCompiledTranslationShape,
  mergeTranslationMaps,
} from './compile';
import { UnknownStringKeyObject } from './string-key-object.type';

type TranslationNamespace<
  TNS extends string,
  T extends CompiledTranslation<UnknownStringKeyObject, TNS>,
  TShape extends UnknownStringKeyObject,
> = {
  translation: T;
  createTranslation: <TLocale extends string>(
    locale: TLocale,
    translation: TShape,
  ) => CompiledTranslation<TShape, TNS, TLocale>;
  createMergedNamespace: <
    TOtherNS extends string,
    TOther extends UnknownStringKeyObject,
    TOtherCompiled extends CompiledTranslation<TOther, TOtherNS>,
  >(
    ns: TOtherNS,
    translation: TOther,
  ) => TranslationNamespace<
    TOtherNS,
    mergeTranslationMaps<TOtherCompiled, T>,
    inferCompiledTranslationShape<TOtherCompiled>
  >;
};

export function createNamespace<
  const T extends UnknownStringKeyObject,
  TNS extends string,
>(ns: TNS, translation: T) {
  const compiled = compileTranslation<T, TNS>(translation, ns);

  type TCompiled = typeof compiled;
  type TShape = inferCompiledTranslationShape<typeof compiled>;

  const namespace: TranslationNamespace<TNS, TCompiled, TShape> = {
    translation: compileTranslation(translation, ns),
    createTranslation: <TLocale extends string>(
      locale: TLocale,
      translation: TShape,
    ) => {
      return compileTranslation(translation, ns, locale);
    },
    createMergedNamespace: <
      TOther extends UnknownStringKeyObject,
      TOtherNS extends string,
      TOtherCompiled extends CompiledTranslation<
        TOther,
        TOtherNS
      > = CompiledTranslation<TOther, TOtherNS>,
    >(
      otherNs: TOtherNS,
      otherTranslation: TOther,
    ) => {
      return createNamespace(otherNs, otherTranslation) as TranslationNamespace<
        TOtherNS,
        mergeTranslationMaps<TOtherCompiled, TCompiled>,
        inferCompiledTranslationShape<TOtherCompiled>
      > as unknown as any;
    },
  };

  return namespace;
}
