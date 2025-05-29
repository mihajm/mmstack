import { Component, signal } from '@angular/core';
import { LinkDirective } from '@mmstack/preload';

@Component({
  selector: 'app-home',
  imports: [LinkDirective],
  template: `home component
    <a [mmLink]="['/about']" preloadOn="hover">About</a>
    @if (visible()) {
      <a [mmLink]="['/quote/other']" preloadOn="visible">Quote</a>
    }
    <button (click)="visible.set(!visible())">Toggle Quote Link</button> `,
})
export class HomeComponent {
  visible = signal(false);
}
