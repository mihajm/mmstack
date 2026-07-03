import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideClientHydration,
  withEventReplay,
} from '@angular/platform-browser';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withPreloading,
} from '@angular/router';
import { provideDnd } from '@mmstack/dnd';
import { edgeAutoScroll } from '@mmstack/dnd/plugins';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import {
  PreloadStrategy,
  provideNavConfig,
  provideTitleConfig,
} from '@mmstack/router-core';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideClientHydration(withEventReplay()),
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      appRoutes,
      withComponentInputBinding(),
      withPreloading(PreloadStrategy),
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
    ),
    provideTitleConfig({
      prefix: (title) => `${title} • mmstack`,
      initialTitle: 'mmstack',
    }),
    // Exact matching so a parent page (e.g. /docs/primitives) stops being
    // marked active once a child route (/docs/primitives/store) is open.
    provideNavConfig({
      activeMatch: {
        paths: 'exact',
        queryParams: 'ignored',
        matrixParams: 'ignored',
        fragment: 'ignored',
      },
    }),
    provideDnd({
      plugins: {
        hitbox: { attachClosestEdge, extractClosestEdge },
        autoScroll: edgeAutoScroll,
      },
    }),
  ],
};
