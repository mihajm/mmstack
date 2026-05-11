import { type Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./playground').then((m) => m.Playground),
  },
  {
    path: 'list',
    loadComponent: () => import('./list/list').then((m) => m.List),
  },
  {
    path: 'kanban',
    loadComponent: () => import('./kanban/kanban').then((m) => m.Kanban),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
