import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { stored } from '@mmstack/primitives';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, FormsModule],
  template: `
    <input type="number" [(ngModel)]="key" />
    <input type="text" [(ngModel)]="store" />
  `,
  styles: ``,
})
export class AppComponent {
  readonly key = signal(0);

  readonly store = stored('', {
    key: computed(() => this.key().toString()),
    serialize: (value: string) => value,
    deserialize: (value: string) => value,
    cleanupOldKey: true,
  });
}
