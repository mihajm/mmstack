/**
 * Pure spanning-grid layout — no Angular, no DOM. Items occupy cell rects on
 * a fixed-column grid (the react-grid-layout / dashboard model); these
 * functions turn "move/resize item to cell" into a full collision-free,
 * compacted layout, expressed as plain functions so the reflow is exhaustively
 * unit-testable without a browser.
 *
 * Contracts that the reactive layer builds on:
 * - **Input order is preserved.** Results are never re-sorted, so a keyed
 *   `@for` and a per-index array diff (op-log) both see minimal change.
 * - **Identity is preserved.** An item whose placement didn't change is the
 *   same object reference in the result; a call that changes nothing returns
 *   the SAME array reference — signal equality then swallows the write.
 */

/** The cell rect an item occupies: column/row origin plus spans, all in cells. */
export type GridPlacement = {
  /** Column (cells from the left, 0-based). */
  readonly x: number;
  /** Row (cells from the top, 0-based). */
  readonly y: number;
  /** Width in cells (≥ 1). */
  readonly w: number;
  /** Height in cells (≥ 1). */
  readonly h: number;
};

/** Do two cell rects overlap? Pure geometry — identity is the caller's concern. */
export function gridCollides(a: GridPlacement, b: GridPlacement): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function collidesAny(
  rect: GridPlacement,
  placed: readonly GridPlacement[],
): boolean {
  for (const p of placed) if (gridCollides(rect, p)) return true;
  return false;
}

/** Deepest bottom edge among placed rects overlapping `rect`'s columns and above-or-at it. */
function pushedY(rect: GridPlacement, placed: readonly GridPlacement[]): number {
  let y = rect.y;
  let moved = true;
  while (moved) {
    moved = false;
    for (const p of placed) {
      if (gridCollides({ ...rect, y }, p)) {
        y = p.y + p.h;
        moved = true;
      }
    }
  }
  return y;
}

/**
 * Gravity: pulls every item up as far as it can go without colliding, in
 * top-to-bottom, left-to-right order. `fixedKey` stays at its row (the item
 * the user is actively dragging). Preserves input order, item type, and the
 * identity of items that didn't move.
 */
export function compactGrid<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  fixedKey?: K,
): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: GridPlacement[] = [];
  const newY = new Map<K, number>();
  for (const it of sorted) {
    if (fixedKey !== undefined && key(it) === fixedKey) {
      placed.push(it);
      newY.set(key(it), it.y);
      continue;
    }
    let y = it.y;
    while (y > 0 && !collidesAny({ ...it, y: y - 1 }, placed)) y--;
    placed.push(y === it.y ? it : { ...it, y });
    newY.set(key(it), y);
  }
  let changed = false;
  const out = items.map((it) => {
    const y = newY.get(key(it));
    if (y === undefined || y === it.y) return it;
    changed = true;
    return { ...it, y };
  });
  return changed ? out : (items as T[]);
}

/**
 * Resolve overlaps against an immovable `fixed` item: the fixed item settles
 * FIRST (it wins its cell even against items that started above it), then a
 * top-to-bottom sweep pushes every colliding item straight down below the
 * already-settled set. One pass, provably collision-free. Preserves order +
 * identity.
 */
function resolveDown<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  fixedKey: K,
): T[] {
  const order = [...items].sort((a, b) => {
    if (key(a) === fixedKey) return -1;
    if (key(b) === fixedKey) return 1;
    return a.y - b.y || a.x - b.x;
  });
  const placed: GridPlacement[] = [];
  const newY = new Map<K, number>();
  for (const it of order) {
    if (key(it) === fixedKey) {
      placed.push(it);
      newY.set(key(it), it.y);
      continue;
    }
    const y = pushedY(it, placed);
    placed.push(y === it.y ? it : { ...it, y });
    newY.set(key(it), y);
  }
  let changed = false;
  const out = items.map((it) => {
    const y = newY.get(key(it));
    if (y === undefined || y === it.y) return it;
    changed = true;
    return { ...it, y };
  });
  return changed ? out : (items as T[]);
}

/**
 * Moves item `k` to cell `(x, y)` (clamped into the column count), pushing
 * colliding items straight down to make room, then compacting upward with the
 * moved item held fixed — the dashboard reflow. Returns the same array
 * reference when the move changes nothing.
 */
export function moveGridItem<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  k: K,
  x: number,
  y: number,
  cols: number,
): T[] {
  const target = items.find((i) => key(i) === k);
  if (!target) return items as T[];

  const nx = Math.max(0, Math.min(x, cols - target.w));
  const ny = Math.max(0, y);
  if (nx === target.x && ny === target.y) return items as T[];

  const moved = items.map((i) =>
    key(i) === k ? { ...i, x: nx, y: ny } : i,
  );
  return compactGrid(resolveDown(moved, key, k), key, k);
}

/**
 * Resolves item `k` AT ITS CURRENT cell: pushes whatever collides with it
 * down and compacts, holding `k` fixed. {@link moveGridItem} without the
 * same-cell short-circuit — for placing an item that was just added to the
 * array at its target position (a cross-container arrival).
 */
export function placeGridItem<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  k: K,
): T[] {
  const target = items.find((i) => key(i) === k);
  if (!target) return items as T[];
  return compactGrid(resolveDown(items, key, k), key, k);
}

/**
 * Resizes item `k` to `(w, h)` cells (clamped: spans ≥ 1, right edge within
 * the column count), pushing displaced items down and compacting — the same
 * reflow as {@link moveGridItem}, driven from the size side.
 */
export function resizeGridItem<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  k: K,
  w: number,
  h: number,
  cols: number,
): T[] {
  const target = items.find((i) => key(i) === k);
  if (!target) return items as T[];

  const nw = Math.max(1, Math.min(w, cols - target.x));
  const nh = Math.max(1, h);
  if (nw === target.w && nh === target.h) return items as T[];

  const resized = items.map((i) =>
    key(i) === k ? { ...i, w: nw, h: nh } : i,
  );
  return compactGrid(resolveDown(resized, key, k), key, k);
}

/**
 * Whether item `k` could occupy the rect `(x, y, w, h)` without moving anyone
 * else: in bounds and overlapping no other item. This is the no-reflow
 * validity used by `compact: 'none'` grids (the form-builder model), where an
 * invalid cell REJECTS the move instead of pushing neighbours away.
 */
export function canPlaceAt<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  k: K,
  x: number,
  y: number,
  w: number,
  h: number,
  cols: number,
): boolean {
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > cols) return false;
  const rect = { x, y, w, h };
  for (const other of items) {
    if (key(other) === k) continue;
    if (gridCollides(rect, other)) return false;
  }
  return true;
}

/**
 * The validity mask for moving item `k` (at its current spans) anywhere on a
 * `cols` × `rows` grid: `mask[y * cols + x]` is 1 when {@link canPlaceAt}
 * accepts that origin. The first-party form of GridState's `validMoveTargets`;
 * drop-cell affordances are rendered by the consumer from this.
 */
export function validTargets<T extends GridPlacement, K>(
  items: readonly T[],
  key: (item: T) => K,
  k: K,
  cols: number,
  rows: number,
): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  const target = items.find((i) => key(i) === k);
  if (!target) return mask;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (canPlaceAt(items, key, k, x, y, target.w, target.h, cols)) {
        mask[y * cols + x] = 1;
      }
    }
  }
  return mask;
}

/** Number of rows the layout occupies (the max bottom edge). */
export function gridRows(items: readonly GridPlacement[]): number {
  let rows = 0;
  for (const i of items) if (i.y + i.h > rows) rows = i.y + i.h;
  return rows;
}
