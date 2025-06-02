import { Component, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterOutlet } from '@angular/router';
import { injectBreadcrumbs } from '@mmstack/router-core';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, FormsModule, RouterLink],
  template: `
    @for (crumb of crumbs(); track crumb.id) {
      <a [routerLink]="crumb.link()">{{ crumb.label() }}</a> >
    }
    <router-outlet />
  `,
  styles: ``,
})
export class AppComponent {
  readonly crumbs = injectBreadcrumbs();

  constructor() {
    effect(() => console.log(this.crumbs()));
  }
}
