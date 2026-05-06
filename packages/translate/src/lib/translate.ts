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

function compareObjects(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => a[key] === b[key]);
}

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
    const inputs = computed(() => this.translate(), {
      equal: (a, b) => {
        if (a === b) return true;
        if (typeof a === 'string' || typeof b === 'string') return false;
        if (a[0] !== b[0]) return false;
        return compareObjects(
          a[1] as Record<string, string>,
          b[1] as Record<string, string>,
        );
      },
    });

    const translation = computed(() => {
      const inp = inputs();
      return typeof inp === 'string'
        ? this.t(inp)
        : this.t(inp[0], inp[1] as Record<string, string>);
    });

    const renderer = inject(Renderer2);
    const el = inject<ElementRef<HTMLElement>>(ElementRef);

    afterRenderEffect({
      write: () => {
        renderer.setProperty(el.nativeElement, 'textContent', translation());
      },
    });
  }
}
