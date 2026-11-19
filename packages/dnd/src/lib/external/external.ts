import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { dropTargetForExternal } from '@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external';
import { monitorForExternal } from '@atlaskit/pragmatic-drag-and-drop/adapter/monitor-for-external';
import { containsFiles } from '@atlaskit/pragmatic-drag-and-drop/utils/contains-files';
import { getFiles } from '@atlaskit/pragmatic-drag-and-drop/utils/get-files';

import { isServer } from '@mmstack/primitives';
import { deriveHit } from '../internal/hit';
import { boxData, mapDropTargets } from '../internal/payload';
import { resolveSignal } from '../internal/resolve';
import type { DropTargetInfo, Resolvable } from '../internal/types';

type ExternalLocation = {
  current: { dropTargets: readonly { element: Element }[] };
};

const targetsOf = (location: ExternalLocation): readonly Element[] =>
  location.current.dropTargets.map((t) => t.element);

/**
 * Ambient session for **external** drags (files / data dragged in from outside
 * the page). Mirrors `DndSession` but bridges `monitorForExternal`. Per-target
 * state is derived from it.
 *
 * @internal Drive file drops through {@link fileDropTarget} / {@link monitorExternal}, not this class.
 */
@Injectable({ providedIn: 'root' })
export class DndExternalSession {
  private readonly _active = signal(false);
  private readonly _targets = signal<readonly Element[]>([]);

  /** Innermost-first drop-target elements under the pointer. */
  readonly targets: Signal<readonly Element[]> = this._targets.asReadonly();
  /** True while a file drag from outside the page is in progress. */
  readonly active: Signal<boolean> = this._active.asReadonly();

  constructor() {
    if (isServer()) return;
    const cleanup = monitorForExternal({
      // File-centric: gate on containsFiles so text/links/images don't activate.
      onDragStart: ({ source, location }) => {
        if (!containsFiles({ source })) return;
        this._active.set(true);
        this._targets.set(targetsOf(location));
      },
      onDropTargetChange: ({ source, location }) => {
        if (!containsFiles({ source })) return;
        this._targets.set(targetsOf(location));
      },
      onDrop: () => {
        this._active.set(false);
        this._targets.set([]);
      },
    });
    inject(DestroyRef).onDestroy(cleanup);
  }
}

export type FileDropEvent = {
  files: File[];
  location: { current: DropTargetInfo[]; previous: DropTargetInfo[] };
};

export type CreateFileDropTargetOptions<TSelf = void> = {
  data?: Resolvable<TSelf>;
  /** Extra gate beyond "contains files". */
  canDrop?: (args: { types: readonly string[] }) => boolean;
  disabled?: Resolvable<boolean>;
  sticky?: Resolvable<boolean>;
  dropEffect?: Resolvable<'copy' | 'link' | 'move'>;
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: (event: FileDropEvent) => void;
};

export type FileDropTargetRef = {
  isDragOver: Signal<boolean>;
  isInnermost: Signal<boolean>;
};

const NOOP: FileDropTargetRef = {
  isDragOver: computed(() => false),
  isInnermost: computed(() => false),
};

/**
 * Makes the host element a drop target for **files dragged from outside the
 * browser** (the external adapter). `isDragOver`/`isInnermost` derive from the
 * ambient {@link DndExternalSession}; `onDrop` receives the extracted `File[]`.
 *
 * @example
 * ```ts
 * @Component({ host: { '[class.over]': 'drop.isDragOver()' } })
 * export class Uploader {
 *   protected readonly drop = fileDropTarget({
 *     onDrop: ({ files }) => this.upload(files),   // files: File[]
 *   });
 * }
 * ```
 */
export function fileDropTarget<TSelf = void>(
  opts: CreateFileDropTargetOptions<TSelf> = {},
): FileDropTargetRef {
  const injector = opts.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => {
    if (isServer()) return NOOP;

    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const ext = inject(DndExternalSession);
    const selfData = opts.data ? resolveSignal(opts.data) : undefined;
    const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
    const sticky = opts.sticky ? resolveSignal(opts.sticky) : undefined;
    const dropEffect = opts.dropEffect
      ? resolveSignal(opts.dropEffect)
      : undefined;

    const hitIndex = computed(() =>
      ext.targets().findIndex((e) => e === element),
    );
    const { isDragOver, isInnermost } = deriveHit(hitIndex);

    const cleanup = dropTargetForExternal({
      element,
      getData: selfData ? () => boxData(untracked(selfData)) : undefined,
      getIsSticky: sticky ? () => untracked(sticky) : undefined,
      getDropEffect: dropEffect ? () => untracked(dropEffect) : undefined,
      canDrop: ({ source }) => {
        if (disabled && untracked(disabled)) return false;
        if (!containsFiles({ source })) return false;
        return opts.canDrop?.({ types: source.types }) ?? true;
      },
      onDragEnter: opts.onDragEnter ? () => opts.onDragEnter?.() : undefined,
      onDragLeave: opts.onDragLeave ? () => opts.onDragLeave?.() : undefined,
      onDrop: ({ source, location }) => {
        opts.onDrop?.({
          files: getFiles({ source }),
          location: {
            current: mapDropTargets(location.current.dropTargets),
            previous: mapDropTargets(location.previous.dropTargets),
          },
        });
      },
    });
    inject(DestroyRef).onDestroy(cleanup);

    return { isDragOver, isInnermost };
  });
}

export type MonitorExternalOptions = {
  /** Injector to run in; defaults to the current injection context. */
  injector?: Injector;
  onDragStart?: (event: { types: readonly string[] }) => void;
  onDrop?: (event: FileDropEvent) => void;
};

export type MonitorExternalRef = { isDragging: Signal<boolean> };

/** Observe external (file) drags globally. `isDragging` derives from the ambient session. */
export function monitorExternal(
  opts: MonitorExternalOptions = {},
): MonitorExternalRef {
  const injector = opts.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => {
    if (isServer()) {
      return { isDragging: computed(() => false) };
    }

    const ext = inject(DndExternalSession);
    const isDragging = ext.active;

    if (opts.onDragStart || opts.onDrop) {
      const cleanup = monitorForExternal({
        onDragStart: opts.onDragStart
          ? ({ source }) => opts.onDragStart?.({ types: source.types })
          : undefined,
        onDrop: opts.onDrop
          ? ({ source, location }) =>
              opts.onDrop?.({
                files: getFiles({ source }),
                location: {
                  current: mapDropTargets(location.current.dropTargets),
                  previous: mapDropTargets(location.previous.dropTargets),
                },
              })
          : undefined,
      });
      inject(DestroyRef).onDestroy(cleanup);
    }

    return { isDragging };
  });
}
