import { Component } from '@angular/core';
import {
  createSelectState,
  SelectField,
  SelectOptionContent,
} from '@mmstack/form-material';

@Component({
  selector: 'app-root',
  imports: [SelectField, SelectOptionContent],
  template: `
    <mm-select-field [state]="demo">
      <div *mmSelectOptionContent="let opt">{{ opt.label() }} zaz</div>
    </mm-select-field>
  `,
  styles: ``,
})
export class App {
  readonly demo = createSelectState(0, {
    options: () => [0, 1, 2, 3],
  });
}
