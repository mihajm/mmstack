/**
 * Pure gesture pipelines — the whole of a canvas move/resize/rotate frame as
 * plain functions of (start snapshot, delta, modifiers). The reactive layer
 * derives its overlay from these; nothing here reads a signal or the DOM, so
 * every UX rule (axis lock, aspect lock, grid, snaplines, bounds) is
 * exhaustively unit-testable.
 */

import type { Point } from '../sortable/geometry';
import {
  clamp,
  clampBox,
  snapToGrid,
  type Box,
  type GridSpec,
} from './geometry';
import { snapResizeBox, snapToTargets, type Guide } from './snap';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const NO_GUIDES: readonly Guide[] = [];

export type ResolveMoveConfig = {
  /** Snap the position to a grid. */
  grid?: GridSpec;
  /** Clamp the (union) box within these bounds. */
  bounds?: Box;
  /** Sibling boxes to snap edges/centers against (snaplines). */
  targets?: readonly Box[];
  /** Alignment snap distance, canvas-space. @default 6 */
  threshold?: number;
  /** Also snap against the `bounds` edges. */
  snapToCanvas?: boolean;
  /** Lock movement to the dominant axis (Shift held). */
  lockAxis?: boolean;
  /** Bypass grid and alignment snapping (Ctrl held). */
  bypassSnap?: boolean;
};

/**
 * One move frame: `base` (the dragged selection's union box, captured at
 * gesture start) plus the pointer `delta`, through axis lock → grid →
 * snaplines → bounds. Returns the resolved box and the guides to render.
 * Per-item positions follow from the resolved origin delta.
 */
export function resolveMove(
  base: Box,
  delta: Point,
  cfg: ResolveMoveConfig = {},
): { box: Box; guides: readonly Guide[] } {
  let dx = delta.x;
  let dy = delta.y;
  if (cfg.lockAxis) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }

  let origin: Point = { x: base.x + dx, y: base.y + dy };
  if (cfg.grid && !cfg.bypassSnap) origin = snapToGrid(origin, cfg.grid);

  let box: Box = { ...base, x: origin.x, y: origin.y };
  let guides: readonly Guide[] = NO_GUIDES;
  if (cfg.targets?.length && !cfg.bypassSnap) {
    const snapped = snapToTargets(
      box,
      cfg.targets,
      cfg.threshold ?? 6,
      cfg.snapToCanvas ? cfg.bounds : undefined,
    );
    box = snapped.box;
    guides = snapped.guides.length ? snapped.guides : NO_GUIDES;
  }

  if (cfg.bounds) box = clampBox(box, cfg.bounds);
  return { box, guides };
}

export type ApplyResizeConfig = {
  grid?: GridSpec;
  min?: { width?: number; height?: number };
  max?: { width?: number; height?: number };
  bounds?: Box;
  /** Mirror the delta to the opposite edge — resize around the center (Alt). */
  fromCenter?: boolean;
  /** Width/height ratio to hold (Shift) — pass `base.width / base.height`. */
  aspect?: number;
};

/**
 * Pure: applies a drag `delta` to `base` for the given handle, with
 * center-mirroring, aspect lock, grid, min/max and bounds — in that order.
 * Aspect holds through the grid snap (the driven axis snaps, the other
 * follows the ratio); min/max clamping wins over the ratio at the extremes.
 */
export function applyResize(
  base: Box,
  direction: ResizeDirection,
  delta: Point,
  cfg: ApplyResizeConfig = {},
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

  if (cfg.fromCenter) {
    if (hasE) left = base.x - delta.x;
    if (hasW) right = base.x + base.width - delta.x;
    if (hasS) top = base.y - delta.y;
    if (hasN) bottom = base.y + base.height - delta.y;
  }

  if (cfg.grid) {
    const snapped = snapToGrid({ x: left, y: top }, cfg.grid);
    const snappedFar = snapToGrid({ x: right, y: bottom }, cfg.grid);
    if (hasW || (cfg.fromCenter && hasE)) left = snapped.x;
    if (hasN || (cfg.fromCenter && hasS)) top = snapped.y;
    if (hasE || (cfg.fromCenter && hasW)) right = snappedFar.x;
    if (hasS || (cfg.fromCenter && hasN)) bottom = snappedFar.y;
  }

  if (cfg.aspect && cfg.aspect > 0) {
    const xDriven = hasE || hasW;
    const yDriven = hasS || hasN;
    // corners: the axis the pointer moved most drives; edges: the handle's axis
    const widthDrives =
      xDriven && yDriven
        ? Math.abs(delta.x) >= Math.abs(delta.y)
        : xDriven;
    if (widthDrives) {
      const h = (right - left) / cfg.aspect;
      if (cfg.fromCenter || !yDriven) {
        const mid = (top + bottom) / 2;
        top = mid - h / 2;
        bottom = mid + h / 2;
      } else if (hasN) {
        top = bottom - h;
      } else {
        bottom = top + h;
      }
    } else {
      const w = (bottom - top) * cfg.aspect;
      if (cfg.fromCenter || !xDriven) {
        const mid = (left + right) / 2;
        left = mid - w / 2;
        right = mid + w / 2;
      } else if (hasW) {
        left = right - w;
      } else {
        right = left + w;
      }
    }
  }

  const minW = cfg.min?.width ?? 0;
  const minH = cfg.min?.height ?? 0;
  const maxW = cfg.max?.width ?? Infinity;
  const maxH = cfg.max?.height ?? Infinity;

  let width = clamp(right - left, minW, maxW);
  let height = clamp(bottom - top, minH, maxH);
  // re-anchor the stationary edge after clamping
  if (hasW && !cfg.fromCenter) left = right - width;
  else if (cfg.fromCenter) {
    const midX = (left + right) / 2;
    left = midX - width / 2;
    right = midX + width / 2;
  } else right = left + width;
  if (hasN && !cfg.fromCenter) top = bottom - height;
  else if (cfg.fromCenter) {
    const midY = (top + bottom) / 2;
    top = midY - height / 2;
    bottom = midY + height / 2;
  } else bottom = top + height;

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

export type ResolveResizeConfig = ApplyResizeConfig & {
  /** Sibling boxes to snap the moving edges against. */
  targets?: readonly Box[];
  /** Alignment snap distance, canvas-space. @default 6 */
  threshold?: number;
  /** Also snap against the `bounds` edges. */
  snapToCanvas?: boolean;
  /** Bypass grid and alignment snapping (Ctrl held). */
  bypassSnap?: boolean;
};

/**
 * One resize frame: {@link applyResize} plus edge snaplines against sibling
 * boxes, re-clamped so the snap can't violate min/max/bounds.
 */
export function resolveResize(
  base: Box,
  direction: ResizeDirection,
  delta: Point,
  cfg: ResolveResizeConfig = {},
): { box: Box; guides: readonly Guide[] } {
  const { targets, threshold, snapToCanvas, bypassSnap, ...apply } = cfg;
  let box = applyResize(base, direction, delta, {
    ...apply,
    grid: bypassSnap ? undefined : apply.grid,
  });

  let guides: readonly Guide[] = NO_GUIDES;
  // an aspect-locked resize skips edge snapping: a single snapped edge would
  // silently break the held ratio
  if (targets?.length && !bypassSnap && !apply.aspect) {
    const snapped = snapResizeBox(
      box,
      direction,
      targets,
      threshold ?? 6,
      snapToCanvas ? apply.bounds : undefined,
    );
    guides = snapped.guides.length ? snapped.guides : NO_GUIDES;
    // re-clamp the snapped box to min/max/bounds (zero-delta pass)
    box = applyResize(snapped.box, direction, { x: 0, y: 0 }, {
      min: apply.min,
      max: apply.max,
      bounds: apply.bounds,
    });
  }

  return { box, guides };
}

const DEG = 180 / Math.PI;

/** Angle of `p` around `center`, degrees in (-180, 180]. */
export function angleOf(p: Point, center: Point): number {
  return Math.atan2(p.y - center.y, p.x - center.x) * DEG;
}

/** Normalizes an angle into [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * One rotate frame: the base angle plus how far the pointer has swept around
 * the pivot since gesture start, snapped to `snap`-degree increments while
 * `snapActive`, normalized to [0, 360).
 */
export function resolveRotate(
  baseAngle: number,
  startPointerAngle: number,
  pointer: Point,
  pivot: Point,
  cfg: { snap?: number; snapActive?: boolean } = {},
): number {
  let next = baseAngle + (angleOf(pointer, pivot) - startPointerAngle);
  if (cfg.snap && cfg.snapActive) {
    next = Math.round(next / cfg.snap) * cfg.snap;
  }
  return normalizeAngle(next);
}
