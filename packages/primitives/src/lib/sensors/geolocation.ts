import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';

export type GeolocationOptions = PositionOptions & {
  /**
   * If `true`, uses `navigator.geolocation.watchPosition` and updates the
   * signal continuously. Otherwise a single `getCurrentPosition` call is made.
   * @default false
   */
  watch?: boolean;
  /** Optional debug name for the produced signal. */
  debugName?: string;
};

type InternalGeolocationSignal = Signal<GeolocationPosition | null> & {
  error: Signal<GeolocationPositionError | null>;
  loading: Signal<boolean>;
};

export type GeolocationSignal = Signal<GeolocationPosition | null> & {
  readonly error: Signal<GeolocationPositionError | null>;
  readonly loading: Signal<boolean>;
};

/**
 * Creates a read-only signal that exposes the current geolocation position.
 *
 * The returned signal carries `error` and `loading` sub-signals for permission
 * failures and the in-flight initial fetch respectively. SSR-safe — on the
 * server the position is `null`, loading is `false`, and no API calls are made.
 *
 * @example
 * ```ts
 * const where = geolocation({ watch: true, enableHighAccuracy: true });
 * effect(() => console.log(where()?.coords, where.error()));
 * ```
 */
export function geolocation(opt?: GeolocationOptions): GeolocationSignal {
  if (isPlatformServer(inject(PLATFORM_ID)) || typeof navigator === 'undefined' || !navigator.geolocation) {
    const sig = computed(() => null, {
      debugName: opt?.debugName ?? 'geolocation',
    }) as InternalGeolocationSignal;
    sig.error = computed(() => null);
    sig.loading = computed(() => false);
    return sig;
  }

  const position = signal<GeolocationPosition | null>(null, {
    debugName: opt?.debugName ?? 'geolocation',
  });
  const error = signal<GeolocationPositionError | null>(null);
  const loading = signal(true);

  const onSuccess = (p: GeolocationPosition) => {
    position.set(p);
    error.set(null);
    loading.set(false);
  };
  const onError = (e: GeolocationPositionError) => {
    error.set(e);
    loading.set(false);
  };

  if (opt?.watch) {
    const watchId = navigator.geolocation.watchPosition(onSuccess, onError, opt);
    inject(DestroyRef).onDestroy(() =>
      navigator.geolocation.clearWatch(watchId),
    );
  } else {
    navigator.geolocation.getCurrentPosition(onSuccess, onError, opt);
  }

  const sig = position.asReadonly() as InternalGeolocationSignal;
  sig.error = error.asReadonly();
  sig.loading = loading.asReadonly();
  return sig;
}
