import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import {
  extractDragMeta,
  extractEdgeFromInnermost,
  mapDropTargets,
  unboxDragData,
} from './internal';
import type { DragMeta, DragStartEvent, DropEvent } from './types';

export type CreateMonitorOptions<TAccept, TMeta extends DragMeta = DragMeta> = {
  accepts?: (data: unknown) => data is TAccept;
  onDragStart?: (event: DragStartEvent<TAccept, TMeta>) => void;
  onDrop?: (event: DropEvent<TAccept, TMeta>) => void;
};

export type MonitorRef<TAccept, TMeta extends DragMeta = DragMeta> = {
  isDragging: Signal<boolean>;
  source: Signal<{ data: TAccept; meta: TMeta } | undefined>;
};

export function monitorElements<
  TAccept = unknown,
  TMeta extends DragMeta = DragMeta,
>(
  opts: CreateMonitorOptions<TAccept, TMeta> = {},
): MonitorRef<TAccept, TMeta> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      isDragging: computed(() => false),
      source: computed(() => undefined),
    };
  }

  const isDragging = signal(false);
  const source = signal<{ data: TAccept; meta: TMeta } | undefined>(undefined);

  const accept = (
    data: Record<string | symbol, unknown>,
  ): { data: TAccept; meta: TMeta } | null => {
    const unboxed = unboxDragData<unknown>(data);
    if (opts.accepts && !opts.accepts(unboxed)) return null;
    return { data: unboxed as TAccept, meta: extractDragMeta<TMeta>(data) };
  };

  const cleanup = monitorForElements({
    onDragStart: ({ source: src }) => {
      const accepted = accept(src.data);
      if (accepted === null) return;
      isDragging.set(true);
      source.set(accepted);
      opts.onDragStart?.({
        data: accepted.data,
        meta: accepted.meta,
        element: src.element,
      });
    },
    onDrop: ({ source: src, location }) => {
      const accepted = accept(src.data);
      isDragging.set(false);
      source.set(undefined);
      if (accepted === null) return;
      opts.onDrop?.({
        data: accepted.data,
        meta: accepted.meta,
        edge: extractEdgeFromInnermost(location.current.dropTargets),
        location: {
          current: mapDropTargets(location.current.dropTargets),
          previous: mapDropTargets(location.previous.dropTargets),
        },
      });
    },
  });

  inject(DestroyRef).onDestroy(cleanup);

  return { isDragging, source };
}
