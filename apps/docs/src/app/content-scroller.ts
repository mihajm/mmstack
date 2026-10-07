import { DOCUMENT, isPlatformBrowser, ViewportScroller } from '@angular/common';
import {
  effect,
  inject,
  PLATFORM_ID,
  type Provider,
  signal,
  untracked,
} from '@angular/core';
import { elementSize } from '@mmstack/primitives';

/**
 * The app scrolls inside `#main-content`, not the window, so the router's
 * default scroller (which only calls `window.scrollTo`) never moves anything.
 */
class ContentScroller implements ViewportScroller {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private offset: () => [number, number] = () => [0, 0];
  private stopFollowing?: () => void;

  // the routed content's box: when deferred demos render, it grows
  private readonly content = signal<Element | null>(null);
  private readonly contentSize = elementSize(this.content);
  private follow?: () => void;

  constructor() {
    effect(() => {
      this.contentSize();
      untracked(() => this.follow?.());
    });
  }

  /** The first box under the routed component that has a size of its own. */
  private routedBox(container: HTMLElement): Element | null {
    let el = [...container.children].find(
      (c) => c.tagName !== 'MM-TRANSITION-OUTLET',
    ) as Element | undefined;
    while (el && /^(inline|contents)$/.test(getComputedStyle(el).display))
      el = el.firstElementChild ?? undefined;
    return el ?? null;
  }

  private container(): HTMLElement | null {
    return this.browser ? this.document.getElementById('main-content') : null;
  }

  private smooth(): ScrollBehavior {
    const reduce = this.document.defaultView?.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    return reduce ? 'auto' : 'smooth';
  }

  setOffset(offset: [number, number] | (() => [number, number])): void {
    this.offset = Array.isArray(offset) ? () => offset : offset;
  }

  getScrollPosition(): [number, number] {
    const el = this.container();
    return el ? [el.scrollLeft, el.scrollTop] : [0, 0];
  }

  scrollToPosition(position: [number, number], options?: ScrollOptions): void {
    this.stopFollowing?.();
    this.container()?.scrollTo({
      behavior: 'instant',
      ...options,
      left: position[0],
      top: position[1],
    });
  }

  scrollToAnchor(target: string, options?: ScrollOptions): void {
    const el =
      this.document.getElementById(target) ??
      this.document.getElementsByName(target)[0];
    const container = this.container();
    if (!el || !container) return;

    this.stopFollowing?.();
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const topOf = () =>
      Math.round(
        el.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          margin -
          this.offset()[1],
      );
    const behavior = options?.behavior ?? this.smooth();

    let top = topOf();
    // a long smooth scroll crawls (and restarts as deferred demos render on
    // the way), so jump to a screen short of the target and glide the rest
    const lead = container.clientHeight;
    const gap = top - container.scrollTop;
    if (behavior === 'smooth' && Math.abs(gap) > lead * 2) {
      container.scrollTo({
        top: top - Math.sign(gap) * lead,
        behavior: 'instant',
      });
      top = topOf();
    }
    container.scrollTo({ ...options, behavior, top });
    el.focus({ preventScroll: true });

    // Deferred demos above the target render as the scroll passes them and
    // push it down: retarget whenever the content resizes, until the reader
    // scrolls on their own or the page has had time to settle.
    const win = this.document.defaultView!;
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    const timer = win.setTimeout(() => stop(), 4000);
    const stop = () => {
      win.clearTimeout(timer);
      inputs.forEach((t) => container.removeEventListener(t, stop));
      if (this.follow === retarget) this.follow = undefined;
      if (this.stopFollowing === stop) this.stopFollowing = undefined;
    };
    const retarget = () => {
      const next = topOf();
      if (Math.abs(next - top) <= 1) return;
      top = next;
      container.scrollTo({ ...options, behavior, top });
    };
    inputs.forEach((t) =>
      container.addEventListener(t, stop, { passive: true }),
    );
    this.stopFollowing = stop;
    this.follow = retarget;
    this.content.set(this.routedBox(container));
  }

  setHistoryScrollRestoration(mode: 'auto' | 'manual'): void {
    if (!this.browser) return;
    try {
      this.document.defaultView!.history.scrollRestoration = mode;
    } catch {
      // sandboxed or inactive window
    }
  }
}

export function provideContentScroller(): Provider {
  return { provide: ViewportScroller, useClass: ContentScroller };
}
