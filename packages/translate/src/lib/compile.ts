import { prependDelim } from './delim';
import type {
  inferTranslationParamMap,
  inferTranslationShape,
} from './parameterize.type';
import type { UnknownStringKeyObject } from './string-key-object.type';

const INTERNAL_SYMBOL = Symbol.for('mmstack-translate-internal');

type InternalSymbol = typeof INTERNAL_SYMBOL;

/**
 * A translation object after compilation — produced by {@link compileTranslation}
 * (or indirectly via {@link createNamespace}). Holds:
 * - `flat`: a flattened `{ 'key.nested.path': value }` record for fast lookup
 * - `namespace`: the namespace string the translation belongs to
 * - `locale`: optional locale identifier (e.g. `'en'`, `'de'`)
 * - an internal symbol entry carrying type-level shape and parameter-map info
 *   used by downstream helpers (e.g. {@link Translator}) for type-safe keys
 *
 * Most consumers don't construct or read this directly — use
 * {@link createNamespace} as the entry point.
 *
 * @typeParam T The (unflattened) shape of the translation source object.
 * @typeParam TNS The namespace string literal type.
 * @typeParam TLocale The locale string literal type (defaults to `string`).
 */
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

/**
 * Type helper that merges two `CompiledTranslation` parameter maps. Used by
 * {@link createNamespace}'s `createMergedNamespace` to compose two namespaces'
 * type-level key/parameter info into a single inferred map.
 *
 * @typeParam TMain The "primary" compiled translation whose shape is preserved.
 * @typeParam TOther A second compiled translation whose parameter map is merged in.
 */
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

/**
 * Extracts the namespace string literal type from a `CompiledTranslation`.
 *
 * @typeParam T The compiled translation.
 */
export type inferCompiledTranslationNamespace<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T['namespace'];

/**
 * Extracts the original (unflattened) translation shape type from a
 * `CompiledTranslation`. Useful when defining additional per-locale
 * translations that must match the original shape.
 *
 * @typeParam T The compiled translation.
 */
export type inferCompiledTranslationShape<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
> = T[InternalSymbol]['shape'];

/**
 * Extracts the type-level "namespaced key → parameters" map from a
 * `CompiledTranslation`. Consumed by translator types to enforce type-safe
 * keys and parameter arguments at call sites.
 *
 * @typeParam T The compiled translation.
 */
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

/**
 * Compiles a nested translation source object into a {@link CompiledTranslation}:
 * flattens nested keys into a single `{ 'a.b.c': value }` record while
 * preserving type-level shape and parameter information.
 *
 * Most consumers should use {@link createNamespace} instead — it wraps this
 * function and additionally provides per-locale and merged-namespace helpers.
 * Call `compileTranslation` directly only when you need the lower-level
 * `CompiledTranslation` shape without a namespace wrapper.
 *
 * @typeParam T The (unflattened) shape of the translation source.
 * @typeParam TNS The namespace string literal type.
 * @typeParam TLocale The locale string literal type (defaults to `string`).
 * @param translation The nested translation object (string leaves, nested objects).
 * @param ns The namespace this translation belongs to.
 * @param locale Optional locale identifier (e.g. `'en-US'`).
 * @returns A `CompiledTranslation` ready to be registered or consumed.
 *
 * @example
 * ```ts
 * const compiled = compileTranslation(
 *   {
 *     greeting: 'Hello {name}!',
 *     nav: { home: 'Home', settings: 'Settings' },
 *   },
 *   'app',
 *   'en',
 * );
 *
 * compiled.flat;      // { greeting: 'Hello {name}!', 'nav.home': 'Home', 'nav.settings': 'Settings' }
 * compiled.namespace; // 'app'
 * compiled.locale;    // 'en'
 * ```
 */
export function compileTranslation<
  T extends UnknownStringKeyObject,
  TNS extends string,
  TLocale extends string = string,
>(
  translation: T,
  ns: TNS,
  locale?: TLocale,
): CompiledTranslation<T, TNS, TLocale> {
  type $Shape = inferTranslationShape<T>;
  type $Map = inferTranslationParamMap<TNS, T>;

  return {
    locale,
    flat: flattenTranslation(translation),
    namespace: ns,
    [INTERNAL_SYMBOL]: {
      shape: {} as $Shape,
      map: {} as $Map,
    },
  };
}
