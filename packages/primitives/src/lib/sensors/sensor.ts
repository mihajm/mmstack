import { Signal } from '@angular/core';
import { prefersDarkMode, prefersReducedMotion } from './media-query';
import {
  MousePositionOptions,
  MousePositionSignal,
  mousePosition,
} from './mouse-position';
import { NetworkStatusSignal, networkStatus } from './network-status';
import { pageVisibility } from './page-visibility';
import {
  ScrollPositionOptions,
  ScrollPositionSignal,
  scrollPosition,
} from './scroll-position';
import { WindowSizeOptions, WindowSizeSignal, windowSize } from './window-size';

/**
 * Creates a sensor signal that tracks the mouse cursor's position.
 * @param type Must be `'mousePosition'`.
 * @param options Optional configuration for the mouse position sensor.
 * @returns A `MousePositionSignal` that tracks mouse coordinates and provides an unthrottled version.
 * @see {mousePosition} for detailed documentation and examples.
 * @example const pos = sensor('mousePosition', { coordinateSpace: 'page', throttle: 50 });
 */
export function sensor(
  type: 'mousePosition',
  options?: MousePositionOptions,
): MousePositionSignal;

/**
 * Creates a sensor signal that tracks the browser's online/offline status.
 * @param type Must be `'networkStatus'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `NetworkStatusSignal` which is a boolean indicating online status, with an attached `since` signal.
 * @see {networkStatus} for detailed documentation and examples.
 * @example const onlineStatus = sensor('networkStatus');
 */
export function sensor(
  type: 'networkStatus',
  options?: { debugName?: string },
): NetworkStatusSignal;

/**
 * Creates a sensor signal that tracks the page's visibility state (e.g., 'visible', 'hidden').
 * @param type Must be `'pageVisibility'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `Signal<DocumentVisibilityState>` indicating the page's current visibility.
 * @see {pageVisibility} for detailed documentation and examples.
 * @example const visibility = sensor('pageVisibility');
 */
export function sensor(
  type: 'pageVisibility',
  options?: { debugName?: string },
): Signal<DocumentVisibilityState>;

/**
 * Creates a sensor signal that tracks the user's OS/browser preference for a dark color scheme.
 * @param type Must be `'dark-mode'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `Signal<boolean>` which is `true` if a dark theme is preferred.
 * @see {prefersDarkMode} for detailed documentation and examples.
 * @example const isDarkMode = sensor('dark-mode');
 */
export function sensor(
  type: 'dark-mode',
  options?: { debugName?: string },
): Signal<boolean>;

/**
 * Creates a sensor signal that tracks the user's OS/browser preference for reduced motion.
 * @param type Must be `'reduced-motion'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `Signal<boolean>` which is `true` if reduced motion is preferred.
 * @see {prefersReducedMotion} for detailed documentation and examples.
 * @example const wantsReducedMotion = sensor('reduced-motion');
 */
export function sensor(
  type: 'reduced-motion',
  options?: { debugName?: string },
): Signal<boolean>;

/**
 * Creates a sensor signal that tracks the browser window's inner dimensions (width and height).
 * @param type Must be `'windowSize'`.
 * @param options Optional configuration for the window size sensor, including `throttle` and `debugName`.
 * @returns A `WindowSizeSignal` that tracks window dimensions and provides an unthrottled version.
 * @see {windowSize} for detailed documentation and examples.
 * @example const size = sensor('windowSize', { throttle: 200 });
 */
export function sensor(
  type: 'windowSize',
  options?: WindowSizeOptions,
): WindowSizeSignal;

/**
 * Creates a sensor signal that tracks the scroll position (x, y) of the window or a specified element.
 * @param type Must be `'scrollPosition'`.
 * @param options Optional configuration for the scroll position sensor, including `target`, `throttle`, and `debugName`.
 * @returns A `ScrollPositionSignal` that tracks scroll coordinates and provides an unthrottled version.
 * @see {scrollPosition} for detailed documentation and examples.
 * @example const pageScroll = sensor('scrollPosition', { throttle: 150 });
 */
export function sensor(
  type: 'scrollPosition',
  options?: ScrollPositionOptions,
): ScrollPositionSignal;

/**
 * Implementation for sensor overloads.
 * Users should refer to the specific overloads for detailed documentation.
 * @internal
 */
export function sensor(
  type:
    | 'mousePosition'
    | 'networkStatus'
    | 'pageVisibility'
    | 'dark-mode'
    | 'reduced-motion'
    | 'windowSize'
    | 'scrollPosition',
  options?:
    | {
        debugName?: string;
      }
    | MousePositionOptions
    | WindowSizeOptions
    | ScrollPositionOptions,
):
  | MousePositionSignal
  | NetworkStatusSignal
  | Signal<DocumentVisibilityState>
  | Signal<boolean>
  | WindowSizeSignal
  | ScrollPositionSignal
  | Signal<IntersectionObserverEntry | undefined> {
  switch (type) {
    case 'mousePosition':
      return mousePosition(options);
    case 'networkStatus':
      return networkStatus(options?.debugName);
    case 'pageVisibility':
      return pageVisibility(options?.debugName);
    case 'dark-mode':
      return prefersDarkMode(options?.debugName);
    case 'reduced-motion':
      return prefersReducedMotion(options?.debugName);
    case 'windowSize':
      return windowSize(options);
    case 'scrollPosition':
      return scrollPosition(options as ScrollPositionOptions);
    default:
      throw new Error(`Unknown sensor type: ${type}`);
  }
}
