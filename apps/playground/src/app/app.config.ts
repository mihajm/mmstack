import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideClientHydration,
  withEventReplay,
} from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideDnd } from '@mmstack/dnd';
import { edgeAutoScroll } from '@mmstack/dnd/plugins';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { appRoutes } from './app.routes';
import { providePlaygroundTelemetry, telemetryInterceptor } from './telemetry';

export const appConfig: ApplicationConfig = {
  providers: [
    provideClientHydration(withEventReplay()),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([telemetryInterceptor])),
    provideRouter(appRoutes),
    providePlaygroundTelemetry(),
    // Optional plugins: pragmatic's hitbox for edge detection, and our zero-dep
    // `edgeAutoScroll` for reorderable auto-scroll (@mmstack/dnd/plugins).
    provideDnd({
      plugins: {
        hitbox: { attachClosestEdge, extractClosestEdge },
        autoScroll: edgeAutoScroll,
      },
    }),
  ],
};
