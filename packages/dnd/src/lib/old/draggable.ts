import { isPlatformServer } from '@angular/common';
import {
  ApplicationRef,
  computed,
  Directive,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  output,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { draggable as pragmaticDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import {
  boxDragData,
  extractEdgeFromInnermost,
  mapDropTargets,
  resolveElement,
  resolveSignal,
} from './internal';
import { registerCustomPreview, type PreviewConfig } from './preview';
import type {
  DragHandleLike,
  DragMeta,
  DragStartEvent,
  DropEvent,
  Resolvable,
} from './types';

export type CreateDraggableOptions<TData, TMeta extends DragMeta = DragMeta> = {
  data: Resolvable<TData>;
  meta?: Resolvable<TMeta>;
  canDrag?: () => boolean;
  dragHandle?: Resolvable<DragHandleLike | undefined>;
  /**
   * Custom drag preview. Pass a literal config or a function returning one
   * (useful when the source is a `TemplateRef` resolved via `viewChild`,
   * which isn't available at composable-setup time).
   */
  preview?:
    | PreviewConfig<TData>
    | (() => PreviewConfig<TData> | undefined | null);
  onDragStart?: (event: DragStartEvent<TData, TMeta>) => void;
  onDrop?: (event: DropEvent<TData, TMeta>) => void;
};

export type DraggableRef<TData> = {
  dragging: Signal<boolean>;
  data: Signal<TData>;
};

export function draggable<TData, TMeta extends DragMeta = DragMeta>(
  opts: CreateDraggableOptions<TData, TMeta>,
): DraggableRef<TData> {
  const data = resolveSignal(opts.data);
  const meta = opts.meta ? resolveSignal(opts.meta) : undefined;

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return { dragging: computed(() => false), data };
  }

  const element = inject(ElementRef<HTMLElement>).nativeElement;
  const dragging = signal(false);
  const handle = opts.dragHandle ? resolveSignal(opts.dragHandle) : undefined;

  const readMeta = (): TMeta => (meta ? untracked(meta) : ({} as TMeta));

  const previewResolver:
    | (() => PreviewConfig<TData> | undefined | null)
    | null =
    opts.preview === undefined
      ? null
      : typeof opts.preview === 'function'
        ? (opts.preview as () => PreviewConfig<TData> | undefined | null)
        : () => opts.preview as PreviewConfig<TData>;
  const envInjector = previewResolver ? inject(EnvironmentInjector) : null;
  const appRef = previewResolver ? inject(ApplicationRef) : null;

  effect((onCleanup) => {
    const dragHandle = handle ? resolveElement(handle()) : undefined;

    const canDragFn = opts.canDrag;
    const cleanup = pragmaticDraggable({
      element,
      dragHandle,
      canDrag: canDragFn ? () => canDragFn() : undefined,
      getInitialData: () => ({
        ...boxDragData(untracked(data)),
        ...(readMeta() as Record<symbol, unknown>),
      }),
      onGenerateDragPreview:
        previewResolver && envInjector && appRef
          ? ({ nativeSetDragImage }) => {
              const cfg = previewResolver();
              if (!cfg) return;
              registerCustomPreview(cfg, envInjector, appRef, {
                nativeSetDragImage,
              });
            }
          : undefined,
      onDragStart: ({ source }) => {
        dragging.set(true);
        opts.onDragStart?.({
          data: untracked(data),
          meta: readMeta(),
          element: source.element,
        });
      },
      onDrop: ({ location }) => {
        dragging.set(false);
        opts.onDrop?.({
          data: untracked(data),
          meta: readMeta(),
          edge: extractEdgeFromInnermost(location.current.dropTargets),
          location: {
            current: mapDropTargets(location.current.dropTargets),
            previous: mapDropTargets(location.previous.dropTargets),
          },
        });
      },
    });

    onCleanup(cleanup);
  });

  // onDrag, onGenerateDragPreview

  return { dragging, data };
}

@Directive({
  selector: '[mmDraggable]',
  exportAs: 'mmDraggable',
})
export class Draggable<TData = unknown, TMeta extends DragMeta = DragMeta> {
  readonly data = input.required<TData>();
  readonly meta = input<TMeta | undefined>(undefined);
  readonly canDrag = input<(() => boolean) | undefined>(undefined);
  readonly dragHandle = input<DragHandleLike | undefined>(undefined);
  readonly preview = input<PreviewConfig<TData> | undefined>(undefined);

  readonly dragStart = output<DragStartEvent<TData, TMeta>>();
  readonly dropped = output<DropEvent<TData, TMeta>>();

  private readonly ref = draggable<TData, TMeta>({
    data: this.data,
    meta: () => this.meta() ?? ({} as TMeta),
    canDrag: () => this.canDrag()?.() ?? true,
    dragHandle: this.dragHandle,
    preview: () => this.preview() ?? undefined,
    onDragStart: (e) => this.dragStart.emit(e),
    onDrop: (e) => this.dropped.emit(e),
  });

  readonly dragging = this.ref.dragging;
}
