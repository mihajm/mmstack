import { type Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: 'core',
    loadComponent: () =>
      import('./examples/core-example').then((m) => m.CoreExample),
  },
  {
    path: 'sortable',
    loadComponent: () =>
      import('./examples/sortable-example').then((m) => m.SortableExample),
  },
  {
    path: 'sortable-pointer',
    loadComponent: () =>
      import('./examples/pointer-sortable-example').then(
        (m) => m.PointerSortableExample,
      ),
  },
  {
    path: 'pointer-engine',
    loadComponent: () =>
      import('./examples/pointer-engine-example').then(
        (m) => m.PointerEngineExample,
      ),
  },
  {
    path: 'sortable-indicator',
    loadComponent: () =>
      import('./examples/sortable-indicator-example').then(
        (m) => m.SortableIndicatorExample,
      ),
  },
  {
    path: 'sortable-tree',
    loadComponent: () =>
      import('./examples/tree-sortable-example').then(
        (m) => m.TreeSortableExample,
      ),
  },
  {
    path: 'canvas',
    loadComponent: () =>
      import('./examples/canvas-example').then((m) => m.CanvasExample),
  },
  {
    path: 'grid',
    loadComponent: () =>
      import('./examples/grid-example').then((m) => m.GridExample),
  },
  {
    path: 'features',
    loadComponent: () =>
      import('./examples/features-example').then((m) => m.FeaturesExample),
  },
  {
    path: 'board',
    loadComponent: () =>
      import('./examples/board-example').then((m) => m.BoardExample),
  },
  { path: '', pathMatch: 'full', redirectTo: 'core' },
  { path: '**', redirectTo: 'core' },
];
