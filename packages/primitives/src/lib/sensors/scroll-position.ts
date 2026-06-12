import { isPlatformServer } from '@angular/common'; // Corrected import
import {
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  isSignal,
  PLATFORM_ID, // Used for SSR fallback
  type Signal,
  untracked,
} from '@angular/core';
import { throttled } from '../throttled';
import { runInSensorContext, type SensorRunOptions } from './sensor-options';

/**
 * Represents the scroll position.
 */
export type ScrollPosition = {
  /** The horizontal scroll position (pixels from the left). */
  readonly x: number;
  /** The vertical scroll position (pixels from the top). */
  readonly y: number;
};

/**
 * Options for configuring the `scrollPosition` sensor.
 */
export type ScrollPositionOptions = SensorRunOptions & {
  /**
   * The target to listen for scroll events on.
   * Can be `window` (for page scroll), an `HTMLElement`/`ElementRef<HTMLElement>`, or a
   * `Signal` resolving to one (e.g. a `viewChild` result) — listeners re-attach when the
   * signal's element changes, and nothing is tracked while it is `null`/`undefined`.
   * @default window
   */
  target?:
    | Window
    | HTMLElement
    | ElementRef<HTMLElement>
    | Signal<HTMLElement | ElementRef<HTMLElement> | null | undefined>;
  /**
   * Optional delay in milliseconds to throttle the updates.
   * Scroll events can fire very rapidly.
   * @default 100 // A common default for scroll throttling
   */
  throttle?: number;
};

/**
 * @internal used for setting the unthrottled signal
 */
type InternalScrollPositionSignal = Signal<ScrollPosition> & {
  unthrottled: Signal<ScrollPosition>;
};

/**
 * A specialized Signal that tracks scroll position.
 * It's a throttled signal of the scroll coordinates with an attached `unthrottled` signal.
 */
export type ScrollPositionSignal = Signal<ScrollPosition> & {
  /** A signal providing the raw, unthrottled scroll position. */
  readonly unthrottled: Signal<ScrollPosition>;
};

/**
 * Creates a read-only signal that tracks the scroll position (x, y) of the window
 * or a specified HTML element.
 *
 * Updates are throttled by default to optimize performance. An `unthrottled`
 * property is available on the returned signal for direct access to raw updates.
 * The primitive is SSR-safe and automatically cleans up its event listeners.
 *
 * @param options Optional configuration for the scroll sensor.
 * @returns A `ScrollPositionSignal`. On the server, it returns a static
 * signal with `{ x: 0, y: 0 }`.
 *
 * @example
 * ```ts
 * import { Component, effect, ElementRef, viewChild } from '@angular/core';
 * import { scrollPosition } from '@mmstack/primitives';
 *
 * @Component({
 * selector: 'app-scroll-tracker',
 * template: `
 * <p>Window Scroll: X: {{ windowScroll().x }}, Y: {{ windowScroll().y }}</p>
 * <p>Host Scroll: X: {{ hostScroll().x }}, Y: {{ hostScroll().y }}</p>
 * `
 * })
 * export class ScrollTrackerComponent {
 * readonly windowScroll = scrollPosition(); // Defaults to window
 * // Signal targets (e.g. viewChild) attach once the element exists:
 * readonly scrollableDiv = viewChild<ElementRef<HTMLDivElement>>('scrollableDiv');
 * readonly divScroll = scrollPosition({ target: this.scrollableDiv });
 *
 * constructor() {
 * effect(() => console.log('Window scrolled to:', this.windowScroll()));
 * }
 * }
 * ```
 */
export function scrollPosition(
  opt?: ScrollPositionOptions,
): ScrollPositionSignal {
  return runInSensorContext(opt?.injector, () => createScrollPosition(opt));
}

function createScrollPosition(
  opt?: ScrollPositionOptions,
): ScrollPositionSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const base = computed(
      () => ({
        x: 0,
        y: 0,
      }),
      {
        debugName: opt?.debugName ?? 'scrollPosition',
      },
    ) as InternalScrollPositionSignal;
    base.unthrottled = base;
    return base;
  }

  const {
    target = globalThis.window,
    throttle = 100,
    debugName = 'scrollPosition',
  } = opt || {};

  const resolve = (
    t: Window | HTMLElement | ElementRef<HTMLElement> | null | undefined,
  ): Window | HTMLElement | null => {
    if (!t) return null;
    return t instanceof ElementRef ? t.nativeElement : t;
  };

  const isWindow = (el: Window | HTMLElement): el is Window =>
    (el as Window).window === el;

  const readPosition = (el: Window | HTMLElement): ScrollPosition =>
    isWindow(el)
      ? {
          x: el.scrollX ?? el.pageXOffset ?? 0,
          y: el.scrollY ?? el.pageYOffset ?? 0,
        }
      : { x: el.scrollLeft, y: el.scrollTop };

  const initial = resolve(isSignal(target) ? untracked(target) : target);

  const state = throttled<ScrollPosition>(
    initial ? readPosition(initial) : { x: 0, y: 0 },
    {
      debugName,
      equal: (a, b) => a.x === b.x && a.y === b.y,
      ms: throttle,
    },
  );

  if (isSignal(target)) {
    // re-attach whenever the signal resolves to a (new) element — covers viewChild
    effect((cleanup) => {
      const el = resolve(target());
      if (!el) return;
      state.set(readPosition(el)); // sync to the new element immediately
      const onScroll = () => state.set(readPosition(el));
      el.addEventListener('scroll', onScroll, { passive: true });
      cleanup(() => el.removeEventListener('scroll', onScroll));
    });
  } else {
    const el = resolve(target);
    if (el) {
      const onScroll = () => state.set(readPosition(el));
      el.addEventListener('scroll', onScroll, { passive: true });
      inject(DestroyRef).onDestroy(() =>
        el.removeEventListener('scroll', onScroll),
      );
    }
  }

  const base = state.asReadonly() as InternalScrollPositionSignal;
  base.unthrottled = state.original;
  return base;
}
