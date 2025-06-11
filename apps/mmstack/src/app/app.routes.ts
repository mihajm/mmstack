import { isPlatformBrowser } from '@angular/common';
import { computed, inject, PLATFORM_ID, signal } from '@angular/core';
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
    title: createTitle(() => {
      const sig = signal('about us');

      if (isPlatformBrowser(inject(PLATFORM_ID)))
        setTimeout(() => {
          console.log('hre');
          sig.set('yay');
        }, 1500);

      return sig;
    }),
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
