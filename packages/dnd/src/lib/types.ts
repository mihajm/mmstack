import type { ElementRef, Signal } from '@angular/core';

export type Edge = 'top' | 'right' | 'bottom' | 'left';

export type DropTargetInfo<TData = unknown> = {
  element: Element;
  data: TData;
};

export type DragMeta = Record<symbol, unknown>;

export type DragStartEvent<TData, TMeta extends DragMeta = DragMeta> = {
  data: TData;
  meta: TMeta;
  element: HTMLElement;
};

export type DropEvent<TData, TMeta extends DragMeta = DragMeta> = {
  data: TData;
  meta: TMeta;
  edge: Edge | null;
  location: {
    current: DropTargetInfo[];
    previous: DropTargetInfo[];
  };
};

export type DropTargetEvent<
  TAccept,
  TSelf = unknown,
  TMeta extends DragMeta = DragMeta,
> = {
  source: { data: TAccept; meta: TMeta };
  self: DropTargetInfo<TSelf>;
};

export type Resolvable<T> = T | Signal<T> | (() => T);

export type DragHandleLike =
  | HTMLElement
  | ElementRef<HTMLElement>
  | { readonly elementRef: ElementRef<HTMLElement> };
