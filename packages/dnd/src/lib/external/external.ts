import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injectable,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  dropTargetForExternal,
  monitorForExternal,
} from '@atlaskit/pragmatic-drag-and-drop/external/adapter';
import {
  containsFiles,
  getFiles,
} from '@atlaskit/pragmatic-drag-and-drop/external/file';

import { toWritable } from '@mmstack/primitives';
import { deriveHit } from '../internal/hit';
import { boxData, mapDropTargets } from '../internal/payload';
import { resolveSignal } from '../internal/resolve';
import type { DropTargetInfo, Resolvable } from '../internal/types';

/** Structural shape of pragmatic's external monitor/drop callback args. */
type ExternalArgs = {
  source: { types: readonly string[] };
  location: {
    current: {
      input: { clientX: number; clientY: number };
      dropTargets: readonly { element: Element }[];
    };
  };
};

export type ExternalSession = {
  /** Native media types present on the drag (e.g. `'Files'`, `'text/uri-list'`). */
  readonly types: readonly string[];
  /** Innermost-first drop-target elements under the pointer. */
  readonly targets: readonly Element[];
  readonly pointer: { x: number; y: number };
};

function toExternalSession({
  source,
  location,
}: ExternalArgs): ExternalSession {
  return {
    types: source.types ?? [],
    targets: location.current.dropTargets.map((t) => t.element),
    pointer: {
      x: location.current.input.clientX,
      y: location.current.input.clientY,
    },
  };
}

/**
 * Ambient session for **external** drags (files / data dragged in from outside
 * the page). Mirrors `DndSession` but bridges `monitorForExternal`. Per-target
 * state is derived from it.
 *
 * @internal Drive file drops through {@link fileDropTarget} / {@link monitorExternal}, not this class.
 */
@Injectable({ providedIn: 'root' })
export class DndExternalSession {
  private readonly _types = signal<readonly string[] | null>(null);
  private readonly _targets = signal<readonly Element[]>([]);
  private readonly _pointer = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /** Native media types of the active external drag, or `null` when idle. */
  readonly types: Signal<readonly string[] | null> = this._types.asReadonly();
  /** Innermost-first drop-target elements under the pointer. */
  readonly targets: Signal<readonly Element[]> = this._targets.asReadonly();
  readonly pointer: Signal<{ x: number; y: number }> =
    this._pointer.asReadonly();
  readonly active = computed(() => this._types() !== null);

  /** Combined snapshot; recomputes when any slice changes. */
  readonly session = toWritable(
    computed<ExternalSession | null>(() => {
      const types = this._types();
      if (!types) return null;
      return { types, targets: this._targets(), pointer: this._pointer() };
    }),
    (session) => {
      if (!session) {
        this._types.set(null);
        this._targets.set([]);
        return;
      }
      this._types.set(session.types);
      this._targets.set(session.targets);
      this._pointer.set(session.pointer);
    },
  );

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;
    const cleanup = monitorForExternal({
      // File-centric: gate on containsFiles so text/links/images don't activate.
      onDragStart: (a) => {
        if (!containsFiles({ source: a.source })) return;
        const s = toExternalSession(a as ExternalArgs);
        this._types.set(s.types);
        this._targets.set(s.targets);
        this._pointer.set(s.pointer);
      },
      onDropTargetChange: (a) => {
        if (!containsFiles({ source: a.source })) return;
        const s = toExternalSession(a as ExternalArgs);
        this._targets.set(s.targets);
        this._pointer.set(s.pointer);
      },
      onDrop: () => {
        this._types.set(null);
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
    if (isPlatformServer(inject(PLATFORM_ID))) return NOOP;

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
    if (isPlatformServer(inject(PLATFORM_ID))) {
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
