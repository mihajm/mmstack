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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _?: string, // maybeLocale
  ): string => {
    const vars =
      typeof variablesOrLocale === 'string' ? undefined : variablesOrLocale;

    return (t as (key: TKey, vars?: AnyStringRecord) => string)(key, vars);
  };

  return fn as unknown as TransformTFn<T, TMap>;
}

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
