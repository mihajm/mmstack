import type { ElementRef, Signal } from '@angular/core';

/** The side of a drop target a pointer is closest to (needs the hitbox plugin). */
export type Edge = 'top' | 'right' | 'bottom' | 'left';

/** A drop target encountered during a drag — its element and (unboxed) data. */
export type DropTargetInfo<TData = unknown> = {
  element: Element;
  data: TData;
};

/**
 * Typed metadata carried alongside drag `data`, keyed by symbols so it never
 * collides with consumer keys. The seam higher-level patterns (e.g. `reorderable`)
 * build on.
 *
 * @example
 * ```ts
 * const KIND = Symbol('kind');
 * type CardMeta = { [KIND]: 'todo' | 'done' };
 * ```
 */
export type DragMeta = Record<symbol, unknown>;

/** Payload of `onDragStart` — the source's data, meta and element. */
export type DragStartEvent<TData, TMeta extends DragMeta = DragMeta> = {
  data: TData;
  meta: TMeta;
  element: HTMLElement;
};

/** Payload of `onDrop` — the dropped data/meta, the closest `edge`, and the target stack. */
export type DropEvent<TData, TMeta extends DragMeta = DragMeta> = {
  data: TData;
  meta: TMeta;
  edge: Edge | null;
  location: {
    current: DropTargetInfo[];
    previous: DropTargetInfo[];
  };
};

/** Payload of `onDragEnter` / `onDragLeave`: the accepted source plus this target's own self data. */
export type DropTargetEvent<
  TAccept,
  TSelf = unknown,
  TMeta extends DragMeta = DragMeta,
> = {
  source: { data: TAccept; meta: TMeta };
  self: DropTargetInfo<TSelf>;
};

/** A plain value, a `Signal`, or a getter — resolved to a `Signal` internally. */
export type Resolvable<T> = T | Signal<T> | (() => T);

/**
 * A drag-handle reference: an element, its `ElementRef`, or anything exposing an
 * `elementRef` (e.g. a component or directive instance). Restricts drag initiation
 * to a child of the draggable.
 */
export type DragHandleLike =
  | HTMLElement
  | ElementRef<HTMLElement>
  | { readonly elementRef: ElementRef<HTMLElement> };
