import { Injectable, LOCALE_ID } from '@angular/core';
import { ActivatedRouteSnapshot, Routes } from '@angular/router';

import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-locale-shell',

  imports: [RouterOutlet],
  template: `shell: {{ locale }} <router-outlet />`,
})
export class LocaleShellComponent {
  protected readonly locale = inject(LOCALE_ID);
}

@Injectable({
  providedIn: 'root',
})
export class LocaleStore {
  locale = 'en-US';
}

export const routes: Routes = [
  {
    path: ':locale',
    component: LocaleShellComponent,
    resolve: {
      localeId: (route: ActivatedRouteSnapshot) => {
        inject(LocaleStore).locale = route.params['locale'] || 'en-US';
      },
    },
    providers: [
      {
        provide: LOCALE_ID,
        useFactory: (store: LocaleStore) => {
          return store.locale;
        },
        deps: [LocaleStore],
      },
    ],
    loadChildren: () => import('./quote.routes').then((m) => m.QUOTE_ROUTES),
  },
  {
    path: '',
    redirectTo: 'en-US',
    pathMatch: 'full',
  },
];
