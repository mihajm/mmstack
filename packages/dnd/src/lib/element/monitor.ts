import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  untracked,
  type Signal,
} from '@angular/core';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import {
  extractDragMeta,
  extractEdge,
  mapDropTargets,
  unboxData,
} from '../internal/payload';
import type { DragMeta, DragStartEvent, DropEvent } from '../internal/types';
import { resolveHitbox, type HitboxPlugin } from '../provide';
import { DndSession } from '../session';

export type CreateMonitorOptions<TAccept, TMeta extends DragMeta = DragMeta> = {
  /** Pure type guard narrowing which drags to report (read untracked). */
  accepts?: (data: unknown) => data is TAccept;
  /** Override the registered hitbox plugin (used only to report `event.edge`). */
  hitbox?: HitboxPlugin;
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  /** Fires when any accepted drag starts (attaches a thin subscription). */
  onDragStart?: (event: DragStartEvent<TAccept, TMeta>) => void;
  /** Fires when any accepted drag drops (attaches a thin subscription). */
  onDrop?: (event: DropEvent<TAccept, TMeta>) => void;
};

export type MonitorRef<TAccept, TMeta extends DragMeta = DragMeta> = {
  /** True while an accepted drag is in flight anywhere. */
  isDragging: Signal<boolean>;
  /** The accepted drag's payload + meta while in flight, else `undefined`. */
  source: Signal<{ data: TAccept; meta: TMeta } | undefined>;
};

/**
 * Observe global drag state. `isDragging`/`source` are derived from the ambient
 * `DndSession` (no subscription); the optional `onDragStart`/`onDrop` callbacks
 * attach a thin `monitorForElements` subscription only when supplied.
 *
 * @example
 * ```ts
 * // dim everything else while a card is being dragged
 * protected readonly drags = monitor<Card>({ accepts: isCard });
 * // template: <div [class.is-dragging]="drags.isDragging()">
 * ```
 */
export function monitor<TAccept = unknown, TMeta extends DragMeta = DragMeta>(
  opts: CreateMonitorOptions<TAccept, TMeta> = {},
): MonitorRef<TAccept, TMeta> {
  const injector = opts.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => {
    if (isPlatformServer(inject(PLATFORM_ID)))
      return {
        isDragging: computed(() => false),
        source: computed(() => undefined),
      };

    const session = inject(DndSession);
    // Opportunistic (only reports `event.edge`) → resolve quietly (warn: false).
    const getHitbox = resolveHitbox(injector, opts.hitbox, false);

    const providedAccept = opts.accepts;

    const accept = (
      data: Record<string | symbol, unknown>,
    ): { data: TAccept; meta: TMeta } | null => {
      const unboxed = unboxData<unknown>(data);
      // No `accepts` → only report @mmstack drags, so source() is defined while isDragging() is true.
      if (providedAccept) {
        if (!untracked(() => providedAccept(unboxed))) return null;
      } else if (unboxed === undefined) {
        return null;
      }
      return { data: unboxed as TAccept, meta: extractDragMeta<TMeta>(data) };
    };

    const accepted = computed(() => {
      const s = session.source();
      return s ? accept(s.data) : null;
    });

    const isDragging = computed(() => accepted() !== null);
    const source = computed(() => accepted() ?? undefined);

    if (!opts.onDragStart && !opts.onDrop) return { isDragging, source };

    const cleanup = monitorForElements({
      onDragStart: opts.onDragStart
        ? ({ source: src }) => {
            const a = accept(src.data);
            if (!a) return;
            opts.onDragStart?.({
              data: a.data,
              meta: a.meta,
              element: src.element,
            });
          }
        : undefined,
      onDrop: opts.onDrop
        ? ({ source: src, location }) => {
            const a = accept(src.data);
            if (!a) return;
            opts.onDrop?.({
              data: a.data,
              meta: a.meta,
              edge: extractEdge(location.current.dropTargets, getHitbox()),
              location: {
                current: mapDropTargets(location.current.dropTargets),
                previous: mapDropTargets(location.previous.dropTargets),
              },
            });
          }
        : undefined,
    });
    inject(DestroyRef).onDestroy(cleanup);

    return { isDragging, source };
  });
}
