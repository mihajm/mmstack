import { type Route } from '@angular/router';
import { createNavItems, createTitle } from '@mmstack/router-core';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: createTitle('mmstack'),
    loadComponent: () => import('./pages/landing').then((m) => m.Landing),
  },
  {
    path: 'updates',
    title: createTitle('Updates'),
    loadComponent: () => import('./pages/updates').then((m) => m.Updates),
  },
  {
    path: 'docs',
    loadComponent: () => import('./docs-shell').then((m) => m.DocsShell),
    resolve: {
      _nav: createNavItems(
        [
          {
            label: '@mmstack/primitives',
            children: [
              { label: 'Overview', link: 'primitives' },
              { label: 'Signal variants', link: 'primitives/signals' },
              { label: 'Store', link: 'primitives/store' },
              { label: 'Sync & convergence', link: 'primitives/sync' },
              { label: 'Mapped collections', link: 'primitives/collections' },
              { label: 'Timing', link: 'primitives/timing' },
              { label: 'Storage & history', link: 'primitives/storage' },
              { label: 'Sensors', link: 'primitives/sensors' },
              { label: 'Pipelines', link: 'primitives/pipelines' },
              { label: 'Performance', link: 'primitives/performance' },
              { label: 'Transitions & suspense', link: 'primitives/transitions' },
              { label: 'Observability', link: 'primitives/observability' },
              { label: 'Keep-alive & pausing', link: 'primitives/pausing' },
            ],
          },
          {
            label: '@mmstack/resource',
            children: [
              { label: 'Overview', link: 'resource' },
              { label: 'queryResource', link: 'resource/query' },
              { label: 'infiniteQueryResource', link: 'resource/infinite-query' },
              { label: 'mutationResource', link: 'resource/mutation' },
              { label: 'Optimistic updates', link: 'resource/optimistic' },
              { label: 'Streaming (SSE / WebSocket)', link: 'resource/streaming' },
              { label: 'Caching & circuit breakers', link: 'resource/caching' },
              { label: 'Offline & reconnection', link: 'resource/offline' },
              { label: 'Testing', link: 'resource/testing' },
            ],
          },
          {
            label: '@mmstack/router-core',
            children: [
              { label: 'Overview', link: 'router-core' },
              { label: 'Reactive state', link: 'router-core/state' },
              { label: 'Preloading', link: 'router-core/preloading' },
              { label: 'Route data', link: 'router-core/route-data' },
              { label: 'Transition outlet', link: 'router-core/transition-outlet' },
              { label: 'Titles, breadcrumbs & nav', link: 'router-core/route-ui' },
            ],
          },
          {
            label: '@mmstack/translate',
            children: [
              { label: 'Overview', link: 'translate' },
              { label: 'Configuration', link: 'translate/configuration' },
              { label: 'Namespaces', link: 'translate/namespaces' },
              { label: 'Reading translations', link: 'translate/reading' },
              { label: 'Formatters', link: 'translate/formatters' },
              { label: 'Tooling', link: 'translate/tooling' },
              { label: 'Testing', link: 'translate/testing' },
            ],
          },
          {
            label: '@mmstack/dnd',
            children: [
              { label: 'Overview', link: 'dnd' },
              { label: 'Draggables & drop targets', link: 'dnd/elements' },
              { label: 'Sortable lists', link: 'dnd/reorderable' },
              { label: 'Grids', link: 'dnd/grids' },
              { label: 'Canvas', link: 'dnd/canvas' },
              { label: 'Advanced', link: 'dnd/advanced' },
            ],
          },
          {
            label: '@mmstack/di',
            children: [
              { label: 'Overview', link: 'di' },
              { label: 'injectable', link: 'di/injectable' },
              { label: 'Lazy & async', link: 'di/lazy-async' },
              { label: 'Scopes & singletons', link: 'di/scopes' },
            ],
          },
          {
            label: '@mmstack/forms',
            children: [
              { label: 'Overview', link: 'forms' },
              { label: 'Field metadata', link: 'forms/field-metadata' },
              { label: 'Composition', link: 'forms/composition' },
              { label: 'Change tracking', link: 'forms/change-tracking' },
            ],
          },
          {
            label: '@mmstack/worker',
            children: [
              { label: 'Overview', link: 'worker' },
              { label: 'workerResource', link: 'worker/resource' },
              { label: 'Replicas & writes', link: 'worker/store' },
              { label: 'Host & typing', link: 'worker/setup' },
            ],
          },
          {
            label: '@mmstack/telemetry',
            children: [
              { label: 'Overview', link: 'telemetry' },
              { label: 'Adapters', link: 'telemetry/adapters' },
              { label: 'Consent', link: 'telemetry/consent' },
            ],
          },
          {
            label: '@mmstack/mesh',
            children: [
              { label: 'Overview', link: 'mesh' },
              { label: 'The client', link: 'mesh/client' },
              { label: 'The relay', link: 'mesh/relay' },
            ],
          },
        ],
        { name: 'docs' },
      ),
    },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'primitives' },

      // primitives
      {
        path: 'primitives',
        title: createTitle('Primitives'),
        loadComponent: () =>
          import('./pages/docs/primitives/overview').then(
            (m) => m.PrimitivesOverview,
          ),
      },
      {
        path: 'primitives/signals',
        title: createTitle('Signal variants'),
        loadComponent: () =>
          import('./pages/docs/primitives/signals').then(
            (m) => m.SignalVariantsDoc,
          ),
      },
      {
        path: 'primitives/store',
        title: createTitle('Store'),
        loadComponent: () =>
          import('./pages/docs/primitives/store').then((m) => m.StoreDoc),
      },
      {
        path: 'primitives/sync',
        title: createTitle('Sync & convergence'),
        loadComponent: () =>
          import('./pages/docs/primitives/sync').then((m) => m.SyncDoc),
      },
      {
        path: 'primitives/collections',
        title: createTitle('Mapped collections'),
        loadComponent: () =>
          import('./pages/docs/primitives/collections').then(
            (m) => m.CollectionsDoc,
          ),
      },
      {
        path: 'primitives/timing',
        title: createTitle('Timing'),
        loadComponent: () =>
          import('./pages/docs/primitives/timing').then((m) => m.TimingDoc),
      },
      {
        path: 'primitives/storage',
        title: createTitle('Storage and history'),
        loadComponent: () =>
          import('./pages/docs/primitives/storage').then((m) => m.StorageDoc),
      },
      {
        path: 'primitives/sensors',
        title: createTitle('Sensors'),
        loadComponent: () =>
          import('./pages/docs/primitives/sensors').then((m) => m.SensorsDoc),
      },
      {
        path: 'primitives/pipelines',
        title: createTitle('Pipelines'),
        loadComponent: () =>
          import('./pages/docs/primitives/pipelines').then(
            (m) => m.PipelinesDoc,
          ),
      },
      {
        path: 'primitives/performance',
        title: createTitle('Performance'),
        loadComponent: () =>
          import('./pages/docs/primitives/performance').then(
            (m) => m.PerformanceDoc,
          ),
      },
      {
        path: 'primitives/transitions',
        title: createTitle('Transitions & suspense'),
        loadComponent: () =>
          import('./pages/docs/primitives/transitions').then(
            (m) => m.TransitionsDoc,
          ),
      },
      {
        path: 'primitives/observability',
        title: createTitle('Observability'),
        loadComponent: () =>
          import('./pages/docs/primitives/observability').then(
            (m) => m.ObservabilityDoc,
          ),
      },
      {
        path: 'primitives/pausing',
        title: createTitle('Keep-alive and pausing'),
        loadComponent: () =>
          import('./pages/docs/primitives/pausing').then((m) => m.PausingDoc),
      },

      // resource
      {
        path: 'resource',
        title: createTitle('Resource'),
        loadComponent: () =>
          import('./pages/docs/resource/overview').then(
            (m) => m.ResourceOverview,
          ),
      },
      {
        path: 'resource/query',
        title: createTitle('queryResource'),
        loadComponent: () =>
          import('./pages/docs/resource/query').then((m) => m.QueryResourceDoc),
      },
      {
        path: 'resource/mutation',
        title: createTitle('mutationResource'),
        loadComponent: () =>
          import('./pages/docs/resource/mutation').then(
            (m) => m.MutationResourceDoc,
          ),
      },
      {
        path: 'resource/optimistic',
        title: createTitle('Optimistic updates'),
        loadComponent: () =>
          import('./pages/docs/resource/optimistic').then(
            (m) => m.OptimisticDoc,
          ),
      },
      {
        path: 'resource/infinite-query',
        title: createTitle('infiniteQueryResource'),
        loadComponent: () =>
          import('./pages/docs/resource/infinite-query').then(
            (m) => m.InfiniteQueryDoc,
          ),
      },
      {
        path: 'resource/offline',
        title: createTitle('Offline and reconnection'),
        loadComponent: () =>
          import('./pages/docs/resource/offline').then((m) => m.OfflineDoc),
      },
      {
        path: 'resource/testing',
        title: createTitle('Testing resources'),
        loadComponent: () =>
          import('./pages/docs/resource/testing').then(
            (m) => m.ResourceTestingDoc,
          ),
      },
      {
        path: 'resource/streaming',
        title: createTitle('Streaming'),
        loadComponent: () =>
          import('./pages/docs/resource/streaming').then((m) => m.StreamingDoc),
      },
      {
        path: 'resource/caching',
        title: createTitle('Caching and circuit breakers'),
        loadComponent: () =>
          import('./pages/docs/resource/caching').then((m) => m.CachingDoc),
      },

      // router-core
      {
        path: 'router-core',
        title: createTitle('Router core'),
        loadComponent: () =>
          import('./pages/docs/router-core/overview').then(
            (m) => m.RouterCoreOverview,
          ),
      },
      {
        path: 'router-core/state',
        title: createTitle('Reactive state'),
        loadComponent: () =>
          import('./pages/docs/router-core/state').then(
            (m) => m.RouterStateDoc,
          ),
      },
      {
        path: 'router-core/preloading',
        title: createTitle('Preloading'),
        loadComponent: () =>
          import('./pages/docs/router-core/preloading').then(
            (m) => m.PreloadingDoc,
          ),
      },
      {
        path: 'router-core/route-data',
        title: createTitle('Route data'),
        loadComponent: () =>
          import('./pages/docs/router-core/route-data').then(
            (m) => m.RouteDataDoc,
          ),
      },
      {
        path: 'router-core/transition-outlet',
        title: createTitle('Transition outlet'),
        loadComponent: () =>
          import('./pages/docs/router-core/transition-outlet').then(
            (m) => m.TransitionOutletDoc,
          ),
      },
      {
        path: 'router-core/route-ui',
        title: createTitle('Titles, breadcrumbs and nav'),
        loadComponent: () =>
          import('./pages/docs/router-core/route-ui').then(
            (m) => m.RouteUiDoc,
          ),
      },

      // translate
      {
        path: 'translate',
        title: createTitle('Translate'),
        loadComponent: () =>
          import('./pages/docs/translate/overview').then(
            (m) => m.TranslateOverview,
          ),
      },
      {
        path: 'translate/configuration',
        title: createTitle('Configuration'),
        loadComponent: () =>
          import('./pages/docs/translate/configuration').then(
            (m) => m.ConfigurationDoc,
          ),
      },
      {
        path: 'translate/namespaces',
        title: createTitle('Namespaces'),
        loadComponent: () =>
          import('./pages/docs/translate/namespaces').then(
            (m) => m.NamespacesDoc,
          ),
      },
      {
        path: 'translate/reading',
        title: createTitle('Reading translations'),
        loadComponent: () =>
          import('./pages/docs/translate/reading').then((m) => m.ReadingDoc),
      },
      {
        path: 'translate/formatters',
        title: createTitle('Formatters'),
        loadComponent: () =>
          import('./pages/docs/translate/formatters').then(
            (m) => m.FormattersDoc,
          ),
      },
      {
        path: 'translate/tooling',
        title: createTitle('Tooling'),
        loadComponent: () =>
          import('./pages/docs/translate/tooling').then((m) => m.ToolingDoc),
      },
      {
        path: 'translate/testing',
        title: createTitle('Testing translations'),
        loadComponent: () =>
          import('./pages/docs/translate/testing').then(
            (m) => m.TranslateTestingDoc,
          ),
      },

      // dnd
      {
        path: 'dnd',
        title: createTitle('Drag and drop'),
        loadComponent: () =>
          import('./pages/docs/dnd/overview').then((m) => m.DndOverview),
      },
      {
        path: 'dnd/elements',
        title: createTitle('Draggables and drop targets'),
        loadComponent: () =>
          import('./pages/docs/dnd/drag-and-drop').then(
            (m) => m.DragAndDropDoc,
          ),
      },
      {
        path: 'dnd/reorderable',
        title: createTitle('Sortable lists'),
        loadComponent: () =>
          import('./pages/docs/dnd/reorderable').then((m) => m.ReorderableDoc),
      },
      {
        path: 'dnd/grids',
        title: createTitle('Grids'),
        loadComponent: () =>
          import('./pages/docs/dnd/grids').then((m) => m.DndGridsDoc),
      },
      {
        path: 'dnd/canvas',
        title: createTitle('Canvas'),
        loadComponent: () =>
          import('./pages/docs/dnd/canvas').then((m) => m.DndCanvasDoc),
      },
      {
        path: 'dnd/advanced',
        title: createTitle('Advanced drag and drop'),
        loadComponent: () =>
          import('./pages/docs/dnd/advanced').then((m) => m.DndAdvancedDoc),
      },

      // di
      {
        path: 'di',
        title: createTitle('DI'),
        loadComponent: () =>
          import('./pages/docs/di/overview').then((m) => m.DiOverview),
      },
      {
        path: 'di/injectable',
        title: createTitle('injectable'),
        loadComponent: () =>
          import('./pages/docs/di/injectable').then((m) => m.DiInjectable),
      },
      {
        path: 'di/lazy-async',
        title: createTitle('Lazy and async'),
        loadComponent: () =>
          import('./pages/docs/di/lazy-async').then((m) => m.DiLazyAsync),
      },
      {
        path: 'di/scopes',
        title: createTitle('Scopes and singletons'),
        loadComponent: () =>
          import('./pages/docs/di/scopes').then((m) => m.DiScopes),
      },

      // forms
      {
        path: 'forms',
        title: createTitle('Forms'),
        loadComponent: () =>
          import('./pages/docs/forms/overview').then((m) => m.FormsOverview),
      },
      {
        path: 'forms/field-metadata',
        title: createTitle('Field metadata'),
        loadComponent: () =>
          import('./pages/docs/forms/field-metadata').then(
            (m) => m.FieldMetadataDoc,
          ),
      },
      {
        path: 'forms/composition',
        title: createTitle('Composition'),
        loadComponent: () =>
          import('./pages/docs/forms/composition').then(
            (m) => m.CompositionDoc,
          ),
      },
      {
        path: 'forms/change-tracking',
        title: createTitle('Change tracking'),
        loadComponent: () =>
          import('./pages/docs/forms/change-tracking').then(
            (m) => m.ChangeTrackingDoc,
          ),
      },
      {
        path: 'worker',
        title: createTitle('Worker'),
        loadComponent: () =>
          import('./pages/docs/worker/overview').then((m) => m.WorkerOverview),
      },
      {
        path: 'worker/resource',
        title: createTitle('workerResource'),
        loadComponent: () =>
          import('./pages/docs/worker/resource').then((m) => m.WorkerResourceDoc),
      },
      {
        path: 'worker/store',
        title: createTitle('Replicas & writes'),
        loadComponent: () =>
          import('./pages/docs/worker/store').then((m) => m.WorkerStoreDoc),
      },
      {
        path: 'worker/setup',
        title: createTitle('Host & typing'),
        loadComponent: () =>
          import('./pages/docs/worker/setup').then((m) => m.WorkerSetupDoc),
      },
      {
        path: 'telemetry',
        title: createTitle('Telemetry'),
        loadComponent: () =>
          import('./pages/docs/telemetry/overview').then(
            (m) => m.TelemetryOverview,
          ),
      },
      {
        path: 'telemetry/adapters',
        title: createTitle('Telemetry adapters'),
        loadComponent: () =>
          import('./pages/docs/telemetry/adapters').then(
            (m) => m.TelemetryAdapters,
          ),
      },
      {
        path: 'telemetry/consent',
        title: createTitle('Telemetry consent'),
        loadComponent: () =>
          import('./pages/docs/telemetry/consent').then(
            (m) => m.TelemetryConsent,
          ),
      },
      {
        path: 'mesh',
        title: createTitle('Mesh'),
        loadComponent: () =>
          import('./pages/docs/mesh/overview').then((m) => m.MeshOverview),
      },
      {
        path: 'mesh/client',
        title: createTitle('Mesh client'),
        loadComponent: () =>
          import('./pages/docs/mesh/client').then((m) => m.MeshClient),
      },
      {
        path: 'mesh/relay',
        title: createTitle('Mesh relay'),
        loadComponent: () =>
          import('./pages/docs/mesh/relay').then((m) => m.MeshRelay),
      },
    ],
  },
  {
    path: '404',
    title: createTitle('Not found'),
    loadComponent: () => import('./pages/not-found').then((m) => m.NotFound),
  },
  {
    path: '**',
    title: createTitle('Not found'),
    loadComponent: () => import('./pages/not-found').then((m) => m.NotFound),
  },
];
