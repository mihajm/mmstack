export type {
  DragHandleLike,
  DragMeta,
  DragStartEvent,
  DropEvent,
  DropTargetEvent,
  DropTargetInfo,
  Edge,
  Resolvable,
} from './lib/internal/types';

export { boxData, unboxData } from './lib/internal/payload';

export { resolveElement, resolveSignal } from './lib/internal/resolve';

export {
  injectDndActive,
  injectDndPointer,
  injectDndSession,
  injectDndTargets,
  provideDndSession,
  type DragEngine,
  type DragKind,
  type DragSession,
  type DropTargetHit,
} from './lib/session';

export {
  injectDndDefaults,
  provideDnd,
  provideDndDefaults,
  resolveAnnounce,
  resolveAutoScroll,
  resolveHitbox,
  resolvePostMoveFlash,
  type AnnouncePlugin,
  type AutoScrollPlugin,
  type DndConfig,
  type DndDefaults,
  type DndPlugins,
  type HitboxPlugin,
  type PostMoveFlash,
} from './lib/provide';

export {
  Draggable,
  draggable,
  injectDraggableDefaults,
  provideDraggableDefaults,
  type CreateDraggableOptions,
  type DraggableDefaults,
  type DraggableRef,
} from './lib/element/draggable';

export {
  DropTarget,
  dropTarget,
  injectDropTargetDefaults,
  provideDropTargetDefaults,
  type CreateDropTargetOptions,
  type DropTargetDefaults,
  type DropTargetRef,
} from './lib/element/drop-target';

export {
  monitor,
  type CreateMonitorOptions,
  type MonitorRef,
} from './lib/element/monitor';

export {
  fileDropTarget,
  monitorExternal,
  type CreateFileDropTargetOptions,
  type FileDropEvent,
  type FileDropTargetRef,
  type MonitorExternalOptions,
  type MonitorExternalRef,
} from './lib/external/external';

export { DragHandle } from './lib/element/drag-handle';

export { type PreviewConfig, type PreviewOffset } from './lib/element/preview';

export {
  AutoScroll,
  autoScroll,
  type AutoScrollOptions,
} from './lib/element/auto-scroll';

export { injectAnnounce, type Politeness } from './lib/a11y/a11y';

export {
  driveGesture,
  type DriveGestureOptions,
  type GestureAdapter,
  type GestureDriver,
  type GestureModifiers,
} from './lib/internal/gesture';

export { deriveHit } from './lib/internal/hit';

export * from './lib/sortable';

export * from './lib/grid';

export * from './lib/canvas';
