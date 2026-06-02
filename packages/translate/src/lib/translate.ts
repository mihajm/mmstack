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

/**
 * Abstract base directive that renders a translated string into the host
 * element's `textContent`. Consumers extend this directive once per namespace
 * to get a typed `translate` input whose keys and parameters are validated
 * against the namespace's compiled translation.
 *
 * The `translate` input accepts either a bare key (for keys with no
 * parameters) or a `[key, vars]` tuple (for keys with parameters).
 *
 * @typeParam TInput The set of keys the consumer wants to allow (often the
 *   full key set of the namespace, but can be narrowed).
 * @typeParam T The `CompiledTranslation` produced by {@link createNamespace}.
 * @typeParam TMap The inferred parameter map (rarely overridden).
 * @typeParam TKey The intersection of `TInput` and the namespace's keys.
 *
 * @example
 * ```ts
 * // 1. Define a namespace-specific directive once
 * @Directive({
 *   selector: '[appTranslate]',
 *   inputs: [{ name: 'appTranslate', alias: 'translate' }],
 * })
 * export class AppTranslateDirective extends Translate<
 *   keyof inferCompiledTranslationMap<typeof app.translation> & string,
 *   typeof app.translation
 * > {}
 *
 * // 2. Use in templates
 * // <span [appTranslate]="'app.nav.home'"></span>
 * // <span [appTranslate]="['app.greeting', { name: userName() }]"></span>
 * ```
 */
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
