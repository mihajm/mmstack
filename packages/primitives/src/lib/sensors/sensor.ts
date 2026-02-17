import { type ElementRef, type Signal } from '@angular/core';
import {
  type ElementSizeOptions as BaseElementSizeOptions,
  type ElementSizeSignal,
  elementSize,
} from './element-size';
import {
  type ElementVisibilityOptions as BaseElementVisibilityOptions,
  type ElementVisibilitySignal,
  elementVisibility,
} from './element-visibility';
import {
  mediaQuery,
  prefersDarkMode,
  prefersReducedMotion,
} from './media-query';
import {
  type MousePositionOptions,
  type MousePositionSignal,
  mousePosition,
} from './mouse-position';
import { type NetworkStatusSignal, networkStatus } from './network-status';
import { pageVisibility } from './page-visibility';
import {
  type ScrollPositionOptions,
  type ScrollPositionSignal,
  scrollPosition,
} from './scroll-position';
import {
  type WindowSizeOptions,
  type WindowSizeSignal,
  windowSize,
} from './window-size';

type SensorTypedOptions = {
  elementVisibility: {
    opt: BaseElementVisibilityOptions & {
      target?:
        | ElementRef<Element>
        | Element
        | Signal<ElementRef<Element> | Element | null>;
    };
    returnType: ElementVisibilitySignal;
  };
  elementSize: {
    opt: BaseElementSizeOptions & {
      target?:
        | ElementRef<Element>
        | Element
        | Signal<ElementRef<Element> | Element | null>;
    };
    returnType: ElementSizeSignal;
  };
  mousePosition: {
    opt: MousePositionOptions;
    returnType: MousePositionSignal;
  };
  networkStatus: {
    opt: { debugName?: string };
    returnType: NetworkStatusSignal;
  };
  pageVisibility: {
    opt: { debugName?: string };
    returnType: Signal<DocumentVisibilityState>;
  };
  darkMode: {
    opt: { debugName?: string };
    returnType: Signal<boolean>;
  };
  reducedMotion: {
    opt: { debugName?: string };
    returnType: Signal<boolean>;
  };
  scrollPosition: {
    opt: ScrollPositionOptions;
    returnType: ScrollPositionSignal;
  };
  windowSize: {
    opt: WindowSizeOptions;
    returnType: WindowSizeSignal;
  };
  mediaQuery: {
    opt: { query: string; debugName?: string };
    returnType: Signal<boolean>;
  };
};

/**
 * Creates a sensor signal that the elements visiblity within the viewport
 * @param type Must be `'elementVisibility'`.
 * @param options Optional configuration IntersectionObserver & target.
 * @returns A `ElementVisibilitySignal` that tracks whether the Element is intersected.
 * @see {elementVisibility} for detailed documentation and examples.
 * @example const pos = sensor('elementVisibility');
 */
export function sensor(
  type: 'elementVisibility',
  options?: SensorTypedOptions['elementVisibility']['opt'],
): ElementVisibilitySignal;

/**
 * Creates a sensor signal that tracks the element's size dimensions.
 * @param type Must be `'elementSize'`.
 * @param options Optional configuration ResizeObserver & target.
 * @returns A `ElementSizeSignal` that tracks the element's size ({ width, height }).
 * @see {elementSize} for detailed documentation and examples.
 * @example const size = sensor('elementSize');
 */
export function sensor(
  type: 'elementSize',
  options?: SensorTypedOptions['elementSize']['opt'],
): ElementSizeSignal;

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
  options?: SensorTypedOptions['mousePosition']['opt'],
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
  options?: SensorTypedOptions['networkStatus']['opt'],
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
  options?: SensorTypedOptions['pageVisibility']['opt'],
): Signal<DocumentVisibilityState>;

/**
 * Creates a sensor signal that tracks the user's OS/browser preference for a dark color scheme.
 * @param type Must be `'darkMode'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `Signal<boolean>` which is `true` if a dark theme is preferred.
 * @see {prefersDarkMode} for detailed documentation and examples.
 * @example const isDarkMode = sensor('dark-mode');
 */
export function sensor(
  type: 'darkMode' | 'dark-mode',
  options?: SensorTypedOptions['darkMode']['opt'],
): Signal<boolean>;

/**
 * Creates a sensor signal that tracks the user's OS/browser preference for reduced motion.
 * @param type Must be `'reducedMotion'`.
 * @param options Optional configuration, currently only `debugName`.
 * @returns A `Signal<boolean>` which is `true` if reduced motion is preferred.
 * @see {prefersReducedMotion} for detailed documentation and examples.
 * @example const wantsReducedMotion = sensor('reduced-motion');
 */
export function sensor(
  type: 'reducedMotion' | 'reduced-motion',
  options?: SensorTypedOptions['reducedMotion']['opt'],
): Signal<boolean>;

/**
 * Creates a sensor signal that tracks the provided media query.
 * @param type Must be `'mediaQuery'`.
 * @param options Optional configuration for the media query sensor, including `query` and `debugName`.
 * @returns A `Signal<boolean>` which is `true` if the media query currently matches.
 * @see {mediaQuery} for detailed documentation and examples.
 * @example const isDesktop = sensor('mediaQuery', { query: '(min-width: 1024px)' });
 */
export function sensor(
  type: 'mediaQuery',
  options?: SensorTypedOptions['mediaQuery']['opt'],
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
  options?: SensorTypedOptions['windowSize']['opt'],
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
  options?: SensorTypedOptions['scrollPosition']['opt'],
): ScrollPositionSignal;

/**
 * Implementation for sensor overloads.
 * Users should refer to the specific overloads for detailed documentation.
 * @internal
 */
export function sensor<const TType extends keyof SensorTypedOptions>(
  type: TType | 'dark-mode' | 'reduced-motion',
  options?: SensorTypedOptions[TType]['opt'],
): SensorTypedOptions[TType]['returnType'] {
  switch (type) {
    case 'mousePosition':
      return mousePosition(options as MousePositionOptions);
    case 'networkStatus':
      return networkStatus(options?.debugName);
    case 'pageVisibility':
      return pageVisibility(options?.debugName);
    case 'darkMode':
    case 'dark-mode':
      return prefersDarkMode(options?.debugName);
    case 'reducedMotion':
    case 'reduced-motion':
      return prefersReducedMotion(options?.debugName);
    case 'mediaQuery': {
      const opt = options as SensorTypedOptions['mediaQuery']['opt'];
      return mediaQuery(opt.query, opt.debugName);
    }
    case 'windowSize':
      return windowSize(options);
    case 'scrollPosition':
      return scrollPosition(options as ScrollPositionOptions);
    case 'elementVisibility': {
      const opt = options as SensorTypedOptions['elementVisibility']['opt'];
      return elementVisibility(opt.target, opt);
    }
    case 'elementSize': {
      const opt = options as SensorTypedOptions['elementSize']['opt'];
      return elementSize(opt.target, opt);
    }
    default:
      throw new Error(`Unknown sensor type: ${type}`);
  }
}

type SensorsOptions<TKey extends keyof SensorTypedOptions> = {
  [K in TKey]: SensorTypedOptions[K]['opt'];
};

type Sensors<TKey extends keyof SensorTypedOptions> = {
  [K in TKey]: SensorTypedOptions[K]['returnType'];
};

export function sensors<const TType extends keyof SensorTypedOptions>(
  track: TType[],
  opt?: SensorsOptions<TType>,
): Sensors<TType> {
  return track.reduce((result, key) => {
    result[key] = sensor(key as any, opt?.[key]);
    return result;
  }, {} as Sensors<TType>);
}
