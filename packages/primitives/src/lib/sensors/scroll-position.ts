import { isPlatformServer } from '@angular/common'; // Corrected import
import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  PLATFORM_ID, // Used for SSR fallback
  type Signal,
} from '@angular/core';
import { throttled } from '../throttled';

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
export type ScrollPositionOptions = {
  /**
   * The target to listen for scroll events on.
   * Can be `window` (for page scroll) or an `HTMLElement`/`ElementRef<HTMLElement>`.
   * @default window
   */
  target?: Window | HTMLElement | ElementRef<HTMLElement>;
  /**
   * Optional delay in milliseconds to throttle the updates.
   * Scroll events can fire very rapidly.
   * @default 100 // A common default for scroll throttling
   */
  throttle?: number;
  /** Optional debug name for the internal signal. */
  debugName?: string;
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
 * <div #scrollableDiv style="height: 200px; width: 200px; overflow: auto; border: 1px solid black;">
 * <div style="height: 400px; width: 400px;">Scroll me!</div>
 * </div>
 * @if (divScroll()) {
 * <p>Div Scroll: X: {{ divScroll().x }}, Y: {{ divScroll().y }}</p>
 * }
 * `
 * })
 * export class ScrollTrackerComponent {
 * readonly windowScroll = scrollPosition(); // Defaults to window
 * readonly scrollableDiv = viewChild<ElementRef<HTMLDivElement>>('scrollableDiv');
 * readonly divScroll = scrollPosition({ target: this.scrollableDiv() }); // Example with element target
 *
 * constructor() {
 * effect(() => {
 * console.log('Window scrolled to:', this.windowScroll());
 * if (this.divScroll()) {
 * console.log('Div scrolled to:', this.divScroll());
 * }
 * });
 * }
 * }
 * ```
 */
export function scrollPosition(
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
    target = window,
    throttle = 100,
    debugName = 'scrollPosition',
  } = opt || {};

  let element: Window | HTMLElement;

  let getScrollPosition: () => ScrollPosition;

  if (target instanceof Window) {
    element = target;

    getScrollPosition = () => {
      return { x: target.scrollX, y: target.scrollY };
    };
  } else if (target instanceof ElementRef) {
    element = target.nativeElement;
    getScrollPosition = () => {
      return {
        x: target.nativeElement.scrollLeft,
        y: target.nativeElement.scrollTop,
      };
    };
  } else {
    element = target;
    getScrollPosition = () => {
      return {
        x: target.scrollLeft,
        y: target.scrollTop,
      };
    };
  }

  const state = throttled<ScrollPosition>(getScrollPosition(), {
    debugName,
    equal: (a, b) => a.x === b.x && a.y === b.y,
    ms: throttle,
  });

  const onScroll = () => state.set(getScrollPosition());
  element.addEventListener('scroll', onScroll, { passive: true });

  inject(DestroyRef).onDestroy(() =>
    element.removeEventListener('scroll', onScroll),
  );

  const base = state.asReadonly() as InternalScrollPositionSignal;
  base.unthrottled = state.original;
  return base;
}
