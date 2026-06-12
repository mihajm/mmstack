import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import {
  coerceSensorOptions,
  runInSensorContext,
  type SensorRunOptions,
} from './sensor-options';

export type ScreenOrientationState = {
  /** Angle in degrees relative to the natural orientation. */
  readonly angle: number;
  /** One of the four `OrientationType` strings. */
  readonly type: OrientationType;
};

/**
 * @deprecated Use {@link ScreenOrientationState} instead — this name shadows the DOM's global
 * `ScreenOrientation` interface in any module that imports it, silently changing the meaning of
 * `screen.orientation`-related typings there.
 */
export type ScreenOrientation = ScreenOrientationState;

const SSR_FALLBACK: ScreenOrientationState = {
  angle: 0,
  type: 'portrait-primary',
};

/**
 * Creates a read-only signal that tracks `screen.orientation`.
 *
 * SSR-safe — returns a constant `portrait-primary / 0°` signal on the server
 * and in environments without `screen.orientation` support.
 *
 * @example
 * ```ts
 * const screenOrientation = orientation();
 * effect(() => {
 *   const { type, angle } = screenOrientation();
 *   console.log(`${type} at ${angle}°`);
 * });
 * ```
 */
export function orientation(
  opt?: string | SensorRunOptions,
): Signal<ScreenOrientationState> {
  const { debugName = 'orientation', injector } = coerceSensorOptions(opt);
  return runInSensorContext(injector, () => createOrientation(debugName));
}

function createOrientation(debugName: string): Signal<ScreenOrientationState> {
  if (
    isPlatformServer(inject(PLATFORM_ID)) ||
    typeof screen === 'undefined' ||
    !screen.orientation
  ) {
    return computed(() => SSR_FALLBACK, { debugName });
  }

  const so = screen.orientation;

  const read = (): ScreenOrientationState => ({
    angle: so.angle,
    type: so.type,
  });

  const state = signal<ScreenOrientationState>(read(), {
    debugName,
    equal: (a, b) => a.angle === b.angle && a.type === b.type,
  });

  const onChange = () => state.set(read());
  so.addEventListener('change', onChange);

  inject(DestroyRef).onDestroy(() =>
    so.removeEventListener('change', onChange),
  );

  return state.asReadonly();
}
