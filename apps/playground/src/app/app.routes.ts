import { type Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./playground').then((m) => m.Playground),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
