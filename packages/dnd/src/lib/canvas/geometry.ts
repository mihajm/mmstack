/**
 * Pure free-form canvas geometry — no Angular, no DOM. Boxes and frames live
 * in CANVAS space (the space items are positioned in); projection to and from
 * the viewport is the `CanvasSpace` transform's job, applied by callers.
 */

export type { Point } from '../sortable/geometry';
import type { Point } from '../sortable/geometry';

/** An axis-aligned rectangle: origin plus size, in canvas coordinates. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The transformable state of a canvas item: its box plus an optional rotation
 * (degrees, clockwise, around the box center). This is the shape the canvas
 * reads via the `frame` lens and writes back via the `patch` lens.
 */
export type CanvasFrame = Box & { readonly rotation?: number };

/** Grid spacing for snapping. `size` is uniform or per-axis; `offset` shifts the grid origin. */
export type GridSpec = {
  size: number | { x: number; y: number };
  offset?: Point;
};

function axis(size: GridSpec['size']): { x: number; y: number } {
  return typeof size === 'number' ? { x: size, y: size } : size;
}

/** The grid's x step (used as the default keyboard nudge). */
export function gridStep(g: GridSpec | undefined): number {
  if (!g) return 1;
  return typeof g.size === 'number' ? g.size : g.size.x;
}

/** Snaps a point to the nearest grid intersection. Pure. */
export function snapToGrid(point: Point, grid: GridSpec): Point {
  const { x: sx, y: sy } = axis(grid.size);
  const ox = grid.offset?.x ?? 0;
  const oy = grid.offset?.y ?? 0;
  return {
    x: sx > 0 ? Math.round((point.x - ox) / sx) * sx + ox : point.x,
    y: sy > 0 ? Math.round((point.y - oy) / sy) * sy + oy : point.y,
  };
}

/** Builds a normalized (non-negative width/height) box from two corner points. */
export function normalizeRect(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Axis-aligned bounding-box overlap test. */
export function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Whether `inner` lies fully within `outer`. */
export function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Whether a point lies within a box (edges inclusive). */
export function boxContainsPoint(box: Box, x: number, y: number): boolean {
  return (
    x >= box.x &&
    x <= box.x + box.width &&
    y >= box.y &&
    y <= box.y + box.height
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Clamps a point so it stays within `bounds`. */
export function clampPoint(point: Point, bounds: Box): Point {
  return {
    x: clamp(point.x, bounds.x, bounds.x + bounds.width),
    y: clamp(point.y, bounds.y, bounds.y + bounds.height),
  };
}

/** Clamps a box so it stays fully within `bounds` (size preserved where possible). */
export function clampBox(box: Box, bounds: Box): Box {
  const x = clamp(box.x, bounds.x, bounds.x + bounds.width - box.width);
  const y = clamp(box.y, bounds.y, bounds.y + bounds.height - box.height);
  return { x, y, width: box.width, height: box.height };
}

/** The bounding box of a set of boxes (`null` for an empty set). */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
