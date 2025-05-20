import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  injectCreateStringState,
  StringFieldComponent,
} from '@mmstack/form-material';
import { injectT } from './t/r';

@Component({
  selector: 'app-forms-playground',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StringFieldComponent],
  template: `hre{{ test() }}`,
})
export class FormsPlaygroundComponent {
  readonly state = injectCreateStringState()('', {
    validation: () => ({
      pattern: '^dynamic.',
      notOneOf: ['yay', 'test', 'lol'],
    }),
  });
  readonly t = injectT();

  test = this.t.asSignal('app.yay');
}
