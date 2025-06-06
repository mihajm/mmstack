import { Component } from '@angular/core';
import {
  ChipsFieldComponent,
  injectCreateChipsState,
} from '@mmstack/form-material';

@Component({
  selector: 'app-root',
  imports: [ChipsFieldComponent],
  template: ` <mm-chips-field [state]="state" /> `,
  styles: ``,
})
export class AppComponent {
  readonly state = injectCreateChipsState()([], {
    options: () => ['yay', 'test'],
    label: () => 'Test',
  });
}
