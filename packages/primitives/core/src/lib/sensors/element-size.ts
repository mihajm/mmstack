import { isServer } from '../platform';
import {
  computed,
  effect,
  ElementRef,
  inject,
  isSignal,
  signal,
  type Signal,
  untracked,
} from '@angular/core';
import { runInSensorContext, type SensorRunOptions } from './sensor-options';

/**
 * Represents the size of an element.
 */
export type ElementSize = {
  width: number;
  height: number;
};

/**
 * Options for configuring the `elementSize` sensor.
 */
export type ElementSizeOptions = ResizeObserverOptions & SensorRunOptions;

function observerSupported() {
  return typeof ResizeObserver !== 'undefined';
}

export type ElementSizeSignal = Signal<ElementSize | undefined>;

function isVerticalWritingMode(el: Element): boolean {
  if (typeof getComputedStyle !== 'function') return false;
  const mode = getComputedStyle(el).writingMode ?? '';
  return mode.startsWith('vertical') || mode.startsWith('sideways');
}

// ResizeObserver sizes are logical: inline is the vertical axis in vertical writing modes.
function toPhysical(size: ResizeObserverSize, vertical: boolean): ElementSize {
  return vertical
    ? { width: size.blockSize, height: size.inlineSize }
    : { width: size.inlineSize, height: size.blockSize };
}

function toDevicePixels(size: ElementSize): ElementSize {
  const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return {
    width: Math.round(size.width * ratio),
    height: Math.round(size.height * ratio),
  };
}

function measure(
  el: Element,
  box: ResizeObserverBoxOptions,
): ElementSize | undefined {
  if (!el.getBoundingClientRect) return undefined;
  const rect = el.getBoundingClientRect();
  if (box === 'border-box' || typeof getComputedStyle !== 'function')
    return { width: rect.width, height: rect.height };

  const style = getComputedStyle(el);
  const px = (value: string) => parseFloat(value) || 0;
  const content = {
    width: Math.max(
      0,
      rect.width -
        px(style.paddingLeft) -
        px(style.paddingRight) -
        px(style.borderLeftWidth) -
        px(style.borderRightWidth),
    ),
    height: Math.max(
      0,
      rect.height -
        px(style.paddingTop) -
        px(style.paddingBottom) -
        px(style.borderTopWidth) -
        px(style.borderBottomWidth),
    ),
  };
  return box === 'device-pixel-content-box' ? toDevicePixels(content) : content;
}

/**
 * Creates a read-only signal that tracks the size of a target DOM element.
 *
 * By default, it observes the `border-box` size. A synchronous initial value is
 * measured with `getBoundingClientRect()` (minus padding and border for the content
 * boxes), so it includes CSS transforms until the first observer callback replaces it.
 * Sizes are physical (`width` is horizontal) in every writing mode. With
 * `box: 'device-pixel-content-box'` the size is in device pixels.
 *
 * @param target The DOM element (or `ElementRef`, or a `Signal` resolving to one) to observe.
 * @param options Optional configuration including `box` (defaults to 'border-box') and `debugName`.
 * @returns A `Signal<ElementSize | undefined>`.
 *
 * @example
 * ```ts
 * const size = elementSize(elementRef);
 * effect(() => {
 *   console.log('Size:', size()?.width, size()?.height);
 * });
 * ```
 */
export function elementSize(
  target?:
    | ElementRef<Element>
    | Element
    | Signal<ElementRef<Element> | Element | null>,
  opt?: ElementSizeOptions,
): ElementSizeSignal {
  return runInSensorContext(opt?.injector, () =>
    // the host-element default must resolve INSIDE the sensor context
    createElementSize(target ?? inject(ElementRef), opt),
  );
}

function createElementSize(
  target:
    | ElementRef<Element>
    | Element
    | Signal<ElementRef<Element> | Element | null>,
  opt?: ElementSizeOptions,
): ElementSizeSignal {
  const getElement = (): Element | null => {
    if (isSignal(target)) {
      try {
        const val = target();
        return val instanceof ElementRef ? val.nativeElement : val;
      } catch {
        return null;
      }
    }
    return target instanceof ElementRef ? target.nativeElement : target;
  };

  const boxOption = opt?.box ?? 'border-box';

  const resolveInitialValue = (): ElementSize | undefined => {
    // measuring needs only getBoundingClientRect — ResizeObserver support gates
    // live updates, not the initial read
    const el = getElement();
    return el ? measure(el, boxOption) : undefined;
  };

  if (isServer()) {
    return computed(() => untracked(resolveInitialValue), {
      debugName: opt?.debugName,
    });
  }

  const state = signal<ElementSize | undefined>(
    untracked(resolveInitialValue),
    {
      debugName: opt?.debugName,
      equal: (a, b) => a?.width === b?.width && a?.height === b?.height,
    },
  );

  const targetSignal = isSignal(target) ? target : computed(() => target);

  effect((cleanup) => {
    const el = targetSignal();
    if (!el) {
      untracked(() => state.set(undefined));
      return;
    }
    const nativeEl = el instanceof ElementRef ? el.nativeElement : el;
    untracked(() => state.set(measure(nativeEl, boxOption)));

    if (!observerSupported()) return;

    const observer = new ResizeObserver(([entry]) => {
      const sizes =
        boxOption === 'border-box'
          ? entry.borderBoxSize
          : boxOption === 'content-box'
            ? entry.contentBoxSize
            : entry.devicePixelContentBoxSize;

      if (sizes?.length > 0) {
        state.set(toPhysical(sizes[0], isVerticalWritingMode(nativeEl)));
        return;
      }

      const rect = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      state.set(
        boxOption === 'device-pixel-content-box' ? toDevicePixels(rect) : rect,
      );
    });

    observer.observe(nativeEl, { box: boxOption });

    cleanup(() => observer.disconnect());
  });

  return state.asReadonly();
}
