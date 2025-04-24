import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  injectCreateStringState,
  StringFieldComponent,
} from '@mmstack/form-material';
import { registered } from './app.routes';

@Component({
  selector: 'app-forms-playground',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StringFieldComponent],
  template: `{{ greeting }}<mm-string-field [state]="state" />`,
})
export class FormsPlaygroundComponent {
  readonly state = injectCreateStringState()('', {
    validation: () => ({
      pattern: '^dynamic\.',
      notOneOf: ['yay', 'test', 'lol'],
    }),
  });
  readonly t = registered.injectNamespaceT();

  readonly greeting = this.t('test');
}
