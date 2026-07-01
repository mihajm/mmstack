/**
 * Pure sortable geometry — no Angular, no DOM. Everything the pointer engine
 * needs to turn cached layout + a pointer coordinate into an insert index and
 * per-item displacement, expressed as plain functions so it's exhaustively
 * unit-testable without a browser.
 *
 * Convention: all coordinates are along the list's *main axis* (the scroll/flow
 * direction). Callers project a rect to the axis via {@link centerAlong} et al.
 * before handing numbers to the collision functions.
 */

export type Axis = 'x' | 'y';

/** Minimal `DOMRect`-compatible shape, so tests don't construct real rects. */
export interface RectLike {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Main-axis start coordinate (`left` for x, `top` for y). */
export function startAlong(rect: RectLike, axis: Axis): number {
  return axis === 'x' ? rect.left : rect.top;
}

/** Main-axis extent (`width` for x, `height` for y). */
export function sizeAlong(rect: RectLike, axis: Axis): number {
  return axis === 'x' ? rect.width : rect.height;
}

/** Main-axis center coordinate. */
export function centerAlong(rect: RectLike, axis: Axis): number {
  return startAlong(rect, axis) + sizeAlong(rect, axis) / 2;
}

/**
 * Insert index from item center coordinates (ascending) and a pointer position:
 * the count of centers the pointer has passed. Returns `0..centers.length`.
 *
 * - **Gap-safe**: works in the dead space between items (it's a fold over
 *   centers, not a hit-test against item boxes), so the index never flickers to
 *   the end when the pointer is between two items.
 * - **Stable**: when fed centers cached at drag start, an opening gap can't feed
 *   back into the result — the input doesn't move, so neither does the index.
 *
 * A pointer exactly on a center counts as *not yet passed* (insert before it),
 * so the result is deterministic on ties.
 */
export function insertIndexFromCenters(
  centers: readonly number[],
  pos: number,
): number {
  let i = 0;
  while (i < centers.length && pos > centers[i]) i++;
  return i;
}

/**
 * Per-item displacement (main-axis px) for a source moving from index `source`
 * to final index `insert`, holding every item in flow and shifting siblings by
 * transform instead — the FLIP model dnd-kit uses.
 *
 * Each sibling between the source's old slot and the insert slot shifts by the
 * source's **footprint** (`sourceSize + gap`) toward the vacated slot — negative
 * when the source moves later, positive when it moves earlier. They all shift by
 * the same footprint because they are collectively closing the single hole the
 * source left, so this is exact for **variable-size** items too: a sibling lands
 * on its committed slot regardless of its own size (centers-of-neighbours would
 * be off by half the width/height difference — the X-axis jerk). The source and
 * any item outside the moved range get `0`.
 */
export function displacement(
  index: number,
  source: number,
  insert: number,
  footprint: number,
): number {
  if (index === source) return 0;
  if (insert > source && index > source && index <= insert) return -footprint;
  if (insert < source && index >= insert && index < source) return footprint;
  return 0;
}

/**
 * Transform-aware collision for moving-gap (FLIP) mode — the piece a plain
 * cached-center fold can't do, because the items aren't where their cached
 * centers say: they're displaced by {@link displacement} to open the gap.
 *
 * It resolves the circular dependency (insert → displacement → visual centers →
 * insert) the way dnd-kit does: the pointer is tested against the *previous*
 * frame's layout (`prevInsert`), so this frame reads a settled picture instead
 * of one that shifts as it's measured. A Schmitt-style `deadband` makes each
 * boundary sticky — a center must be cleared by `deadband` px to flip state —
 * which kills the period-2 oscillation that otherwise appears when the pointer
 * hovers on a moved item's center.
 *
 * Returns the array insert index in `[0, centers.length - 1]` (a reorder, never
 * an append): counting the non-source items whose displaced center the pointer
 * has passed maps directly to the final index, with no slot↔index off-by-one.
 * Seed `prevInsert` with the source index on the first frame of a drag.
 */
export function insertIndexTransformAware(
  centers: readonly number[],
  source: number,
  footprint: number,
  pos: number,
  prevInsert: number,
  deadband = 0,
): number {
  let k = 0;
  for (let i = 0; i < centers.length; i++) {
    if (i === source) continue;
    const othersPos = i < source ? i : i - 1;
    const vc = centers[i] + displacement(i, source, prevInsert, footprint);
    // Schmitt trigger: state flips only after the pointer clears the center by `deadband`.
    const passed =
      othersPos < prevInsert ? pos >= vc - deadband : pos > vc + deadband;
    if (passed) k++;
  }
  return k;
}

/**
 * Cross-list shift for the **source** list once the dragged item has LEFT it:
 * every item after the vacated slot closes the gap by the item's `footprint`.
 * (The dragged item itself, `index === source`, follows the pointer — handled by
 * the binding, not here.) This is the source half of a cross-list move; the
 * same-list reorder uses {@link displacement} instead.
 */
export function closeDisplacement(
  index: number,
  source: number,
  footprint: number,
): number {
  return index > source ? -footprint : 0;
}

/**
 * Cross-list shift for the **target** list while an item is ENTERING at `insert`:
 * every item at/after the insert slot opens a `footprint`-sized gap. `footprint`
 * is the *incoming* item's footprint (from its source list), so the opened gap
 * matches where it commits.
 */
export function openDisplacement(
  index: number,
  insert: number,
  footprint: number,
): number {
  return index >= insert ? footprint : 0;
}

/** Clamp an index into `[0, length]` (a valid splice/insert position). */
export function clampInsert(index: number, length: number): number {
  return index < 0 ? 0 : index > length ? length : index;
}

/** Whether a viewport point lies within a rect — used to resolve which list a cross-list drag is over. */
export function containsPoint(rect: RectLike, x: number, y: number): boolean {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

/**
 * Pure cross-list move: remove the item at `fromIndex` of `from` and insert it
 * into `to` at `toIndex` (clamped), returning new arrays for both plus the moved
 * item. An out-of-range `fromIndex` is a no-op (copies returned, `item: undefined`).
 * `from` and `to` must be different arrays.
 */
export function transfer<T>(
  from: readonly T[],
  fromIndex: number,
  to: readonly T[],
  toIndex: number,
): { from: T[]; to: T[]; item: T | undefined } {
  const nextFrom = from.slice();
  if (fromIndex < 0 || fromIndex >= from.length) {
    return { from: nextFrom, to: to.slice(), item: undefined };
  }
  const [item] = nextFrom.splice(fromIndex, 1);
  const nextTo = to.slice();
  nextTo.splice(clampInsert(toIndex, nextTo.length), 0, item);
  return { from: nextFrom, to: nextTo, item };
}

/**
 * Pure: move the item at `from` to final index `to`, returning a new array.
 * `to` is clamped to a valid position. A no-op move (the item already sits at
 * `to`) returns a copy with identical order — length and key set are always
 * preserved.
 */
export function moveWithin<T>(
  arr: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clampInsert(to, next.length), 0, moved);
  return next;
}
