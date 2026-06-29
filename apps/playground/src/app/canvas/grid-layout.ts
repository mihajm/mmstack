import {
  computed,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/** A widget occupying a rectangular region of grid cells. */
export type GridItem = {
  id: unknown;
  /** Column (cells from the left, 0-based). */
  x: number;
  /** Row (cells from the top, 0-based). */
  y: number;
  /** Width in cells. */
  w: number;
  /** Height in cells. */
  h: number;
};

/** Do two items overlap (ignoring identity-equal items)? */
export function gridCollides(a: GridItem, b: GridItem): boolean {
  return (
    a.id !== b.id &&
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * Gravity: pulls every item up as far as it can go without colliding (sorted
 * top-to-bottom, left-to-right). `fixedId` stays at its current row (the item
 * the user is actively dragging). Preserves the item type (extra fields).
 */
export function compactGrid<T extends GridItem>(
  items: readonly T[],
  fixedId?: unknown,
): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: T[] = [];
  for (const it of sorted) {
    if (it.id === fixedId) {
      out.push({ ...it });
      continue;
    }
    let y = it.y;
    while (y > 0 && !out.some((p) => gridCollides(p, { ...it, y: y - 1 }))) {
      y--;
    }
    out.push({ ...it, y });
  }
  return out;
}

/** Pushes everything colliding with `moving` straight down, cascading. */
function pushDown<T extends GridItem>(items: readonly T[], moving: T): T[] {
  let result = [...items];
  for (const c of result.filter((i) => gridCollides(moving, i))) {
    const pushed = { ...c, y: moving.y + moving.h };
    result = result.map((r) => (r.id === c.id ? pushed : r));
    result = pushDown(result, pushed);
  }
  return result;
}

/**
 * Moves item `id` to cell `(x, y)`, pushing colliding items down to make room,
 * then compacting upward (the dragged item stays put). Pure — the Retool-style
 * grid reflow. Preserves the item type.
 */
export function moveGridItem<T extends GridItem>(
  items: readonly T[],
  id: unknown,
  x: number,
  y: number,
  cols: number,
): T[] {
  const target = items.find((i) => i.id === id);
  if (!target) return [...items];

  const nx = Math.max(0, Math.min(x, cols - target.w));
  const ny = Math.max(0, y);
  const moving: T = { ...target, x: nx, y: ny };

  let next = items.map((i) => (i.id === id ? moving : { ...i }));
  next = pushDown(next, moving);
  return compactGrid(next, id);
}

export type GridLayoutRef<T extends GridItem = GridItem> = {
  items: Signal<readonly T[]>;
  /** Number of rows currently occupied. */
  rows: Signal<number>;
  move(id: unknown, x: number, y: number): void;
  add(item: T): void;
  remove(id: unknown): void;
  set(items: T[]): void;
};

/**
 * Reactive wrapper over a `WritableSignal<T[]>` (`T extends GridItem`) that keeps
 * the layout collision-free and compacted. `move` reflows; `add`/`remove` compact.
 */
export function gridLayout<T extends GridItem>(
  items: WritableSignal<T[]>,
  opts: { cols: number },
): GridLayoutRef<T> {
  const rows = computed(() =>
    items().reduce((max, i) => Math.max(max, i.y + i.h), 0),
  );

  // Mutators read `items` UNTRACKED so they're safe to call from inside an
  // effect/callback (e.g. movable's `onMove`) — reading the signal you're about
  // to set, while tracked, would make the caller depend on it and infinite-loop.
  return {
    items: items.asReadonly(),
    rows,
    move: (id, x, y) =>
      items.set(moveGridItem(untracked(items), id, x, y, opts.cols)),
    add: (item) => items.set(compactGrid([...untracked(items), item])),
    remove: (id) =>
      items.set(compactGrid(untracked(items).filter((i) => i.id !== id))),
    set: (next) => items.set(compactGrid(next)),
  };
}
