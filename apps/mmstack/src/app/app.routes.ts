import { Route } from '@angular/router';
import { FormsPlaygroundComponent } from './forms.component';
import { resolver } from './t/r';
import { TablePlaygroundComponent } from './table.component';

export const appRoutes: Route[] = [
  {
    path: 'forms',
    component: FormsPlaygroundComponent,
    resolve: {
      resolver,
    },
  },
  {
    path: 'table',
    component: TablePlaygroundComponent,
  },
];
