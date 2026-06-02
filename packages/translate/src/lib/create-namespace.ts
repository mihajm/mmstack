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
    const TOther extends UnknownStringKeyObject,
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

/**
 * Creates a translation namespace from the default-locale source object. The
 * returned namespace holds the compiled default translation plus helpers for:
 *
 * - `createTranslation(locale, translation)` — produces a `CompiledTranslation`
 *   for an additional locale, type-checked to match the default's shape.
 * - `createMergedNamespace(otherNs, otherTranslation)` — composes another
 *   namespace on top of this one, merging their type-level parameter maps so
 *   translator helpers see the full union of keys.
 *
 * This is the primary entry point for defining translations — prefer it over
 * calling {@link compileTranslation} directly.
 *
 * @typeParam T The (unflattened) shape of the default translation source.
 * @typeParam TNS The namespace string literal type.
 * @param ns The namespace identifier (e.g. `'app'`, `'auth'`, `'checkout'`).
 * @param translation The default-locale translation object.
 * @returns A namespace object exposing `translation`, `createTranslation`, and `createMergedNamespace`.
 *
 * @example
 * ```ts
 * // 1. Define the default-locale namespace
 * const app = createNamespace('app', {
 *   greeting: 'Hello {name}!',
 *   nav: { home: 'Home', settings: 'Settings' },
 * });
 *
 * // 2. Add per-locale translations (shape is enforced)
 * const appDE = app.createTranslation('de', {
 *   greeting: 'Hallo {name}!',
 *   nav: { home: 'Startseite', settings: 'Einstellungen' },
 * });
 *
 * // 3. Compose with another namespace
 * const auth = app.createMergedNamespace('auth', {
 *   loginPrompt: 'Sign in to continue',
 * });
 * ```
 */
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
