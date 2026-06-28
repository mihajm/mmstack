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
  type DragKind,
  type DragSession,
  type DropTargetHit,
} from './lib/session';

export {
  provideDnd,
  resolveAnnounce,
  resolveAutoScroll,
  resolveHitbox,
  resolvePostMoveFlash,
  type AnnouncePlugin,
  type AutoScrollPlugin,
  type DndConfig,
  type DndPlugins,
  type HitboxPlugin,
  type PostMoveFlash,
} from './lib/provide';

export {
  Draggable,
  draggable,
  type CreateDraggableOptions,
  type DraggableRef,
} from './lib/element/draggable';

export {
  DropTarget,
  dropTarget,
  type CreateDropTargetOptions,
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
