import { type Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: 'core',
    loadComponent: () =>
      import('./examples/core-example').then((m) => m.CoreExample),
  },
  {
    path: 'persistence',
    loadComponent: () =>
      import('./examples/persistence-example').then(
        (m) => m.PersistenceExample,
      ),
  },
  {
    path: 'persisted-store',
    loadComponent: () =>
      import('./examples/persisted-store-example').then(
        (m) => m.PersistedStoreExample,
      ),
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
  {
    path: 'worker',
    loadComponent: () =>
      import('./examples/worker-example').then((m) => m.WorkerExample),
  },
  {
    path: 'telemetry',
    loadComponent: () =>
      import('./examples/telemetry-example').then((m) => m.TelemetryExample),
  },
  {
    path: 'mesh',
    loadComponent: () =>
      import('./examples/mesh-example').then((m) => m.MeshExample),
  },
  {
    path: 'webrtc',
    loadComponent: () =>
      import('./examples/webrtc-example').then((m) => m.WebRtcExample),
  },
  {
    path: 'mesh-agent',
    loadComponent: () =>
      import('./examples/mesh-agent-example').then((m) => m.MeshAgentExample),
  },
  {
    path: 'worker-mesh',
    loadComponent: () =>
      import('./examples/worker-mesh-example').then(
        (m) => m.WorkerMeshExample,
      ),
  },
  { path: '', pathMatch: 'full', redirectTo: 'core' },
  { path: '**', redirectTo: 'core' },
];
