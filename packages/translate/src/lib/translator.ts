import { ChangeDetectorRef, effect, inject } from '@angular/core';
import { CompiledTranslation, inferCompiledTranslationMap } from './compile';
import { createT } from './register-namespace';
import { UnknownStringKeyObject } from './string-key-object.type';
import { TranslationStore } from './translation-store';

export abstract class Translator<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T> = inferCompiledTranslationMap<T>,
> {
  private readonly store = inject(TranslationStore);
  private readonly t = createT<TMap>(this.store);

  constructor() {
    const cdr = inject(ChangeDetectorRef);

    effect(() => {
      this.store.locale();
      cdr.markForCheck();
    });
  }

  transform<K extends keyof TMap & string>(
    key: K,
    ...args: TMap[K] extends void
      ? [locale?: string]
      : [TMap[K], locale?: string]
  ): string {
    const actualArgs = args.filter(
      (a) => typeof a === 'object',
    ) as TMap[K] extends void ? [] : [TMap[K]];

    return this.t(key, ...actualArgs);
  }
}
