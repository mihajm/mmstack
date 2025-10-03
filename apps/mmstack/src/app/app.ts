import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { createSelectState } from '@mmstack/form-material';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: ` <router-outlet /> `,
  styles: ``,
})
export class App {
  readonly demo = createSelectState(0, {
    options: () => [0, 1, 2, 3],
  });
}
