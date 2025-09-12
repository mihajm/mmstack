import { Component } from '@angular/core';
import { MatOption } from '@angular/material/autocomplete';
import {
  createSelectState,
  SelectFieldComponent,
  SelectOptionContent,
} from '@mmstack/form-material';

@Component({
  selector: 'app-root',
  imports: [SelectFieldComponent, MatOption, SelectOptionContent],
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
