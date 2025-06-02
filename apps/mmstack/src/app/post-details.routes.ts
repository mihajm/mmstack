import { Routes } from '@angular/router';

export const ROUTES: Routes = [
  {
    path: 'info',
    loadComponent: () =>
      import('./post.component').then((m) => m.PostComponent),
  },
];
