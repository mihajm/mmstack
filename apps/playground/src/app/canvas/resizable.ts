import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { pointerDrag } from '@mmstack/primitives';

import type { Resolvable } from '@mmstack/dnd';
import { resolveSignal } from '@mmstack/dnd';
import { collectGuides, nearestEdge, type Guide } from './alignment';
import {
  clamp,
  snapToGrid,
  type Box,
  type GridSpec,
  type Point,
} from './geometry';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export type ResizeHandleOptions = {
  grid?: Resolvable<GridSpec | undefined>;
  min?: { width?: number; height?: number };
  max?: { width?: number; height?: number };
  bounds?: Resolvable<Box | undefined>;
  disabled?: Resolvable<boolean>;
  activationThreshold?: number;
  /** Snap resized edges to sibling boxes (alignment guides; Ctrl bypasses). */
  snapTargets?: Resolvable<readonly Box[] | undefined>;
  /** Alignment snap distance. @default 6 */
  snapThreshold?: number;
  /** Also snap edges to the `bounds`. */
  snapToCanvas?: boolean;
  onResizeStart?: (e: { box: Box }) => void;
  onResize?: (e: { box: Box }) => void;
  onResizeEnd?: (e: { box: Box }) => void;
};

export type ResizeHandleRef = {
  resizing: Signal<boolean>;
  box: Signal<Box>;
  /** Active alignment guides (snaplines) during a resize. */
  guides: Signal<readonly Guide[]>;
};

/** Pure: applies a drag `delta` to `base` for the given handle, with grid/min/max/bounds. */
export function applyResize(
  base: Box,
  direction: ResizeDirection,
  delta: Point,
  cfg: {
    grid?: GridSpec;
    min?: { width?: number; height?: number };
    max?: { width?: number; height?: number };
    bounds?: Box;
  } = {},
): Box {
  const hasE = direction.includes('e');
  const hasW = direction.includes('w');
  const hasS = direction.includes('s');
  const hasN = direction.includes('n');

  let left = base.x;
  let right = base.x + base.width;
  let top = base.y;
  let bottom = base.y + base.height;

  if (hasE) right = base.x + base.width + delta.x;
  if (hasW) left = base.x + delta.x;
  if (hasS) bottom = base.y + base.height + delta.y;
  if (hasN) top = base.y + delta.y;

  if (cfg.grid) {
    const snapped = snapToGrid({ x: left, y: top }, cfg.grid);
    const snappedFar = snapToGrid({ x: right, y: bottom }, cfg.grid);
    if (hasW) left = snapped.x;
    if (hasN) top = snapped.y;
    if (hasE) right = snappedFar.x;
    if (hasS) bottom = snappedFar.y;
  }

  const minW = cfg.min?.width ?? 0;
  const minH = cfg.min?.height ?? 0;
  const maxW = cfg.max?.width ?? Infinity;
  const maxH = cfg.max?.height ?? Infinity;

  let width = clamp(right - left, minW, maxW);
  let height = clamp(bottom - top, minH, maxH);
  // re-anchor the stationary edge after clamping
  if (hasW) left = right - width;
  else right = left + width;
  if (hasN) top = bottom - height;
  else bottom = top + height;

  if (cfg.bounds) {
    const b = cfg.bounds;
    left = Math.max(left, b.x);
    top = Math.max(top, b.y);
    right = Math.min(right, b.x + b.width);
    bottom = Math.min(bottom, b.y + b.height);
    width = right - left;
    height = bottom - top;
  }

  return { x: left, y: top, width, height };
}

/** Pure: snaps the resized (moving) edges to nearby target edges within `threshold`. */
export function snapResizeBox(
  box: Box,
  direction: ResizeDirection,
  targets: readonly Box[],
  threshold: number,
  canvas?: Box,
): { box: Box; guides: Guide[] } {
  const all = canvas ? [...targets, canvas] : [...targets];
  if (!all.length) return { box, guides: [] };

  let left = box.x;
  let right = box.x + box.width;
  let top = box.y;
  let bottom = box.y + box.height;
  const hasE = direction.includes('e');
  const hasW = direction.includes('w');
  const hasS = direction.includes('s');
  const hasN = direction.includes('n');

  const xt = all.flatMap((t) => [t.x, t.x + t.width / 2, t.x + t.width]);
  const yt = all.flatMap((t) => [t.y, t.y + t.height / 2, t.y + t.height]);

  if (hasE) {
    const s = nearestEdge(right, xt, threshold);
    if (s !== null) right = s;
  } else if (hasW) {
    const s = nearestEdge(left, xt, threshold);
    if (s !== null) left = s;
  }
  if (hasS) {
    const s = nearestEdge(bottom, yt, threshold);
    if (s !== null) bottom = s;
  } else if (hasN) {
    const s = nearestEdge(top, yt, threshold);
    if (s !== null) top = s;
  }

  const snapped: Box = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  return { box: snapped, guides: collectGuides(snapped, all) };
}

/**
 * Resizes the box `box` when dragging the host **handle** element. One handle =
 * one gesture host; render up to eight handles, each with its own
 * `resizeHandle(box, direction)`. You own `box`; the gesture writes the next box.
 * Supports grid-sized resizing (`grid`) and sibling-edge alignment (`snapTargets`,
 * exposing `ref.guides()` for the same snaplines as `movable`).
 */
export function resizeHandle(
  box: WritableSignal<Box>,
  direction: ResizeDirection,
  opts: ResizeHandleOptions = {},
): ResizeHandleRef {
  const guides = signal<readonly Guide[]>([]);

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      resizing: computed(() => false),
      box: box.asReadonly(),
      guides: guides.asReadonly(),
    };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const grid = opts.grid ? resolveSignal(opts.grid) : undefined;
  const bounds = opts.bounds ? resolveSignal(opts.bounds) : undefined;
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
  const snapTargets = opts.snapTargets
    ? resolveSignal(opts.snapTargets)
    : undefined;
  const snapThreshold = opts.snapThreshold ?? 6;

  const drag = pointerDrag({
    target: host,
    activationThreshold: opts.activationThreshold ?? 2,
  });

  const resizing = computed(
    () => drag.unthrottled().active && !(disabled?.() ?? false),
  );

  let base: Box | null = null;

  // Options read UNTRACKED — this effect depends only on the gesture.
  effect(() => {
    const d = drag.unthrottled();
    const isDisabled = untracked(() => disabled?.() ?? false);

    if (d.pointerId !== null && base === null && !isDisabled) {
      base = untracked(box);
      opts.onResizeStart?.({ box: base });
    }

    if (d.active && base && !isDisabled) {
      const b = untracked(() => bounds?.());
      let next = applyResize(base, direction, d.delta, {
        grid: d.modifiers.ctrl ? undefined : untracked(() => grid?.()),
        min: opts.min,
        max: opts.max,
        bounds: b,
      });

      const targets = untracked(() => snapTargets?.());
      if (targets?.length && !d.modifiers.ctrl) {
        const snapped = snapResizeBox(
          next,
          direction,
          targets,
          snapThreshold,
          opts.snapToCanvas ? b : undefined,
        );
        guides.set(snapped.guides);
        // re-clamp the snapped box to min/max/bounds (zero-delta pass)
        next = applyResize(
          snapped.box,
          direction,
          { x: 0, y: 0 },
          {
            min: opts.min,
            max: opts.max,
            bounds: b,
          },
        );
      } else {
        guides.set([]);
      }

      box.set(next);
      opts.onResize?.({ box: next });
    }

    if (d.pointerId === null && base !== null) {
      base = null;
      guides.set([]);
      opts.onResizeEnd?.({ box: untracked(box) });
    }
  });

  return { resizing, box: box.asReadonly(), guides: guides.asReadonly() };
}

/**
 * Thin directive wrapper for a single handle element:
 * `<div class="handle se" [mmResizeHandle]="box" direction="se">`.
 */
@Directive({
  selector: '[mmResizeHandle]',
  exportAs: 'mmResizeHandle',
})
export class ResizeHandle {
  readonly box = input.required<WritableSignal<Box>>({
    alias: 'mmResizeHandle',
  });
  readonly direction = input.required<ResizeDirection>();
  readonly grid = input<GridSpec | undefined>(undefined);
  readonly min = input<{ width?: number; height?: number } | undefined>(
    undefined,
  );
  readonly max = input<{ width?: number; height?: number } | undefined>(
    undefined,
  );
  readonly bounds = input<Box | undefined>(undefined);
  readonly snapTargets = input<readonly Box[] | undefined>(undefined);
  readonly snapToCanvas = input(false, { transform: booleanAttribute });

  private readonly injector = inject(Injector);
  private readonly _ref = signal<ResizeHandleRef | undefined>(undefined);

  readonly resizing = computed(() => this._ref()?.resizing() ?? false);
  readonly guides = computed<readonly Guide[]>(
    () => this._ref()?.guides() ?? [],
  );

  constructor() {
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          resizeHandle(this.box(), this.direction(), {
            grid: this.grid,
            min: this.min(),
            max: this.max(),
            bounds: this.bounds,
            snapTargets: this.snapTargets,
            snapToCanvas: this.snapToCanvas(),
          }),
        ),
      );
    });
  }
}
