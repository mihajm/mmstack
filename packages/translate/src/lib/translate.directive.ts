import {
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  Renderer2,
} from '@angular/core';
import { inferCompiledTranslationContent } from './create-namespace';
import { injectAllT } from './register-namespace';
import {
  CompiledTranslation,
  TranslationMap,
  UnknownStringKeyObject,
} from './types';

@Directive()
export abstract class BaseTranslateDirective<
  TInput extends string,
  T extends CompiledTranslation<UnknownStringKeyObject>,
  $Content extends
    inferCompiledTranslationContent<T> = inferCompiledTranslationContent<T>,
  $Map extends TranslationMap<$Content> = TranslationMap<$Content>,
  $Key extends keyof $Map & TInput = keyof $Map & TInput,
> {
  private readonly t = injectAllT<T>();
  abstract readonly namespace: T['namespace'];

  readonly translate =
    input.required<
      $Map[$Key] extends [string, infer Vars]
        ? [key: $Key, variables: Vars]
        : $Key | [key: $Key]
    >();

  private readonly anyT = this.t as unknown as (
    ns: T['namespace'],
    key: $Key,
    vars: $Map[$Key],
  ) => string;

  readonly translation = computed(() => {
    const input = this.translate();
    const key = (Array.isArray(input) ? input[0] : input) as $Key;
    const vars = (Array.isArray(input) ? input[1] : undefined) as $Map[$Key];

    return this.anyT(this.namespace, key, vars);
  });

  constructor() {
    const renderer = inject(Renderer2);
    const el = inject<ElementRef<HTMLElement>>(ElementRef);

    effect(() =>
      renderer.setProperty(el.nativeElement, 'textContent', this.translation()),
    );
  }
}
