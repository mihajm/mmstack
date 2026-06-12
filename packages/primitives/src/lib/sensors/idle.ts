import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import { runInSensorContext, type SensorRunOptions } from './sensor-options';

export type IdleOptions = SensorRunOptions & {
  /**
   * Milliseconds of user inactivity before the signal flips to `true`.
   * @default 60_000
   */
  ms?: number;
  /**
   * Activity events that reset the idle timer.
   * @default ['mousemove','keydown','touchstart','scroll','visibilitychange']
   */
  events?: string[];
};

type InternalIdleSignal = Signal<boolean> & {
  since: Signal<Date>;
};

export type IdleSignal = Signal<boolean> & {
  /**
   * Timestamp of the last idle/active transition. Before any transition has occurred it
   * holds the sensor's creation time, not an actual transition.
   */
  readonly since: Signal<Date>;
};

const DEFAULT_EVENTS = [
  'mousemove',
  'keydown',
  'touchstart',
  'scroll',
  'visibilitychange',
];

const serverDate = new Date();

/**
 * Creates a read-only signal that flips to `true` after a window of user
 * inactivity. Any of the configured `events` (default: pointer/keyboard/scroll
 * activity) resets the timer and flips the signal back to `false`.
 *
 * SSR-safe — always `false` with a frozen `since` date on the server.
 *
 * @example
 * ```ts
 * const isAway = idle({ ms: 30_000 });
 * effect(() => {
 *   if (isAway()) console.log('idle since', isAway.since());
 * });
 * ```
 */
export function idle(opt?: IdleOptions): IdleSignal {
  return runInSensorContext(opt?.injector, () => createIdle(opt));
}

function createIdle(opt?: IdleOptions): IdleSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const sig = computed(() => false, {
      debugName: opt?.debugName ?? 'idle',
    }) as InternalIdleSignal;
    sig.since = computed(() => serverDate);
    return sig;
  }

  const ms = opt?.ms ?? 60_000;
  const events = opt?.events ?? DEFAULT_EVENTS;

  const state = signal(false, { debugName: opt?.debugName ?? 'idle' });
  const since = signal(new Date());

  let timer: ReturnType<typeof setTimeout> | undefined;

  const goIdle = () => {
    if (state()) return;
    state.set(true);
    since.set(new Date());
  };

  const reset = () => {
    if (timer) clearTimeout(timer);
    if (state()) {
      state.set(false);
      since.set(new Date());
    }
    timer = setTimeout(goIdle, ms);
  };

  const abortController = new AbortController();

  for (const ev of events) {
    window.addEventListener(ev, reset, {
      passive: true,
      signal: abortController.signal,
    });
  }
  timer = setTimeout(goIdle, ms);

  inject(DestroyRef).onDestroy(() => {
    if (timer) clearTimeout(timer);
    abortController.abort();
  });

  const sig = state.asReadonly() as InternalIdleSignal;
  sig.since = since.asReadonly();
  return sig;
}
