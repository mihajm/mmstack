import { nestedEffect, pointerDrag } from '@mmstack/primitives';

/**
 * @internal The engine-agnostic delegated-gesture chassis: ONE `pointerDrag`
 * on a container element, an adapter that claims (or declines) each press and
 * receives move/end/cancel, and a live pointer ref for auto-scroll plugins to
 * chase. Shared by the pointer sortable, the placement grid and the canvas
 * surface so gesture ownership rules (innermost claims via `stopPropagation`,
 * Escape cancels, activation threshold) never fork. Injection context only.
 */
export type GestureModifiers = {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
};

export type GestureAdapter = {
  /**
   * A press activated: claim it from its delegated origin, or return `false`
   * to ignore (not our element, already dragging, unmeasurable...).
   */
  begin(
    origin: HTMLElement | null,
    start: { x: number; y: number },
    modifiers: GestureModifiers,
  ): boolean;
  move(point: { x: number; y: number }, modifiers: GestureModifiers): void;
  /** A real release — commit. */
  end(): void;
  /** Escape / pointercancel / teardown — abort without committing. */
  cancel(): void;
  /** After a successful claim (start auto-scroll etc.). */
  onDragStart?(): void;
  /** After end OR cancel. */
  onDragEnd?(): void;
};

export type DriveGestureOptions = {
  /** Delegate activation to elements matching this selector. */
  handleSelector?: string;
  /** Px the pointer must travel before the drag activates. */
  activationThreshold?: number;
  /** Mouse buttons that start the gesture. @default [0] */
  buttons?: number[];
  /** Claiming presses stop propagation so an ancestor container doesn't also start. @default true */
  stopPropagation?: boolean;
};

export type GestureDriver = {
  /** Live viewport pointer, mutated per frame — auto-scroll plugins read it. */
  readonly pointer: { x: number; y: number };
};

export function driveGesture(
  element: HTMLElement,
  adapter: GestureAdapter,
  opts: DriveGestureOptions = {},
): GestureDriver {
  const drag = pointerDrag({
    target: element,
    handleSelector: opts.handleSelector,
    activationThreshold: opts.activationThreshold,
    buttons: opts.buttons,
    stopPropagation: opts.stopPropagation ?? true,
  });

  const pointer = { x: 0, y: 0 };
  let dragging = false;
  nestedEffect(() => {
    const g = drag.unthrottled();
    if (g.active && g.pointerId !== null) {
      pointer.x = g.current.x;
      pointer.y = g.current.y;
      if (!dragging && adapter.begin(g.origin, g.start, g.modifiers)) {
        dragging = true;
        adapter.onDragStart?.();
      }
      if (dragging) adapter.move(g.current, g.modifiers);
    } else if (dragging) {
      if (g.cancelled) adapter.cancel();
      else adapter.end();
      dragging = false;
      adapter.onDragEnd?.();
    }
  });

  return { pointer };
}
