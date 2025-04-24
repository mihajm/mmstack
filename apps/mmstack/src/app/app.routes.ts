import { Route } from '@angular/router';
import { createNamespace, register } from '@mmstack/translate';
import { FormsPlaygroundComponent } from './forms.component';
import { TablePlaygroundComponent } from './table.component';

const ns = createNamespace('app', {
  test: 'test case',
  greeting: 'Hello {name}',
  pluralTest:
    'There {count, plural, one {is # item} =2 {two test} other {are # items}}',
  selection:
    'Variable, {varName, select, first{First option} other{Other option}}',
  selectOrdinal: 'Variable, {varName, selectordinal, one{First} other{Other}}',
} as const);

export const registered = register(ns.translation, {});

export const appRoutes: Route[] = [
  {
    path: 'forms',
    component: FormsPlaygroundComponent,
    resolve: {
      t: registered.resolveNamespaceTranslation,
    },
  },
  {
    path: 'table',
    component: TablePlaygroundComponent,
  },
];
