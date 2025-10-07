import { ChangeDetectionStrategy, Component } from '@angular/core';
import { injectDynamicLocale } from '@mmstack/translate';
import { TestTranslate, TestTranslator } from './locale/test.directive';
import { injectTestT } from './locale/test.register';

@Component({
  selector: 'app-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TestTranslate, TestTranslator],
  template: `
    <div>Signal: {{ demo() }}</div>
    <div>Pipe: {{ 'test.name' | translate: { name: 'yay' } : dynamic() }}</div>
    <div translate="test.hello">Hello</div>
    <button (click)="switchToSlovenian()">Switch to Slovenian</button>
    <button (click)="switchToEnglish()">Switch to English</button>
    {{ dynamic() }}
  `,
})
export class DemoComponent {
  protected readonly demo = injectTestT().asSignal('test.hello');
  protected readonly dynamic = injectDynamicLocale();

  protected switchToSlovenian() {
    this.dynamic.set('sl-SI');
  }

  protected switchToEnglish() {
    this.dynamic.set('en-US');
  }
}
