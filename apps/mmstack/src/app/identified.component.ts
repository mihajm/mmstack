import { Component, input } from '@angular/core';

@Component({
  selector: 'app-quote-child',
  template: `id component {{ id() }}`,
})
export class IdentifiedComponent {
  readonly id = input<string>('');
}
