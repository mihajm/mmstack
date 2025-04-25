import { inject } from '@angular/core';
import { CompiledTranslation, inferCompiledTranslationMap } from './compile';
import { createT } from './register-namespace';
import { UnknownStringKeyObject } from './string-key-object.type';
import { TranslationStore } from './translation.store';

export abstract class BaseTranslatePipe<
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T> = inferCompiledTranslationMap<T>,
> {
  private readonly t = createT<TMap>(inject(TranslationStore));

  transform<K extends keyof TMap & string>(
    key: K,
    ...args: TMap[K] extends void ? [] : [TMap[K]]
  ): string {
    return this.t(key, ...args);
  }
}
