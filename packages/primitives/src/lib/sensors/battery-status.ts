import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';

export type BatteryStatus = {
  readonly level: number;
  readonly charging: boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
};

type BatteryManager = BatteryStatus & {
  addEventListener: (
    name: string,
    listener: () => void,
    opt?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (name: string, listener: () => void) => void;
};

const EVENTS = [
  'chargingchange',
  'levelchange',
  'chargingtimechange',
  'dischargingtimechange',
];

/**
 * Creates a read-only signal that tracks the system battery status using the
 * Battery Status API. Returns `null` until the underlying `getBattery()`
 * promise resolves, or permanently when the API is unsupported (Firefox /
 * Safari at the time of writing). SSR-safe.
 */
export function batteryStatus(
  debugName = 'batteryStatus',
): Signal<BatteryStatus | null> {
  if (
    isPlatformServer(inject(PLATFORM_ID)) ||
    typeof navigator === 'undefined' ||
    typeof (navigator as any).getBattery !== 'function'
  ) {
    return computed(() => null, { debugName });
  }

  const state = signal<BatteryStatus | null>(null, { debugName });

  const abortController = new AbortController();
  inject(DestroyRef).onDestroy(() => abortController.abort());

  (navigator as any).getBattery().then((battery: BatteryManager) => {
    if (abortController.signal.aborted) return;

    const read = (): BatteryStatus => ({
      level: battery.level,
      charging: battery.charging,
      chargingTime: battery.chargingTime,
      dischargingTime: battery.dischargingTime,
    });

    const onChange = () => state.set(read());

    state.set(read());
    for (const ev of EVENTS) {
      battery.addEventListener(ev, onChange, {
        signal: abortController.signal,
      });
    }
  });

  return state.asReadonly();
}
