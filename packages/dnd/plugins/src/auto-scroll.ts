import { isDevMode } from '@angular/core';
import type { AutoScrollPlugin, Axis } from '@mmstack/dnd';

/**
 * Nearest ancestor (incl. `el`) that scrolls on `axis`; falls back to the page.
 * The body counts only when `html` clips its overflow: otherwise the body's
 * overflow propagates to the viewport and the page scroller is the one to move.
 */
function scrollParentOf(el: HTMLElement, axis: Axis): HTMLElement {
  const overflow = axis === 'y' ? 'overflowY' : 'overflowX';
  const scrolls = (node: HTMLElement): boolean => {
    const o = getComputedStyle(node)[overflow as 'overflowY'];
    const canScroll =
      axis === 'y'
        ? node.scrollHeight > node.clientHeight
        : node.scrollWidth > node.clientWidth;
    return (o === 'auto' || o === 'scroll') && canScroll;
  };
  const html = document.documentElement;
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node !== html) {
    if (scrolls(node)) return node;
    node = node.parentElement;
  }
  if (node === document.body) {
    const ho = getComputedStyle(html)[overflow as 'overflowY'];
    if (ho && ho !== 'visible' && scrolls(node)) return node;
  }
  return (document.scrollingElement as HTMLElement) ?? html;
}

/**
 * The extra context the reorderable engines pass to {@link edgeAutoScroll} through
 * the {@link AutoScrollPlugin} args. A pragmatic auto-scroll plugin simply ignores
 * these (it self-drives from its own drag monitor); `edgeAutoScroll` needs them.
 */
export type EdgeAutoScrollContext = {
  /** Scroll axis. @default 'y' */
  axis?: Axis;
  /** Live pointer accessor (viewport coords) — the loop reads it each frame. */
  pointer?: () => { x: number; y: number };
  /**
   * Max engage band in px — the band is `min(edgeProportion · containerExtent, edge)`,
   * so it shrinks proportionally on small containers and caps out on large ones. @default 48
   */
  edge?: number;
  /** Engage band as a fraction of the scroll container's extent, capped at `edge`. @default 0.25 */
  edgeProportion?: number;
  /** Max scroll speed in px per 60fps frame (scroll is time-based, so this is frame-rate independent). @default 16 */
  speed?: number;
  /**
   * Fraction of the band at which max speed is reached — full speed BEFORE the true
   * edge, then held, so a fast drag isn't slow right where it matters. `(0, 1]`. @default 0.5
   */
  maxSpeedAt?: number;
  /** Reports main-axis scroll travelled since start — for the collision's scroll compensation. */
  onScroll?: (delta: number) => void;
};

// A dev hint, not app state: once per page load is enough.
let warnedNoPointer = false;
function warnNoPointer(): void {
  if (warnedNoPointer || !isDevMode()) return;
  warnedNoPointer = true;
  console.warn(
    "edgeAutoScroll: called without a `pointer`, so it does nothing. The reorderable, placement grid and canvas engines pass one; `autoScroll()` / `mmAutoScroll` do not, so register pragmatic's `autoScrollForElements` for those.",
  );
}

/**
 * A zero-dependency edge auto-scroll {@link AutoScrollPlugin}: while active, scroll
 * the nearest scroll parent when the pointer nears its leading/trailing edge. rAF-
 * driven, engine-agnostic — the pointer engine's default and a native fallback that
 * needs no pragmatic sub-package. Details:
 * - **Time-based** — speed is px/second (scaled by the real frame delta, capped at
 *   one 60fps step), so it's frame-rate independent.
 * - **Real scroll limits** — engages only if the container can actually scroll that
 *   way (`scrollTop`/`scrollHeight`), so a self-scrolling element works too.
 * - **Proportional band** (`min(edgeProportion·size, edge)`) with max speed reached
 *   before the true edge (`maxSpeedAt`), and a ~400ms ease-in from engagement.
 *
 * It requires a pointer-fed context ({@link EdgeAutoScrollContext}), which the
 * reorderable engines supply; used without one (e.g. the bare `mmAutoScroll`
 * directive, which is meant for pragmatic's monitor-driven auto-scroll) it no-ops,
 * with a one-time warning in dev mode.
 *
 * Register via `provideDnd({ plugins: { autoScroll: edgeAutoScroll } })`.
 */
export const edgeAutoScroll: AutoScrollPlugin = (args) => {
  const element = args.element as HTMLElement;
  const {
    axis = 'y',
    pointer,
    edge = 48,
    edgeProportion = 0.25,
    speed = 16,
    maxSpeedAt = 0.5,
    onScroll,
  } = args as EdgeAutoScrollContext & { element: Element };

  if (!pointer) {
    warnNoPointer();
    return () => undefined;
  }
  if (typeof requestAnimationFrame !== 'function') return () => undefined;

  const scrollEl = scrollParentOf(element, axis);
  const scrollStart = axis === 'y' ? scrollEl.scrollTop : scrollEl.scrollLeft;
  // time-based (px/ms) so velocity is frame-rate independent.
  const perMs = (speed * 60) / 1000;

  let raf = 0;
  let last = 0;
  let first = true;
  let engagedAt: number | null = null;

  const tick = (now: number): void => {
    const dt = first ? 1000 / 60 : now - last;
    first = false;
    last = now;

    const page =
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement;
    let lo: number;
    let hi: number;
    if (page) {
      lo = 0;
      hi = axis === 'y' ? window.innerHeight : window.innerWidth;
    } else {
      const r = scrollEl.getBoundingClientRect();
      lo = axis === 'y' ? r.top : r.left;
      hi = axis === 'y' ? r.bottom : r.right;
    }
    const pos = axis === 'y' ? pointer().y : pointer().x;
    const scrollPos = axis === 'y' ? scrollEl.scrollTop : scrollEl.scrollLeft;
    const clientExtent =
      axis === 'y' ? scrollEl.clientHeight : scrollEl.clientWidth;
    const scrollExtent =
      axis === 'y' ? scrollEl.scrollHeight : scrollEl.scrollWidth;

    const band = Math.min(edgeProportion * (hi - lo), edge);
    const rampDist = band * maxSpeedAt || band; // guard maxSpeedAt = 0
    let dir = 0;
    let ramp = 0;
    if (pos < lo + band && scrollPos > 0) {
      dir = -1;
      ramp = Math.min(1, (lo + band - pos) / rampDist);
    } else if (
      pos > hi - band &&
      Math.ceil(scrollPos) + clientExtent < scrollExtent
    ) {
      dir = 1;
      ramp = Math.min(1, (pos - (hi - band)) / rampDist);
    }

    if (dir === 0) {
      engagedAt = null;
    } else {
      if (engagedAt === null) engagedAt = now;
      const dilation = Math.min(1, (now - engagedAt) / 400);
      const step = Math.min(perMs * dt, speed); // capped at one 60fps step
      const v = dir * ramp * dilation * step;
      if (axis === 'y') scrollEl.scrollTop += v;
      else scrollEl.scrollLeft += v;
    }

    onScroll?.(
      (axis === 'y' ? scrollEl.scrollTop : scrollEl.scrollLeft) - scrollStart,
    );
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => {
    if (raf) cancelAnimationFrame(raf);
  };
};
