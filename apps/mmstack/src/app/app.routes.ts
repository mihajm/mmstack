import { Routes } from '@angular/router';
import { resolveTestTranslation } from './locale/test.register';

export const routes: Routes = [
  {
    path: '',
    resolve: {
      resolveTestTranslation,
    },
    loadComponent: () =>
      import('./demo.component').then((m) => m.DemoComponent),
  },
];
