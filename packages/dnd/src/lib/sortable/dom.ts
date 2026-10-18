// Real static attributes — input bindings like `[mmReorderableItem]` aren't
// reflected to the DOM, so `closest()` can't match them. Shared by the item
// directive (host attrs) and the pointer connect (delegated `handleSelector`).

/** Marks a sortable item element. */
export const ITEM_ATTR = 'data-mm-reorderable-item';
export const ITEM_SELECTOR = `[${ITEM_ATTR}]`;

/** The drag *surface* (where a gesture may start + where `touch-action:none` lives). */
export const HANDLE_ATTR = 'data-mm-reorderable-handle';
export const HANDLE_SELECTOR = `[${HANDLE_ATTR}]`;

/**
 * The translate a CSS `transform` value applies, in px. Reads the computed
 * forms (`matrix`, `matrix3d`) and the forms the sortable writes itself
 * (`translate`, `translateX`, `translateY`); anything else reads as no shift.
 */
export function parseTranslate(transform: string | null | undefined): {
  x: number;
  y: number;
} {
  const m = transform
    ? /^([a-zA-Z0-9]+)\((.*)\)$/.exec(transform.trim())
    : null;
  if (!m) return { x: 0, y: 0 };
  const n = m[2].split(',').map((s) => parseFloat(s) || 0);
  switch (m[1]) {
    case 'matrix':
      return { x: n[4] ?? 0, y: n[5] ?? 0 };
    case 'matrix3d':
      return { x: n[12] ?? 0, y: n[13] ?? 0 };
    case 'translate':
    case 'translate3d':
      return { x: n[0] ?? 0, y: n[1] ?? 0 };
    case 'translateX':
      return { x: n[0] ?? 0, y: 0 };
    case 'translateY':
      return { x: 0, y: n[0] ?? 0 };
    default:
      return { x: 0, y: 0 };
  }
}

/** The translate `el` renders with right now: its computed transform, so a running glide reads mid-way. */
export function currentTranslate(el: HTMLElement): { x: number; y: number } {
  const computed =
    el.ownerDocument?.defaultView?.getComputedStyle(el).transform;
  // a DOM without computed transforms (jsdom, happy-dom) reads the inline value
  return parseTranslate(computed || el.style.transform);
}
