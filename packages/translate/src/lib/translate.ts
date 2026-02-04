import {
  afterRenderEffect,
  computed,
  Directive,
  ElementRef,
  inject,
  input,
  Renderer2,
} from '@angular/core';
import {
  type CompiledTranslation,
  type inferCompiledTranslationMap,
} from './compile';
import { createT } from './register-namespace';
import { type UnknownStringKeyObject } from './string-key-object.type';
import { TranslationStore } from './translation-store';

@Directive()
export abstract class Translate<
  TInput extends string,
  T extends CompiledTranslation<UnknownStringKeyObject, string>,
  TMap extends inferCompiledTranslationMap<T> = inferCompiledTranslationMap<T>,
  TKey extends TInput & keyof TMap & string = TInput & keyof TMap & string,
> {
  private readonly t = createT(inject(TranslationStore));

  readonly translate =
    input.required<
      TMap[TKey] extends void
        ? TKey | [key: TKey]
        : [key: TKey, vars: TMap[TKey]]
    >();

  constructor() {
    const key = computed(() => {
      const vars = this.translate();
      return (Array.isArray(vars) ? vars[0] : vars) as TKey;
    });

    const args = computed(
      () => {
        const vars = this.translate();
        return (Array.isArray(vars) ? vars[1] : undefined) as TMap[TKey];
      },
      {
        equal: (a, b) => {
          if (a === undefined && b === undefined) return true;
          if (a === undefined || b === undefined) return false;

          const aObj = a as Record<string, string>;
          const keys = Object.keys(aObj);
          const bObj = b as Record<string, string>;

          if (!keys.length) return !Object.keys(bObj).length;

          return keys.every((key) => aObj[key] === bObj[key]);
        },
      },
    );

    const translation = computed(() => this.t(key(), args()));

    const renderer = inject(Renderer2);
    const el = inject<ElementRef<HTMLElement>>(ElementRef);

    afterRenderEffect({
      write: () => {
        renderer.setProperty(el.nativeElement, 'textContent', translation());
      },
    });
  }
}
