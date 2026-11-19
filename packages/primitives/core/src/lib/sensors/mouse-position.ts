import { isServer } from '../platform';
import {
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  isDevMode,
  isSignal,
  type Signal,
} from '@angular/core';
import { throttled } from '../throttled';
import { runInSensorContext, type SensorRunOptions } from './sensor-options';

type MousePosition = {
  x: number;
  y: number;
};

/**
 * Options for configuring the `mousePosition` sensor.
 */
export type MousePositionOptions = SensorRunOptions & {
  /**
   * The target element to listen for mouse movements on.
   * Can be `window`, `document`, an `HTMLElement`, an `ElementRef<HTMLElement>`, or a
   * `Signal` resolving to one (e.g. a `viewChild` result) — listeners re-attach when the
   * signal's element changes, and nothing is tracked while it is `null`/`undefined`.
   * @default window
   */
  target?:
    | Window
    | Document
    | HTMLElement
    | ElementRef<HTMLElement>
    | Signal<HTMLElement | ElementRef<HTMLElement> | null | undefined>;
  /**
   * Defines the coordinate system for the reported position.
   * - `'client'`: Coordinates relative to the viewport (`clientX`, `clientY`).
   * - `'page'`: Coordinates relative to the entire document (`pageX`, `pageY`). They also
   *   update when the document scrolls under a still cursor.
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
  return runInSensorContext(opt?.injector, () => createMousePosition(opt));
}

function createMousePosition(opt?: MousePositionOptions): MousePositionSignal {
  if (isServer()) {
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

  const resolve = (
    t:
      | Window
      | Document
      | HTMLElement
      | ElementRef<HTMLElement>
      | null
      | undefined,
  ): Window | Document | HTMLElement | null => {
    if (!t) return null;
    return t instanceof ElementRef ? t.nativeElement : t;
  };

  if (!isSignal(target) && !resolve(target)) {
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

  const page = coordinateSpace === 'page';
  let lastClient: { x: number; y: number } | null = null;

  type Point = Pick<Touch, 'clientX' | 'clientY' | 'pageX' | 'pageY'>;

  // Branch on the event type, not `instanceof MouseEvent`: events from a same-origin
  // iframe are built by that frame's constructors.
  const updatePosition: EventListener = (event) => {
    let point: Point;
    if (event.type === 'touchmove') {
      const touches = (event as TouchEvent).touches;
      if (!(touches?.length > 0)) return;
      point = touches[0];
    } else {
      point = event as MouseEvent;
    }
    lastClient = { x: point.clientX, y: point.clientY };
    pos.set(page ? { x: point.pageX, y: point.pageY } : lastClient);
  };

  // Page coordinates move when the document scrolls under a still cursor.
  const onScroll = (view: Window) => () => {
    if (!lastClient) return;
    pos.set({
      x: lastClient.x + view.scrollX,
      y: lastClient.y + view.scrollY,
    });
  };

  const viewOf = (el: Window | Document | HTMLElement): Window | null => {
    if ('defaultView' in el) return el.defaultView;
    if ('ownerDocument' in el) return el.ownerDocument?.defaultView ?? null;
    return el;
  };

  const attach = (el: Window | Document | HTMLElement): (() => void) => {
    const controller = new AbortController();
    el.addEventListener('mousemove', updatePosition, {
      passive: true,
      signal: controller.signal,
    });
    if (touch) {
      el.addEventListener('touchmove', updatePosition, {
        passive: true,
        signal: controller.signal,
      });
    }
    const view = page ? viewOf(el) : null;
    if (view) {
      view.addEventListener('scroll', onScroll(view), {
        passive: true,
        signal: controller.signal,
      });
    }
    return () => controller.abort();
  };

  if (isSignal(target)) {
    // covers viewChild case
    effect((cleanup) => {
      const el = resolve(target());
      if (!el) return;
      cleanup(attach(el));
    });
  } else {
    const el = resolve(target);
    if (el) inject(DestroyRef).onDestroy(attach(el));
  }

  const base = pos.asReadonly() as InternalMousePositionSignal;
  base.unthrottled = pos.original;
  return base;
}
