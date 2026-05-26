import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';

export type ScreenOrientation = {
  /** Angle in degrees relative to the natural orientation. */
  readonly angle: number;
  /** One of the four `OrientationType` strings. */
  readonly type: OrientationType;
};

const SSR_FALLBACK: ScreenOrientation = {
  angle: 0,
  type: 'portrait-primary',
};

/**
 * Creates a read-only signal that tracks `screen.orientation`.
 *
 * SSR-safe — returns a constant `portrait-primary / 0°` signal on the server
 * and in environments without `screen.orientation` support.
 */
export function orientation(debugName = 'orientation'): Signal<ScreenOrientation> {
  if (
    isPlatformServer(inject(PLATFORM_ID)) ||
    typeof screen === 'undefined' ||
    !screen.orientation
  ) {
    return computed(() => SSR_FALLBACK, { debugName });
  }

  const so = screen.orientation;

  const read = (): ScreenOrientation => ({
    angle: so.angle,
    type: so.type,
  });

  const state = signal<ScreenOrientation>(read(), {
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
