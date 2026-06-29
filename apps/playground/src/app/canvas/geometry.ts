export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** Grid spacing for snapping. `size` is uniform or per-axis; `offset` shifts the grid origin. */
export type GridSpec = {
  size: number | { x: number; y: number };
  offset?: Point;
};

function axis(size: GridSpec['size']): { x: number; y: number } {
  return typeof size === 'number' ? { x: size, y: size } : size;
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
