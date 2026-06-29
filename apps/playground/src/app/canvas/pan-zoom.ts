import { isPlatformServer } from '@angular/common';
import {
  computed,
  effect,
  ElementRef,
  inject,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { pointerDrag } from '@mmstack/primitives';

import type { DragHandleLike, Resolvable } from '@mmstack/dnd';
import { resolveElement, resolveSignal } from '@mmstack/dnd';
import { clamp, type Point } from './geometry';

export type PanZoomTransform = { x: number; y: number; scale: number };

export type PanZoomOptions = {
  /** Mouse buttons that pan. @default [1] (middle) */
  panButtons?: number[];
  /** Enable wheel zoom (around the cursor). @default true */
  wheelZoom?: boolean;
  minScale?: number;
  maxScale?: number;
  /** Wheel zoom sensitivity. @default 0.0015 */
  zoomSpeed?: number;
  disabled?: Resolvable<boolean>;
};

export type PanZoomRef = {
  transform: Signal<PanZoomTransform>;
  panning: Signal<boolean>;
  /** viewport (client) point → canvas-space point. */
  toCanvas(clientPoint: Point): Point;
  /** canvas-space point → viewport (client) point. */
  toViewport(canvasPoint: Point): Point;
  reset(): void;
};

/**
 * Pan (drag, middle button by default) + zoom (wheel, around the cursor) for a
 * canvas viewport. Owns a `transform` signal and exposes
 * `toCanvas`/`toViewport` projections so nested content (and hit-testing) can
 * map between spaces.
 */
export function panZoom(
  viewport?: Resolvable<DragHandleLike | undefined>,
  opts: PanZoomOptions = {},
): PanZoomRef {
  const transform = signal<PanZoomTransform>({ x: 0, y: 0, scale: 1 });
  const reset = () => transform.set({ x: 0, y: 0, scale: 1 });

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      transform: transform.asReadonly(),
      panning: computed(() => false),
      toCanvas: (p) => p,
      toViewport: (p) => p,
      reset,
    };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const viewportSig = viewport ? resolveSignal(viewport) : undefined;
  const elSig = computed(
    () => (viewportSig ? resolveElement(viewportSig()) : host) ?? null,
  );
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;

  const {
    panButtons = [1],
    wheelZoom = true,
    minScale = 0.1,
    maxScale = 8,
    zoomSpeed = 0.0015,
  } = opts;

  const pan = pointerDrag({ target: elSig, buttons: panButtons });
  const panning = computed(
    () => pan.unthrottled().active && !(disabled?.() ?? false),
  );

  let baseT: Point | null = null;
  effect(() => {
    const d = pan.unthrottled();
    if (disabled?.()) return;
    if (d.pointerId !== null && baseT === null) {
      const t = untracked(transform);
      baseT = { x: t.x, y: t.y };
    }
    if (d.active && baseT) {
      const b = baseT;
      transform.update((t) => ({
        ...t,
        x: b.x + d.delta.x,
        y: b.y + d.delta.y,
      }));
    }
    if (d.pointerId === null && baseT !== null) baseT = null;
  });

  if (wheelZoom) {
    effect((cleanup) => {
      const el = elSig();
      if (!el) return;
      const handler = (e: WheelEvent) => {
        if (disabled?.()) return;
        e.preventDefault();
        const o = el.getBoundingClientRect();
        const localX = e.clientX - o.left;
        const localY = e.clientY - o.top;
        const t = untracked(transform);
        const nextScale = clamp(
          t.scale * Math.exp(-e.deltaY * zoomSpeed),
          minScale,
          maxScale,
        );
        // keep the canvas point under the cursor fixed
        const canvasX = (localX - t.x) / t.scale;
        const canvasY = (localY - t.y) / t.scale;
        transform.set({
          x: localX - canvasX * nextScale,
          y: localY - canvasY * nextScale,
          scale: nextScale,
        });
      };
      el.addEventListener('wheel', handler, { passive: false });
      cleanup(() => el.removeEventListener('wheel', handler));
    });
  }

  const originOf = (el: HTMLElement | null) =>
    el ? el.getBoundingClientRect() : ({ left: 0, top: 0 } as DOMRect);

  return {
    transform: transform.asReadonly(),
    panning,
    toCanvas: (p) => {
      const t = untracked(transform);
      const o = originOf(untracked(elSig));
      return {
        x: (p.x - o.left - t.x) / t.scale,
        y: (p.y - o.top - t.y) / t.scale,
      };
    },
    toViewport: (p) => {
      const t = untracked(transform);
      const o = originOf(untracked(elSig));
      return {
        x: p.x * t.scale + t.x + o.left,
        y: p.y * t.scale + t.y + o.top,
      };
    },
    reset,
  };
}
