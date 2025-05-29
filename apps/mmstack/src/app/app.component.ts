import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  providers: [],
  template: ` <router-outlet />`,
  styles: ``,
})
export class AppComponent {}
