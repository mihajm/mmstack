import { isPlatformServer } from '@angular/common';
import {
  afterRenderEffect,
  ApplicationRef,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  EnvironmentInjector,
  inject,
  Injector,
  input,
  isSignal,
  output,
  PLATFORM_ID,
  runInInjectionContext,
  untracked,
  type Signal,
} from '@angular/core';
import { draggable as pragmaticDraggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { boxData, extractEdge, mapDropTargets } from '../internal/payload';
import { resolveElement, resolveSignal } from '../internal/resolve';
import type {
  DragHandleLike,
  DragMeta,
  DragStartEvent,
  DropEvent,
  Resolvable,
} from '../internal/types';
import { resolveHitbox, type HitboxPlugin } from '../provide';
import { DndSession } from '../session';
import { registerCustomPreview, type PreviewConfig } from './preview';

export type CreateDraggableOptions<TData, TMeta extends DragMeta = DragMeta> = {
  /** The typed payload carried by the drag (value, signal, or getter). */
  data: Resolvable<TData>;
  /** Extra symbol-keyed metadata travelling with the drag (e.g. source list id). */
  meta?: Resolvable<TMeta>;
  /** Gate drag initiation; return `false` to forbid starting a drag. */
  canDrag?: () => boolean;
  /** Restrict drag initiation to this child element (a `DragHandle`, element, or ref). */
  dragHandle?: Resolvable<DragHandleLike | undefined>;
  /**
   * Custom drag preview. Pass a literal config or a function returning one
   * (useful when the source is a `TemplateRef` resolved via `viewChild`,
   * which isn't available at composable-setup time).
   */
  preview?:
    | PreviewConfig<TData>
    | (() => PreviewConfig<TData> | undefined | null);
  /** Override the registered hitbox plugin (used only to report `event.edge`). */
  hitbox?: HitboxPlugin;
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  /** Fires when this element starts being dragged. */
  onDragStart?: (event: DragStartEvent<TData, TMeta>) => void;
  /** Fires when this element is dropped (anywhere), with the resolved edge + targets. */
  onDrop?: (event: DropEvent<TData, TMeta>) => void;
};

export type DraggableRef<TData> = {
  /** True while this element is the active drag source. */
  dragging: Signal<boolean>;
  /** The current payload (the resolved `data` option). */
  data: Signal<TData>;
};

/**
 * Makes the host element draggable with a typed payload. `dragging` is *derived*
 * from the ambient `DndSession` (no writable signal); registration is done once
 * and options are read lazily, so changing `data`/`canDrag` never re-registers.
 *
 * @example
 * ```ts
 * type Card = { id: string; title: string };
 *
 * @Component({
 *   template: `{{ card().title }}`,
 *   host: { '[class.dragging]': 'dnd.dragging()' },
 * })
 * export class CardComponent {
 *   readonly card = signal<Card>({ id: '1', title: 'Hello' });
 *   protected readonly dnd = draggable<Card>({
 *     data: this.card,
 *     onDrop: ({ data, edge }) => console.log('dropped', data, 'edge', edge),
 *   });
 * }
 * ```
 * Or the directive: `<div mmDraggable [data]="card()" (dropped)="onDrop($event)">`.
 */
export function draggable<TData, TMeta extends DragMeta = DragMeta>(
  opts: CreateDraggableOptions<TData, TMeta>,
): DraggableRef<TData> {
  const injector = opts.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => {
    const data = resolveSignal(opts.data);

    if (isPlatformServer(inject(PLATFORM_ID)))
      return { dragging: computed(() => false), data };

    const meta = opts.meta ? resolveSignal(opts.meta) : undefined;

    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const session = inject(DndSession);
    const hitbox = resolveHitbox(opts.hitbox);

    // Derived from the `source` slice (recomputes on start/drop, not per frame).
    const dragging = computed(() => session.source()?.el === element);

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

    const canDragFn = opts.canDrag;
    const makeConfig = (dragHandle: HTMLElement | undefined) => ({
      element,
      dragHandle,
      canDrag: canDragFn ? () => canDragFn() : undefined,
      getInitialData: () => ({
        ...boxData(untracked(data)),
        ...(readMeta() as Record<symbol, unknown>),
      }),
      onGenerateDragPreview:
        previewResolver && envInjector && appRef
          ? ({
              nativeSetDragImage,
            }: {
              nativeSetDragImage:
                | ((image: Element, x: number, y: number) => void)
                | null;
            }) => {
              const cfg = previewResolver();
              if (!cfg) return;
              registerCustomPreview(cfg, envInjector, appRef, {
                nativeSetDragImage,
              });
            }
          : undefined,
      onDragStart: ({ source }: { source: { element: HTMLElement } }) => {
        opts.onDragStart?.({
          data: untracked(data),
          meta: readMeta(),
          element: source.element,
        });
      },
      onDrop: ({
        location,
      }: {
        location: {
          current: {
            dropTargets: readonly {
              element: Element;
              data: Record<string | symbol, unknown>;
            }[];
          };
          previous: {
            dropTargets: readonly {
              element: Element;
              data: Record<string | symbol, unknown>;
            }[];
          };
        };
      }) => {
        opts.onDrop?.({
          data: untracked(data),
          meta: readMeta(),
          edge: extractEdge(location.current.dropTargets, hitbox),
          location: {
            current: mapDropTargets(location.current.dropTargets),
            previous: mapDropTargets(location.previous.dropTargets),
          },
        });
      },
    });

    const handleInput = opts.dragHandle;
    const reactiveHandle =
      handleInput != null &&
      (isSignal(handleInput) || typeof handleInput === 'function');

    if (reactiveHandle) {
      const handleSig = resolveSignal(handleInput);
      // EDGE (conditional): re-register only when the handle element changes.
      afterRenderEffect(
        {
          earlyRead: () => resolveElement(handleSig()),
          write: (handle, onCleanup) => {
            onCleanup(pragmaticDraggable(makeConfig(handle())));
          },
        },
        { injector },
      );
    } else {
      const cleanup = pragmaticDraggable(
        makeConfig(resolveElement(handleInput as DragHandleLike | undefined)),
      );
      inject(DestroyRef).onDestroy(cleanup);
    }

    return { dragging, data };
  });
}

const EMPTY_META = Object.freeze({}) as DragMeta;

/** Directive form of {@link draggable}: `<div mmDraggable [data]="card()" (dropped)="…">`. */
@Directive({
  selector: '[mmDraggable]',
  exportAs: 'mmDraggable',
})
export class Draggable<TData = unknown, TMeta extends DragMeta = DragMeta> {
  /** The typed payload carried by the drag. */
  readonly data = input.required<TData>();
  /** Extra symbol-keyed metadata travelling with the drag. */
  readonly meta = input<TMeta | undefined>(undefined);
  /** Gate drag initiation; return `false` to forbid starting a drag. */
  readonly canDrag = input<(() => boolean) | undefined>(undefined);
  /** Restrict drag initiation to this child element. */
  readonly dragHandle = input<DragHandleLike | undefined>(undefined);
  /** Custom drag preview config. */
  readonly preview = input<PreviewConfig<TData> | undefined>(undefined);

  /** Emits when this element starts being dragged. */
  readonly dragStart = output<DragStartEvent<TData, TMeta>>();
  /** Emits when this element is dropped. */
  readonly dropped = output<DropEvent<TData, TMeta>>();

  private readonly ref = draggable<TData, TMeta>({
    data: this.data,
    meta: () => this.meta() ?? (EMPTY_META as TMeta),
    canDrag: () => this.canDrag()?.() ?? true,
    dragHandle: this.dragHandle,
    preview: () => this.preview() ?? undefined,
    onDragStart: (e) => this.dragStart.emit(e),
    onDrop: (e) => this.dropped.emit(e),
  });

  /** True while this element is the active drag source. */
  readonly dragging = this.ref.dragging;
}
