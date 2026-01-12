import { isPlatformServer } from '@angular/common';
import {
  computed,
  effect,
  ElementRef,
  inject,
  isSignal,
  PLATFORM_ID,
  signal,
  Signal,
  untracked,
} from '@angular/core';

/**
 * Represents the size of an element.
 */
export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Options for configuring the `elementSize` sensor.
 */
export type ElementSizeOptions = ResizeObserverOptions & {
  /** Optional debug name for the internal signal. */
  debugName?: string;
};

function observerSupported() {
  return typeof ResizeObserver !== 'undefined';
}

export type ElementSizeSignal = Signal<ElementSize | undefined>;

/**
 * Creates a read-only signal that tracks the size of a target DOM element.
 *
 * By default, it observes the `border-box` size to align with `getBoundingClientRect()`,
 * which is used to provide a synchronous initial value if possible.
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
  target:
    | ElementRef<Element>
    | Element
    | Signal<ElementRef<Element> | Element | null> = inject(ElementRef),
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

  const resolveInitialValue = (): ElementSize | undefined => {
    if (!observerSupported()) return undefined;

    const el = getElement();
    if (el && el.getBoundingClientRect) {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }
    return undefined;
  };

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return computed(() => untracked(resolveInitialValue), {
      debugName: opt?.debugName,
    });
  }

  const state = signal<ElementSize | undefined>(untracked(resolveInitialValue), {
    debugName: opt?.debugName,
    equal: (a, b) => a?.width === b?.width && a?.height === b?.height,
  });

  const targetSignal = isSignal(target) ? target : computed(() => target);

  effect((cleanup) => {
    const el = targetSignal();
    if (el) {
       const nativeEl = el instanceof ElementRef ? el.nativeElement : el;
       const rect = nativeEl.getBoundingClientRect();
       untracked(() => state.set({ width: rect.width, height: rect.height }));
    } else {
       untracked(() => state.set(undefined));
       return;
    }

    if (!observerSupported()) return;

    let observer: ResizeObserver | null = null;
    observer = new ResizeObserver(([entry]) => {
      let width = 0;
      let height = 0;

      const boxOption = opt?.box ?? 'border-box';

      if (boxOption === 'border-box' && entry.borderBoxSize?.length > 0) {
        const size = entry.borderBoxSize[0];
        width = size.inlineSize;
        height = size.blockSize;
      } else if (boxOption === 'content-box' && entry.contentBoxSize?.length > 0) {
        width = entry.contentBoxSize[0].inlineSize;
        height = entry.contentBoxSize[0].blockSize;
      } else {
        width = entry.contentRect.width;
        height = entry.contentRect.height;
      }

      state.set({ width, height });
    });

    observer.observe(el instanceof ElementRef ? el.nativeElement : el, {
      box: opt?.box ?? 'border-box',
    });

    cleanup(() => {
      observer?.disconnect();
    });
  });

  return state.asReadonly();
}
