import {
  afterRenderEffect,
  computed,
  isSignal,
  signal,
  untracked,
  type ElementRef,
  type Signal,
} from '@angular/core';
import { draggable as pragmaticDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { DragStartEvent } from './event.type';
import { box, injectHTMLElement, isServer } from './util';

type ResolvableElement =
  | HTMLElement
  | ElementRef<HTMLElement>
  | { elementRef: HTMLElement };

type BaseDraggableOptions<TData> = {
  dragHandle?: ResolvableElement | Signal<ResolvableElement>;
  canDrag?: (element: HTMLElement, data: TData) => boolean;
  onDragStart?: (e: DragStartEvent<TData>) => void;
};

export type CreateDraggableOptions<TData> = BaseDraggableOptions<TData> &
  ([TData] extends [void]
    ? {
        data?: TData | Signal<TData>;
      }
    : { data: TData | Signal<TData> });

export type Draggable<TData> = {
  dragging: Signal<boolean>;
  data: Signal<TData>;
  destroy: () => void;
};

export function draggable(): Draggable<void>;
export function draggable<TData = void>(
  opt: CreateDraggableOptions<TData>,
): Draggable<TData>;

export function draggable<TData = void>(
  opt?: CreateDraggableOptions<TData>,
): Draggable<TData> {
  const dataSig =
    opt?.data !== undefined && isSignal(opt.data)
      ? opt.data
      : signal(opt?.data as TData).asReadonly();

  if (isServer())
    return {
      dragging: computed(() => false),
      data: dataSig,
      destroy: () => {
        // noop
      },
    };

  const { canDrag, dragHandle } = (opt ?? {}) as Omit<
    CreateDraggableOptions<TData>,
    'data'
  >;

  const dragging = signal(false);
  const el = injectHTMLElement();

  const canDragFn = canDrag ? () => canDrag(el, untracked(dataSig)) : undefined;

  const handleSig: Signal<ResolvableElement | undefined> =
    dragHandle && isSignal(dragHandle)
      ? (dragHandle as Signal<ResolvableElement>)
      : computed(() => dragHandle as ResolvableElement | undefined);

  const effectRef = afterRenderEffect<
    ResolvableElement | undefined,
    void,
    void
  >({
    earlyRead: () => handleSig(),
    write: (handle, cleanup) =>
      cleanup(
        pragmaticDraggable({
          element: el,
          canDrag: canDragFn,
          getInitialData: () => box(untracked(dataSig)),
          onDragStart: () => {
            dragging.set(true);
          },
          onDrop: () => {
            dragging.set(false);
          },
        }),
      ),
  });

  return {
    dragging: dragging.asReadonly(),
    data: dataSig,
    destroy: () => effectRef.destroy(),
  };
}
