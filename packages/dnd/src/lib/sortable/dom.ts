// Real static attributes — input bindings like `[mmReorderableItem]` aren't
// reflected to the DOM, so `closest()` can't match them. Shared by the item
// directive (host attrs) and the pointer connect (delegated `handleSelector`).

/** Marks a sortable item element. */
export const ITEM_ATTR = 'data-mm-reorderable-item';
export const ITEM_SELECTOR = `[${ITEM_ATTR}]`;

/** The drag *surface* (where a gesture may start + where `touch-action:none` lives). */
export const HANDLE_ATTR = 'data-mm-reorderable-handle';
export const HANDLE_SELECTOR = `[${HANDLE_ATTR}]`;
