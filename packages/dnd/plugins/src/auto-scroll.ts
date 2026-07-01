import type { AutoScrollPlugin, Axis } from '@mmstack/dnd';

/** Nearest ancestor (incl. `el`) that scrolls on `axis`; falls back to the page. */
function scrollParentOf(el: HTMLElement, axis: Axis): HTMLElement {
  const overflow = axis === 'y' ? 'overflowY' : 'overflowX';
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const o = getComputedStyle(node)[overflow as 'overflowY'];
    const canScroll =
      axis === 'y'
        ? node.scrollHeight > node.clientHeight
        : node.scrollWidth > node.clientWidth;
    if ((o === 'auto' || o === 'scroll') && canScroll) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
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
 * directive, which is meant for pragmatic's monitor-driven auto-scroll) it no-ops.
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

  if (!pointer || typeof requestAnimationFrame !== 'function')
    return () => undefined;

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
    const clientExtent = axis === 'y' ? scrollEl.clientHeight : scrollEl.clientWidth;
    const scrollExtent = axis === 'y' ? scrollEl.scrollHeight : scrollEl.scrollWidth;

    const band = Math.min(edgeProportion * (hi - lo), edge);
    const rampDist = band * maxSpeedAt || band; // guard maxSpeedAt = 0
    // Engage on real scroll limits (not list geometry) so a self-scrolling list works.
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
