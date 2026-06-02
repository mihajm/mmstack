import { ChangeDetectorRef, effect, inject } from '@angular/core';
import {
  type CompiledTranslation,
  type inferCompiledTranslationMap,
} from './compile';
import { createT } from './register-namespace';
import {
  type AnyStringRecord,
  type UnknownStringKeyObject,
} from './string-key-object.type';
import { TranslationStore } from './translation-store';

type TransformTFn<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T>,
> = <TKey extends keyof TMap & string>(
  key: TKey,
  ...args: TMap[TKey] extends void
    ? [locale?: string]
    : [TMap[TKey], locale?: string]
) => string;

function createTransformFn<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T>,
>(): TransformTFn<T, TMap> {
  const store = inject(TranslationStore);
  const t = createT<TMap>(store);

  const fn = <TKey extends keyof TMap & string>(
    key: TKey,
    variablesOrLocale?: string | AnyStringRecord,
    // The locale argument is unused at runtime — the active locale comes from
    // `TranslationStore`. It exists on the signature so consumers can pass
    // `locale()` as a pipe argument (`'key' | translate : vars : locale()`)
    // to bust Angular's pure-pipe memoization on locale changes.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _?: string,
  ): string => {
    const vars =
      typeof variablesOrLocale === 'string' ? undefined : variablesOrLocale;

    return (t as (key: TKey, vars?: AnyStringRecord) => string)(key, vars);
  };

  return fn as unknown as TransformTFn<T, TMap>;
}

/**
 * Abstract base class for building a per-namespace Angular pipe with a typed
 * `transform(key, vars?, locale?)` method. Extend once per namespace, decorate
 * with `@Pipe(...)`, and you get template-side translations whose keys and
 * parameters are validated against the namespace's compiled translation.
 *
 * The pipe registers a locale-tracking effect so that changing the active
 * locale marks the host component for change detection automatically. The
 * `locale` argument on `transform()` is runtime-unused — it exists so callers
 * can pass `| myPipe : vars : locale()` to bust Angular's pure-pipe
 * memoization on locale change.
 *
 * @typeParam T The `CompiledTranslation` produced by {@link createNamespace}.
 * @typeParam TMap The inferred parameter map (rarely overridden).
 *
 * @example
 * ```ts
 * // 1. Define a namespace-specific pipe once
 * @Pipe({ name: 'appT', pure: true })
 * export class AppTranslatorPipe extends Translator<typeof app.translation> {}
 *
 * // 2. Use in templates
 * // {{ 'app.nav.home' | appT }}
 * // {{ 'app.greeting' | appT : { name: userName() } }}
 * // Bust pure-pipe cache on locale change:
 * // {{ 'app.greeting' | appT : { name: userName() } : locale() }}
 * ```
 */
export abstract class Translator<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T> = inferCompiledTranslationMap<T>,
> {
  constructor() {
    const cdr = inject(ChangeDetectorRef);
    const locale = inject(TranslationStore).locale;

    effect(() => {
      locale();
      cdr.markForCheck();
    });
  }

  transform = createTransformFn<T, TMap>();
}
