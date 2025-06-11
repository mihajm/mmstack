import { computed } from '@angular/core';
import { Routes } from '@angular/router';
import { createBreadcrumb, createTitle } from '@mmstack/router-core';
import { HomeComponent } from './home.component';

export const routes: Routes = [
  {
    path: 'home',
    loadComponent: () =>
      import('./home.component').then((c) => c.HomeComponent),
    resolve: {
      breadcrumb: createBreadcrumb(() => ({
        label: computed(() => 'Home'),
      })),
    },
    title: 'Home',
  },
  {
    path: 'about',
    loadComponent: () =>
      import('./about.component').then((c) => c.AboutComponent),
    title: createTitle(() => 'About us'),
  },
  {
    path: 'quote',
    loadChildren: () => import('./quote.routes').then((m) => m.routes),
  },
  {
    path: 'posts',
    loadChildren: () => import('./post.routes').then((m) => m.POST_ROUTES),
  },
  {
    path: '',
    component: HomeComponent,
    pathMatch: 'full',
  },
];
