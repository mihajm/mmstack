import { Component, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { debounced } from '@mmstack/primitives';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, FormsModule],
  template: ` <input [(ngModel)]="test" placeholder="Type something..." /> `,
  styles: ``,
})
export class AppComponent {
  readonly test = debounced('', {
    ms: 300,
  });

  e = effect(() => console.log('Debounced Value:', this.test()));
}
