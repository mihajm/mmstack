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
export type RectLike = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
};

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

/** A 2D point/center — the wrap-mode analogue of a main-axis scalar. */
export type Point = {
  readonly x: number;
  readonly y: number;
};

/**
 * Slot occupied by the item at `index` while the source is headed for `insert`
 * — the wrap-mode displacement model. The N drag-start centers ARE the slots;
 * they never move during a drag, only this item→slot assignment changes:
 * the source renders at the insert slot, items between the source's old slot
 * and the insert slot shift one slot toward the vacancy, everything else stays.
 *
 * `slotOf` is a permutation of `0..N-1` for any (source, insert) pair, which is
 * what makes the wrap model conserve layout: every slot is occupied by exactly
 * one item. Exact for uniform-size items (each slot fits any item); documented
 * approximation for variable sizes (dnd-kit `rectSortingStrategy` parity).
 */
export function slotOf(index: number, source: number, insert: number): number {
  if (index === source) return insert;
  if (index > source && index <= insert) return index - 1;
  if (index >= insert && index < source) return index + 1;
  return index;
}

/**
 * Wrap-mode collision: the slot whose center is nearest the pointer, with a
 * 2D Schmitt deadband — a challenger slot must beat the held slot's distance
 * by more than `deadband` px to take over, so sub-pixel jitter on a Voronoi
 * boundary can't twitch the order.
 *
 * Unlike {@link insertIndexTransformAware} there is no displaced-center
 * feedback here: slots are STATIC drag-start centers, so a held pointer is a
 * fixed point by construction (nearest-of-static-points needs no settling).
 *
 * Returns a slot index in `[0, centers.length - 1]` (a reorder, never an
 * append). Seed `prevInsert` with the source index on the first frame.
 */
export function insertIndexFromSlots(
  centers: readonly Point[],
  x: number,
  y: number,
  prevInsert: number,
  deadband = 0,
): number {
  if (centers.length === 0) return 0;
  let best = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const dx = x - centers[i].x;
    const dy = y - centers[i].y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  if (prevInsert < 0 || prevInsert >= centers.length || prevInsert === best) {
    return best;
  }
  const held = centers[prevInsert];
  const heldD = Math.hypot(x - held.x, y - held.y);
  return Math.sqrt(bestD2) + deadband < heldD ? best : prevInsert;
}

/**
 * The virtual slot `N` of a wrap grid — where an appended item would sit.
 * Extrapolates one column pitch past the last center, wrapping to the next
 * row (the row's min x, one row pitch down) when that would overflow the
 * widest occupied column — so a single-column grid (minX === maxX) appends
 * below, like the vertical list it visually is. Used for foreign-entry
 * collision and the target's opening gap, where the last item shifts into a
 * slot that doesn't exist yet.
 */
export function wrapVirtualSlot(
  centers: readonly Point[],
  colPitch: number,
  rowPitch: number,
): Point {
  const last = centers[centers.length - 1];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
  }
  const x = last.x + colPitch;
  // half a pitch of tolerance: centers within a column can waver a little
  return x > maxX + colPitch / 2
    ? { x: minX, y: last.y + rowPitch }
    : { x, y: last.y };
}

/**
 * Foreign-entry collision for a wrap grid: the insert position in `[0, N]`
 * whose slot center (the N real centers plus the virtual append slot) is
 * nearest the pointer. Point-based and stateless — the cross-list path has no
 * held index to defend, stickiness lives at the target-resolution level.
 */
export function wrapInsertAtPoint(
  centers: readonly Point[],
  colPitch: number,
  rowPitch: number,
  x: number,
  y: number,
): number {
  if (centers.length === 0) return 0;
  const v = wrapVirtualSlot(centers, colPitch, rowPitch);
  let best = 0;
  let bestD2 = Infinity;
  for (let i = 0; i <= centers.length; i++) {
    const c = i < centers.length ? centers[i] : v;
    const dx = x - c.x;
    const dy = y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * Wrap-mode cross-list slot for the **source** list once the dragged item has
 * LEFT it: items after the vacated index close ranks by one slot. The leaving
 * item itself keeps its slot (it follows the pointer; the binding handles it).
 */
export function closeSlotOf(index: number, source: number): number {
  return index > source ? index - 1 : index;
}

/**
 * Wrap-mode cross-list slot for the **target** list while an item is ENTERING
 * at `insert`: items at/after the insert open a slot by shifting one forward.
 * The last item's destination is the virtual slot `N` ({@link wrapVirtualSlot}).
 */
export function openSlotOf(index: number, insert: number): number {
  return index >= insert ? index + 1 : index;
}

/**
 * What a group member reports about its inner layout when a cross-container
 * drag needs an insert index in its space — measured once per drag, cached by
 * the source controller. Linear members project onto one axis; wrap members
 * report 2D centers plus their column/row pitch (for the virtual append slot).
 * A missing `kind` means linear, so pre-union member implementations keep
 * working unchanged.
 */
export type MemberMeasure =
  | {
      readonly kind?: 'linear';
      readonly centers: readonly number[];
      readonly axis: Axis;
    }
  | {
      readonly kind: 'wrap';
      readonly centers: readonly Point[];
      readonly colPitch: number;
      readonly rowPitch: number;
    };

/**
 * Cross-container insert dispatch: resolves a viewport point to an insert
 * position `[0, N]` in the measured member's own coordinate space, whatever
 * its layout kind.
 */
export function insertIndexForMeasure(
  measure: MemberMeasure,
  x: number,
  y: number,
): number {
  if (measure.kind === 'wrap') {
    return wrapInsertAtPoint(
      measure.centers,
      measure.colPitch,
      measure.rowPitch,
      x,
      y,
    );
  }
  return insertIndexFromCenters(measure.centers, measure.axis === 'y' ? y : x);
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
 * `to` is clamped to a valid position; an out-of-range `from` is a no-op copy
 * (never splices `undefined` in). A no-op move (the item already sits at `to`)
 * returns a copy with identical order — length and key set are always
 * preserved.
 */
export function moveWithin<T>(
  arr: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = arr.slice();
  if (from < 0 || from >= arr.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(clampInsert(to, next.length), 0, moved);
  return next;
}
