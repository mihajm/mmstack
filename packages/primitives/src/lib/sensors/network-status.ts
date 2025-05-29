import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  Signal,
  signal,
} from '@angular/core';

/**
 * @internal used for setting the since signal
 */
type InternalNetworkStatusSignal = Signal<boolean> & {
  since: Signal<Date>;
};

/**
 * A specialized Signal that tracks network status.
 * It's a boolean signal with an attached `since` signal.
 */
export type NetworkStatusSignal = Signal<boolean> & {
  /** A signal tracking the timestamp of the last status change. */
  readonly since: Signal<Date>;
};

const serverDate = new Date();

/**
 * Creates a read-only signal that tracks the browser's online status.
 *
 * The main signal returns a boolean (`true` for online, `false` for offline).
 * An additional `since` signal is attached, tracking when the status last changed.
 * It's SSR-safe and automatically cleans up its event listeners.
 *
 * @param debugName Optional debug name for the signal.
 * @returns A `NetworkStatusSignal` instance.
 */
export function networkStatus(debugName?: string): NetworkStatusSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const sig = computed(() => true, {
      debugName,
    }) as InternalNetworkStatusSignal;
    sig.since = computed(() => serverDate);
    return sig;
  }

  const state = signal(navigator.onLine, {
    debugName,
  });
  const since = signal(new Date());

  const goOnline = () => {
    state.set(true);
    since.set(new Date());
  };
  const goOffline = () => {
    state.set(false);
    since.set(new Date());
  };

  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);

  inject(DestroyRef).onDestroy(() => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
  });

  const sig = state.asReadonly() as InternalNetworkStatusSignal;
  sig.since = since.asReadonly();

  return sig;
}
