export type { Point } from '../sortable/geometry';
export {
  boxContainsPoint,
  clamp,
  clampBox,
  clampPoint,
  containsBox,
  gridStep,
  intersects,
  normalizeRect,
  snapToGrid,
  unionBox,
  type Box,
  type CanvasFrame,
  type GridSpec,
} from './geometry';
export {
  bestOffset,
  collectGuides,
  nearestEdge,
  snapResizeBox,
  snapToTargets,
  type Guide,
} from './snap';
export {
  angleOf,
  applyResize,
  normalizeAngle,
  resolveMove,
  resolveResize,
  resolveRotate,
  type ApplyResizeConfig,
  type ResizeDirection,
  type ResolveMoveConfig,
  type ResolveResizeConfig,
} from './transform';
export {
  arbitrate,
  CANVAS_HANDLE_ATTR,
  CANVAS_ITEM_ATTR,
  CANVAS_RESIZE_ATTR,
  CANVAS_ROTATE_ATTR,
  type Arbitration,
} from './arbiter';
export {
  canvasSession,
  IDENTITY_TRANSFORM,
  type CanvasGesture,
  type CanvasSession,
  type CanvasSessionConfig,
  type CanvasSessionInput,
  type CanvasSpaceTransform,
} from './session';
export {
  canvas,
  injectCanvas,
  type CanvasCommitEvent,
  type CanvasCommitMode,
  type CanvasController,
  type CanvasItemState,
  type CanvasOptions,
  type CanvasReparentEvent,
  type CanvasSpace,
} from './controller';
export {
  Canvas,
  CanvasHandle,
  CanvasItem,
  CanvasResizeHandle,
  CanvasRotateHandle,
  connectCanvasItem,
  connectCanvasSurface,
  type CanvasItemBinding,
} from './directives';
export { selection, type SelectionRef } from './selection';
export { panZoom, type PanZoomOptions, type PanZoomRef } from './pan-zoom';
// à-la-carte single-element primitives (the canvas() controller subsumes them
// for full surfaces; these are the building blocks for bespoke interactions)
export { movable, Movable, type MovableOptions, type MovableRef } from './movable';
export {
  resizeHandle,
  ResizeHandle,
  type ResizeHandleOptions,
  type ResizeHandleRef,
} from './resizable';
export {
  rotatable,
  RotateHandle,
  type RotatableOptions,
  type RotatableRef,
} from './rotatable';
export { marquee, type MarqueeItem, type MarqueeOptions, type MarqueeRef } from './marquee';
export {
  injectCanvasDefaults,
  provideCanvasDefaults,
  type CanvasDefaults,
} from './defaults';
