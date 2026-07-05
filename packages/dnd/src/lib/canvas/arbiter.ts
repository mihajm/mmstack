/**
 * Gesture arbitration — what a primary-button press on the canvas surface
 * means. ONE delegated sensor per surface; the pressed element's data
 * attributes decide the mode, so items, handles and chrome never race each
 * other for the gesture (and never need their own listeners).
 *
 * The attribute contract (rendered by the directives / the consumer's chrome):
 * - `data-mm-canvas-resize="se"` — a resize handle; acts on the selection.
 * - `data-mm-canvas-rotate` — a rotate handle; acts on the selection.
 * - `data-mm-canvas-handle` — a move handle inside an item.
 * - `data-mm-canvas-item` — an item; pressing anywhere on it moves it.
 * - anything else — empty surface: marquee.
 */

import type { ResizeDirection } from './transform';

export const CANVAS_RESIZE_ATTR = 'data-mm-canvas-resize';
export const CANVAS_ROTATE_ATTR = 'data-mm-canvas-rotate';
export const CANVAS_HANDLE_ATTR = 'data-mm-canvas-handle';
export const CANVAS_ITEM_ATTR = 'data-mm-canvas-item';

const DIRECTIONS: readonly ResizeDirection[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

export type Arbitration =
  /** A resize handle was pressed — resize the current selection. */
  | { readonly mode: 'resize'; readonly direction: ResizeDirection }
  /** A rotate handle was pressed — rotate the current selection. */
  | { readonly mode: 'rotate' }
  /** An item (or its move handle) was pressed — move it / the selection. */
  | { readonly mode: 'move'; readonly itemEl: HTMLElement }
  /** Empty surface — rubber-band select. */
  | { readonly mode: 'marquee' };

/**
 * Classifies a pointerdown `origin` within `surface`. Innermost attribute
 * wins (a resize handle inside an item resizes, it doesn't move), so chrome
 * can be rendered inside or outside item elements interchangeably.
 */
export function arbitrate(
  origin: Element | null,
  surface: Element,
): Arbitration {
  if (!origin || !surface.contains(origin)) return { mode: 'marquee' };

  const hit = origin.closest(
    `[${CANVAS_RESIZE_ATTR}],[${CANVAS_ROTATE_ATTR}],[${CANVAS_HANDLE_ATTR}],[${CANVAS_ITEM_ATTR}]`,
  );
  if (!hit || !surface.contains(hit)) return { mode: 'marquee' };

  const dir = hit.getAttribute(CANVAS_RESIZE_ATTR);
  if (dir !== null) {
    return {
      mode: 'resize',
      direction: DIRECTIONS.includes(dir as ResizeDirection)
        ? (dir as ResizeDirection)
        : 'se',
    };
  }
  if (hit.hasAttribute(CANVAS_ROTATE_ATTR)) return { mode: 'rotate' };

  const itemEl = hit.hasAttribute(CANVAS_ITEM_ATTR)
    ? (hit as HTMLElement)
    : (hit.closest(`[${CANVAS_ITEM_ATTR}]`) as HTMLElement | null);
  if (itemEl && surface.contains(itemEl)) return { mode: 'move', itemEl };

  // a stray handle outside any item falls back to marquee rather than a dead press
  return { mode: 'marquee' };
}
