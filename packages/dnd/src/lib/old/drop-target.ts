import { isPlatformServer } from '@angular/common';
import {
  booleanAttribute,
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  output,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

import { DropIndicator } from './drop-indicator';
import {
  boxDropTargetData,
  extractDragMeta,
  mapDropTargets,
  resolveSignal,
  unboxDragData,
} from './internal';
import type {
  DragMeta,
  DropEvent,
  DropTargetEvent,
  DropTargetInfo,
  Edge,
  Resolvable,
} from './types';

export type CreateDropTargetOptions<
  TAccept,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
> = {
  accepts: (data: unknown) => data is TAccept;
  data?: Resolvable<TSelf>;
  canDrop?: (args: { source: { data: TAccept; meta: TMeta } }) => boolean;
  disabled?: Resolvable<boolean>;
  edges?: Resolvable<Edge[] | undefined>;
  onDragEnter?: (event: DropTargetEvent<TAccept, TSelf, TMeta>) => void;
  onDragLeave?: (event: DropTargetEvent<TAccept, TSelf, TMeta>) => void;
  onDrop?: (event: DropEvent<TAccept, TMeta>) => void;
};

export type DropTargetRef<TAccept> = {
  isDragOver: Signal<boolean>;
  dragOverData: Signal<TAccept | undefined>;
  closestEdge: Signal<Edge | null>;
};

const NOOP: DropTargetRef<never> = {
  isDragOver: computed(() => false),
  dragOverData: computed(() => undefined),
  closestEdge: computed(() => null),
};

export function dropTarget<
  TAccept,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
>(
  opts: CreateDropTargetOptions<TAccept, TSelf, TMeta>,
): DropTargetRef<TAccept> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return NOOP as DropTargetRef<TAccept>;
  }

  const element = inject(ElementRef<HTMLElement>).nativeElement;
  const selfData = opts.data ? resolveSignal(opts.data) : undefined;
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
  const edgesSig = opts.edges
    ? resolveSignal(opts.edges)
    : computed<Edge[] | undefined>(() => undefined);

  const isDragOver = signal(false);
  const dragOverData = signal<TAccept | undefined>(undefined);
  const closestEdge = signal<Edge | null>(null);

  const accept = (
    data: Record<string | symbol, unknown>,
  ): { data: TAccept; meta: TMeta } | null => {
    const unboxed = unboxDragData<unknown>(data);
    if (!opts.accepts(unboxed)) return null;
    return { data: unboxed as TAccept, meta: extractDragMeta<TMeta>(data) };
  };

  const selfInfo = (record: {
    element: Element;
    data: Record<string | symbol, unknown>;
  }): DropTargetInfo<TSelf> => ({
    element: record.element,
    data: (selfData ? untracked(selfData) : undefined) as TSelf,
  });

  effect((onCleanup) => {
    if (disabled?.()) {
      isDragOver.set(false);
      dragOverData.set(undefined);
      closestEdge.set(null);
      return;
    }

    const edges = edgesSig();

    const cleanup = dropTargetForElements({
      element,
      getData: ({ input, element: el }) => {
        const base = selfData
          ? boxDropTargetData(untracked(selfData))
          : ({} as Record<string | symbol, unknown>);
        if (edges?.length) {
          return attachClosestEdge(base, {
            element: el,
            input,
            allowedEdges: edges,
          });
        }
        return base;
      },
      canDrop: ({ source }) => {
        const accepted = accept(source.data);
        if (accepted === null) return false;
        return opts.canDrop?.({ source: accepted }) ?? true;
      },
      onDragEnter: ({ source, self }) => {
        const accepted = accept(source.data);
        if (accepted === null) return;
        isDragOver.set(true);
        dragOverData.set(accepted.data);
        if (edges?.length) closestEdge.set(extractClosestEdge(self.data));
        opts.onDragEnter?.({ source: accepted, self: selfInfo(self) });
      },
      onDrag: ({ self }) => {
        if (edges?.length) closestEdge.set(extractClosestEdge(self.data));
      },
      onDragLeave: ({ source, self }) => {
        const accepted = accept(source.data);
        isDragOver.set(false);
        dragOverData.set(undefined);
        closestEdge.set(null);
        if (accepted === null) return;
        opts.onDragLeave?.({ source: accepted, self: selfInfo(self) });
      },
      onDrop: ({ source, self, location }) => {
        const accepted = accept(source.data);
        const edge = edges?.length ? extractClosestEdge(self.data) : null;
        if (accepted !== null) {
          opts.onDrop?.({
            data: accepted.data,
            meta: accepted.meta,
            edge,
            location: {
              current: mapDropTargets(location.current.dropTargets),
              previous: mapDropTargets(location.previous.dropTargets),
            },
          });
        }
        isDragOver.set(false);
        dragOverData.set(undefined);
        closestEdge.set(null);
      },
    });

    onCleanup(cleanup);
  });

  return { isDragOver, dragOverData, closestEdge };
}

@Directive({
  selector: '[mmDropTarget]',
  exportAs: 'mmDropTarget',
  hostDirectives: [
    {
      directive: DropIndicator,
      inputs: ['thickness: indicatorThickness', 'gap: indicatorGap'],
    },
  ],
})
export class DropTarget<
  TAccept = unknown,
  TSelf = void,
  TMeta extends DragMeta = DragMeta,
> {
  readonly accepts = input.required<(data: unknown) => data is TAccept>();
  readonly data = input<TSelf | undefined>(undefined);
  readonly canDrop = input<
    | ((args: { source: { data: TAccept; meta: TMeta } }) => boolean)
    | undefined
  >(undefined);
  readonly dropDisabled = input(false, { transform: booleanAttribute });
  readonly edges = input<Edge[] | undefined>(undefined);
  readonly indicated = input(false, { transform: booleanAttribute });

  readonly dragEnter = output<DropTargetEvent<TAccept, TSelf, TMeta>>();
  readonly dragLeave = output<DropTargetEvent<TAccept, TSelf, TMeta>>();
  readonly dropped = output<DropEvent<TAccept, TMeta>>();

  private readonly indicator = inject(DropIndicator);

  private readonly ref = dropTarget<TAccept, TSelf, TMeta>({
    accepts: (d): d is TAccept => this.accepts()(d),
    data: () => this.data() as TSelf,
    canDrop: (args) => this.canDrop()?.(args) ?? true,
    disabled: this.dropDisabled,
    edges: this.edges,
    onDragEnter: (e) => this.dragEnter.emit(e),
    onDragLeave: (e) => this.dragLeave.emit(e),
    onDrop: (e) => this.dropped.emit(e),
  });

  readonly isDragOver = this.ref.isDragOver;
  readonly dragOverData = this.ref.dragOverData;
  readonly closestEdge = this.ref.closestEdge;

  constructor() {
    effect(() => this.indicator.edge.set(this.closestEdge()));
    effect(() => this.indicator.disabled.set(!this.indicated()));
  }
}
