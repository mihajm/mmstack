import { PipeTransform } from '@angular/core';

import { InternalSymbol } from './internal-symbol';
import { injectAllT } from './register-namespace';
import { CompiledTranslation, UnknownStringKeyObject } from './types';

export abstract class BaseTranslatePipe<
  T extends CompiledTranslation<UnknownStringKeyObject>,
> implements PipeTransform
{
  private readonly t = injectAllT<T>();
  abstract readonly namespace: T['namespace'];

  transform<K extends keyof (typeof this.t)[InternalSymbol]['content']>(
    value: K,
    ...args: (typeof this.t)[InternalSymbol]['map'][K] extends [
      string,
      infer Vars,
    ]
      ? [variables: Vars]
      : []
  ): string {
    return this.t(this.namespace, value, ...args);
  }
}
