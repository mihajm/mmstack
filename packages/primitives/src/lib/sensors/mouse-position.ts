import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  isDevMode,
  PLATFORM_ID,
  type Signal,
} from '@angular/core';
import { throttled } from '../throttled';

type MousePosition = {
  x: number;
  y: number;
};

/**
 * Options for configuring the `mousePosition` sensor.
 */
export type MousePositionOptions = {
  /**
   * The target element to listen for mouse movements on.
   * Can be `window`, `document`, an `HTMLElement`, or an `ElementRef<HTMLElement>`.
   * @default window
   */
  target?: Window | Document | HTMLElement | ElementRef<HTMLElement>;
  /**
   * Defines the coordinate system for the reported position.
   * - `'client'`: Coordinates relative to the viewport (`clientX`, `clientY`).
   * - `'page'`: Coordinates relative to the entire document (`pageX`, `pageY`).
   * @default 'client'
   */
  coordinateSpace?: 'client' | 'page';
  /**
   * If `true`, the sensor will also listen to `touchmove` events and report
   * the coordinates of the first touch point.
   * @default false
   */
  touch?: boolean;
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
type InternalMousePositionSignal = Signal<MousePosition> & {
  unthrottled: Signal<MousePosition>;
};

/**
 * A specialized Signal that tracks mouse position within an element.
 * It's a throttled signal of the mouse coordinates with an attached `unthrottled` signal.
 */
export type MousePositionSignal = Signal<MousePosition> & {
  /** A signal providing the raw, unthrottled mouse position. */
  readonly unthrottled: Signal<MousePosition>;
};

/**
 * Creates a read-only signal that tracks the mouse cursor's position.
 *
 * It can track mouse movements on a specific target (window, document, or element)
 * and optionally include touch movements. The coordinate space ('client' or 'page')
 * can also be configured.
 * The primitive is SSR-safe and automatically cleans up its event listeners.
 *
 * @param options Optional configuration for the sensor.
 * @returns A read-only `Signal<MousePosition>`. On the server, it returns a static
 * signal with `{ x: 0, y: 0 }`.
 *
 * @example
 * ```ts
 * import { Component, effect } from '@angular/core';
 * import { mousePosition } from '@mmstack/primitives';
 *
 * @Component({
 * selector: 'app-mouse-tracker',
 * template: `<p>Mouse Position: X: {{ pos().x }}, Y: {{ pos().y }}</p>`
 * })
 * export class MouseTrackerComponent {
 * readonly pos = mousePosition({ coordinateSpace: 'page' });
 *
 * constructor() {
 * effect(() => {
 * console.log('Mouse moved to:', this.pos());
 * });
 * }
 * }
 * ```
 */
export function mousePosition(opt?: MousePositionOptions): MousePositionSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const base = computed(
      () => ({
        x: 0,
        y: 0,
      }),
      {
        debugName: opt?.debugName ?? 'mousePosition',
      },
    ) as InternalMousePositionSignal;
    base.unthrottled = base;
    return base;
  }

  const {
    target = window,
    coordinateSpace = 'client',
    touch = false,
    debugName = 'mousePosition',
    throttle = 100,
  } = opt ?? {};

  const eventTarget =
    target instanceof ElementRef ? target.nativeElement : target;

  if (!eventTarget) {
    if (isDevMode()) console.warn('mousePosition: Target element not found.');

    const base = computed(
      () => ({
        x: 0,
        y: 0,
      }),
      {
        debugName,
      },
    ) as InternalMousePositionSignal;
    base.unthrottled = base;
    return base;
  }

  const pos = throttled(
    { x: 0, y: 0 },
    {
      ms: throttle,
      equal: (a, b) => a.x === b.x && a.y === b.y,
      debugName,
    },
  );

  const updatePosition = (event: MouseEvent | TouchEvent) => {
    let x: number, y: number;

    if (event instanceof MouseEvent) {
      x = coordinateSpace === 'page' ? event.pageX : event.clientX;
      y = coordinateSpace === 'page' ? event.pageY : event.clientY;
    } else if (event.touches.length > 0) {
      const firstTouch = event.touches[0];
      x = coordinateSpace === 'page' ? firstTouch.pageX : firstTouch.clientX;
      y = coordinateSpace === 'page' ? firstTouch.pageY : firstTouch.clientY;
    } else {
      return;
    }
    pos.set({ x, y });
  };

  eventTarget.addEventListener('mousemove', updatePosition as EventListener);
  if (touch) {
    eventTarget.addEventListener('touchmove', updatePosition as EventListener);
  }

  inject(DestroyRef).onDestroy(() => {
    eventTarget.removeEventListener(
      'mousemove',
      updatePosition as EventListener,
    );
    if (touch) {
      eventTarget.removeEventListener(
        'touchmove',
        updatePosition as EventListener,
      );
    }
  });

  const base = pos.asReadonly() as InternalMousePositionSignal;
  base.unthrottled = pos.original;
  return base;
}
