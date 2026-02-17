import { isPlatformServer } from '@angular/common';
import {
  computed,
  effect,
  ElementRef,
  inject,
  isSignal,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';

/**
 * Options for configuring the `elementVisibility` sensor, extending
 * standard `IntersectionObserverInit` options.
 */
export type ElementVisibilityOptions = IntersectionObserverInit & {
  /** Optional debug name for the internal signal. */
  debugName?: string;
};

function observerSupported() {
  return typeof IntersectionObserver !== 'undefined';
}

type InternalElementVisibilitySignal = Signal<
  IntersectionObserverEntry | undefined
> & {
  visible: Signal<boolean>;
};

export type ElementVisibilitySignal = Signal<
  IntersectionObserverEntry | undefined
> & {
  readonly visible: Signal<boolean>;
};

/**
 * Creates a read-only signal that tracks the intersection status of a target DOM element
 * with the viewport or a specified root element, using the `IntersectionObserver` API.
 *
 * It can observe a static `ElementRef`/`Element` or a `Signal` that resolves to one,
 * allowing for dynamic targets.
 *
 * @param target The DOM element (or `ElementRef`, or a `Signal` resolving to one) to observe.
 * If the signal resolves to `null`, observation stops.
 * @param options Optional `IntersectionObserverInit` options (e.g., `root`, `rootMargin`, `threshold`)
 * and an optional `debugName`.
 * @returns A `Signal<IntersectionObserverEntry | undefined>`. It emits `undefined` initially,
 * on the server, or if the target is `null`. Otherwise, it emits the latest
 * `IntersectionObserverEntry`. Consumers can derive a boolean `isVisible` from
 * this entry's `isIntersecting` property.
 *
 * @example
 * ```ts
 * import { Component, effect, ElementRef, viewChild } from '@angular/core';
 * import { elementVisibility } from '@mmstack/primitives';
 * import { computed } from '@angular/core'; // For derived boolean
 *
 * @Component({
 * selector: 'app-lazy-image',
 * template: `
 * <div #imageContainer style="height: 200px; border: 1px dashed grey;">
 * @if (isVisible()) {
 * <img src="your-image-url.jpg" alt="Lazy loaded image" />
 * <p>Image is VISIBLE!</p>
 * } @else {
 * <p>Scroll down to see the image...</p>
 * }
 * </div>
 * `
 * })
 * export class LazyImageComponent {
 * readonly imageContainer = viewChild.required<ElementRef<HTMLDivElement>>('imageContainer');
 *
 * // Observe the element, get the full IntersectionObserverEntry
 * readonly intersectionEntry = elementVisibility(this.imageContainer);
 *
 * // Derive a simple boolean for visibility
 * readonly isVisible = computed(() => this.intersectionEntry()?.isIntersecting ?? false);
 *
 * constructor() {
 * effect(() => {
 * console.log('Intersection Entry:', this.intersectionEntry());
 * console.log('Is Visible:', this.isVisible());
 * });
 * }
 * }
 * ```
 */
export function elementVisibility(
  target:
    | ElementRef<Element>
    | Element
    | Signal<ElementRef<Element> | Element | null> = inject(ElementRef),
  opt?: ElementVisibilityOptions,
): ElementVisibilitySignal {
  if (isPlatformServer(inject(PLATFORM_ID)) || !observerSupported()) {
    const base = computed(() => undefined, {
      debugName: opt?.debugName,
    }) as InternalElementVisibilitySignal;
    base.visible = computed(() => false);
    return base;
  }

  const state = signal<IntersectionObserverEntry | undefined>(undefined, {
    debugName: opt?.debugName,
    equal: (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return (
        a.target === b.target &&
        a.isIntersecting === b.isIntersecting &&
        a.intersectionRatio === b.intersectionRatio &&
        a.boundingClientRect.top === b.boundingClientRect.top &&
        a.boundingClientRect.left === b.boundingClientRect.left &&
        a.boundingClientRect.width === b.boundingClientRect.width &&
        a.boundingClientRect.height === b.boundingClientRect.height
      );
    },
  });

  const targetSignal = isSignal(target) ? target : computed(() => target);

  effect((cleanup) => {
    const el = targetSignal();

    if (!el) return state.set(undefined);

    let observer: IntersectionObserver | null = null;
    observer = new IntersectionObserver(([entry]) => state.set(entry), opt);
    observer.observe(el instanceof ElementRef ? el.nativeElement : el);

    cleanup(() => {
      observer?.disconnect();
    });
  });

  const base = state.asReadonly() as InternalElementVisibilitySignal;
  base.visible = computed(() => {
    const s = state();
    if (!s) return false;
    return s.isIntersecting;
  });
  return base;
}
