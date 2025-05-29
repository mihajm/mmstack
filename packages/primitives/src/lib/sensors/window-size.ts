import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  Signal,
} from '@angular/core';
import { throttled } from '../throttled';

/**
 * Represents the dimensions of the window.
 */
export type WindowSize = {
  /** The current inner width of the window in pixels. */
  readonly width: number;
  /** The current inner height of the window in pixels. */
  readonly height: number;
};

/**
 * Options for configuring the `mousePosition` sensor.
 */
export type WindowSizeOptions = {
  /**
   * Optional debug name for the internal signal.
   */
  debugName?: string;
  /**
   * Optional delay in milliseconds to throttle the updates.
   * @default 100
   */
  throttle?: number;
};

/**
 * @internal used for setting the since signal
 */
type InternalWindowSizeSignal = Signal<WindowSize> & {
  unthrottled: Signal<WindowSize>;
};

/**
 * A specialized Signal that tracks window size.
 * It's a throttled signal of the window.innerHeight/innerWidth properties
 * with an attached `unthrottled` signal.
 */
export type WindowSizeSignal = Signal<WindowSize> & {
  /** A signal providing the raw, unthrottled window size. */
  readonly unthrottled: Signal<WindowSize>;
};

/**
 * Creates a read-only signal that tracks the browser window's inner dimensions (width and height).
 *
 * Updates are throttled by default (100ms) to optimize performance during resize events.
 * An `unthrottled` property is available on the returned signal for direct access to raw updates.
 * The primitive is SSR-safe (returns a default size on the server) and automatically
 * cleans up its event listeners.
 *
 * @param opt Optional configuration, including `throttle` (ms) and `debugName`.
 * @returns A `WindowSizeSignal` (a `Signal<WindowSize>` with an `unthrottled` property).
 *
 * @example
 * ```ts
 * import { Component, effect } from '@angular/core';
 * import { windowSize } from '@mmstack/primitives';
 *
 * @Component({
 * selector: 'app-responsive-header',
 * template: `
 * <header>
 * Current Window Size: {{ size().width }}px x {{ size().height }}px
 * @if (isMobile()) {
 * <p>Mobile Menu</p>
 * } @else {
 * <p>Desktop Menu</p>
 * }
 * </header>
 * `
 * })
 * export class ResponsiveHeaderComponent {
 * readonly size = windowSize();
 * readonly isMobile = computed(() => this.size().width < 768);
 *
 * constructor() {
 * effect(() => {
 * console.log('Window resized to:', this.size());
 * });
 * }
 * }
 * ```
 */
export function windowSize(opt?: WindowSizeOptions): WindowSizeSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const base = computed(
      () => ({
        width: 1024,
        height: 768,
      }),
      { debugName: opt?.debugName },
    ) as InternalWindowSizeSignal;

    base.unthrottled = base;
    return base;
  }

  const sizeSignal = throttled<WindowSize>(
    { width: window.innerWidth, height: window.innerHeight },
    {
      debugName: opt?.debugName,
      equal: (a, b) => a.width === b.width && a.height === b.height,
      ms: opt?.throttle ?? 100,
    },
  );

  const onResize = () => {
    sizeSignal.set({ width: window.innerWidth, height: window.innerHeight });
  };

  window.addEventListener('resize', onResize);

  inject(DestroyRef).onDestroy(() => {
    window.removeEventListener('resize', onResize);
  });

  const base = sizeSignal.asReadonly() as InternalWindowSizeSignal;
  base.unthrottled = sizeSignal.original;
  return base;
}
