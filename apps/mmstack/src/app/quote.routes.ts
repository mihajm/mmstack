import { Component } from '@angular/core';
import { RouterOutlet, Routes } from '@angular/router';
import { IdentifiedComponent } from './identified.component';

@Component({
  selector: 'app-quote-shell',
  imports: [RouterOutlet],
  template: `
    <h1>Quote Feature Shell</h1>
    <router-outlet></router-outlet>
  `,
})
export class QuoteShellComponent {}

export const routes: Routes = [
  {
    path: '',
    component: QuoteShellComponent,
    children: [
      {
        path: 'child',
        loadComponent: () =>
          import('./quote-child.component').then((c) => c.QuoteChildrComponent),
      },
      {
        path: ':id',
        component: IdentifiedComponent,
      },
    ],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
