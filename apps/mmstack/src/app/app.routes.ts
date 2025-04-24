import { Route } from '@angular/router';
import { FormsPlaygroundComponent } from './forms.component';
import { TablePlaygroundComponent } from './table.component';

export const appRoutes: Route[] = [
  {
    path: 'forms',
    component: FormsPlaygroundComponent,
  },
  {
    path: 'table',
    component: TablePlaygroundComponent,
  },
];
