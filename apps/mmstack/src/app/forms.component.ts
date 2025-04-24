import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  injectCreateStringState,
  StringFieldComponent,
} from '@mmstack/form-material';

@Component({
  selector: 'app-forms-playground',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StringFieldComponent],
  template: `<mm-string-field [state]="state" />`,
})
export class FormsPlaygroundComponent {
  readonly state = injectCreateStringState()('', {
    validation: () => ({
      pattern: '^dynamic.',
      notOneOf: ['yay', 'test', 'lol'],
    }),
  });
}
