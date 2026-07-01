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
import { nestedEffect, pointerDrag } from '@mmstack/primitives';

import { boxData, extractEdge, mapDropTargets } from '../internal/payload';
import { resolveElement, resolveSignal } from '../internal/resolve';
import type {
  DragHandleLike,
  DragMeta,
  DragStartEvent,
  DropEvent,
  Resolvable,
} from '../internal/types';
import {
  createDefaultsToken,
  injectDndDefaults,
  resolveHitbox,
  withDefaults,
  type HitboxPlugin,
} from '../provide';
import { DndSession, type DragEngine } from '../session';
import { DndPointerEngine, type PointerDragSource } from './pointer-engine';
import {
  createPointerPreview,
  registerCustomPreview,
  type PointerPreview,
  type PreviewConfig,
} from './preview';

/** Options common to both engines. */
type DraggableSharedOptions<TData, TMeta extends DragMeta> = {
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
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  /** Fires when this element starts being dragged. */
  onDragStart?: (event: DragStartEvent<TData, TMeta>) => void;
  /** Fires when this element is dropped (anywhere), with the resolved edge + targets. */
  onDrop?: (event: DropEvent<TData, TMeta>) => void;
};

/** Native-engine-only draggable options — forbidden (typed `never`) when `engine: 'pointer'`. */
type DraggableNativeOptions = {
  /** Override the registered hitbox plugin (only reports `event.edge`; the pointer path has no edge). */
  hitbox?: HitboxPlugin;
};

/**
 * Draggable options, discriminated by `engine`. Omit `engine` (or `'native'`) for
 * native HTML5 DnD (files, cross-window, browser drag image) + `hitbox`; `'pointer'`
 * drives the pointer engine and *forbids* `hitbox` at compile time.
 */
export type CreateDraggableOptions<TData, TMeta extends DragMeta = DragMeta> =
  | (DraggableSharedOptions<TData, TMeta> &
      DraggableNativeOptions & { engine?: 'native' })
  | (DraggableSharedOptions<TData, TMeta> & { engine: 'pointer' } & {
        [K in keyof DraggableNativeOptions]?: never;
      });

/** @internal Flat view (all fields) for the implementation to read without narrowing. */
type DraggableOptionsAll<
  TData,
  TMeta extends DragMeta,
> = DraggableSharedOptions<TData, TMeta> &
  DraggableNativeOptions & { engine?: DragEngine };

export type DraggableRef<TData> = {
  /** True while this element is the active drag source. */
  dragging: Signal<boolean>;
  /** The current payload (the resolved `data` option). */
  data: Signal<TData>;
};

/** DI-settable `draggable` defaults; inherits `engine` from {@link provideDndDefaults}. */
export type DraggableDefaults = {
  /** Default drag engine for draggables. */
  engine?: DragEngine;
};

const draggableDefaults = createDefaultsToken<DraggableDefaults>(
  '@mmstack/dnd:draggable-defaults',
  injectDndDefaults,
);
/** Register `draggable` option defaults (a per-call option always wins). */
export const provideDraggableDefaults = draggableDefaults.provide;
/** Read the `draggable` defaults (or `null`). @see {@link provideDraggableDefaults} */
export const injectDraggableDefaults = draggableDefaults.inject;

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
  options: CreateDraggableOptions<TData, TMeta>,
): DraggableRef<TData> {
  // The discriminated union guards callers; internally read the flat view.
  const raw = options as DraggableOptionsAll<TData, TMeta>;
  const injector = raw.injector ?? inject(Injector);
  const opts = withDefaults(raw, injectDraggableDefaults(injector));
  return runInInjectionContext(injector, () => {
    const data = resolveSignal(opts.data);

    if (isPlatformServer(inject(PLATFORM_ID)))
      return { dragging: computed(() => false), data };

    const meta = opts.meta ? resolveSignal(opts.meta) : undefined;

    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const session = inject(DndSession);
    // Opportunistic (only reports `event.edge`), so warn:false — missing plugin = null edge.
    const getHitbox = resolveHitbox(injector, opts.hitbox, false);

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

    if ((opts.engine ?? 'native') === 'pointer') {
      const eng = inject(DndPointerEngine);
      const handleSig =
        opts.dragHandle != null ? resolveSignal(opts.dragHandle) : null;
      const target = handleSig
        ? computed(() => resolveElement(handleSig()) ?? element)
        : element;
      const drag = pointerDrag({ target, activationThreshold: 5 });

      let source: PointerDragSource | null = null;
      let preview: PointerPreview | null = null;
      nestedEffect(() => {
        const g = drag.unthrottled();
        if (g.active && g.pointerId !== null) {
          if (!source) {
            if (opts.canDrag && !opts.canDrag()) return; // gate at start only
            source = {
              el: element,
              data: {
                ...boxData(untracked(data)),
                ...(readMeta() as Record<symbol, unknown>),
              },
              kind: 'transfer',
            };
            eng.begin(source, g.current.x, g.current.y);
            const cfg = previewResolver?.();
            if (cfg && envInjector && appRef)
              preview = createPointerPreview(cfg, envInjector, appRef);
            opts.onDragStart?.({
              data: untracked(data),
              meta: readMeta(),
              element,
            });
          } else {
            eng.move(source, g.current.x, g.current.y);
          }
          if (preview) preview.move(g.current.x, g.current.y);
          else element.style.transform = `translate(${g.delta.x}px, ${g.delta.y}px)`;
        } else if (source) {
          const targets = eng.end();
          if (preview) {
            preview.destroy();
            preview = null;
          } else {
            element.style.transform = '';
          }
          opts.onDrop?.({
            data: untracked(data),
            meta: readMeta(),
            edge: null,
            location: { current: mapDropTargets(targets), previous: [] },
          });
          source = null;
        }
      });

      return { dragging, data };
    }

    session.ensureNativeMonitor();

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
          edge: extractEdge(location.current.dropTargets, getHitbox()),
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
