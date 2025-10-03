import { Directive, Pipe } from '@angular/core';
import { Translate, Translator } from '@mmstack/translate';
import { TestLocale } from './test.namespace';

@Pipe({
  name: 'translate',
})
export class TestTranslator extends Translator<TestLocale> {}

@Directive({
  selector: '[translate]',
})
export class TestTranslate<TInput extends string> extends Translate<
  TInput,
  TestLocale
> {}
