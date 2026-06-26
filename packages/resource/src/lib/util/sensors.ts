import {
  inject,
  Injectable,
  type Provider,
  signal,
  type Signal,
} from '@angular/core';
import { sensor } from '@mmstack/primitives';

@Injectable({
  providedIn: 'root',
})
export class ResourceSensors {
  readonly networkStatus = sensor('networkStatus');
  readonly pageVisibility = sensor('pageVisibility');
}

export function injectNetworkStatus() {
  return inject(ResourceSensors).networkStatus;
}

export function injectPageVisibility() {
  return inject(ResourceSensors).pageVisibility;
}

/**
 * Provides controllable {@link ResourceSensors} for unit tests, letting you drive a
 * resource's offline / page-hidden behavior deterministically instead of relying on
 * the real `navigator.onLine` / `document.visibilityState`.
 *
 * Pass your own writable signals to toggle state mid-test; omit them for a static
 * online + visible environment.
 *
 * @example
 * import { signal } from '@angular/core';
 *
 * const online = signal(true);
 * TestBed.configureTestingModule({
 *   providers: [provideMockResourceSensors({ networkStatus: online })],
 * });
 * // ...later in the test
 * online.set(false); // the resource now sees the network as down
 */
export function provideMockResourceSensors(opt?: {
  networkStatus?: Signal<boolean>;
  pageVisibility?: Signal<DocumentVisibilityState>;
}): Provider {
  return {
    provide: ResourceSensors,
    useValue: {
      networkStatus: opt?.networkStatus ?? signal(true),
      pageVisibility:
        opt?.pageVisibility ?? signal<DocumentVisibilityState>('visible'),
    },
  };
}
