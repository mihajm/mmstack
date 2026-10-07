import { nestedEffect } from '@mmstack/primitives';

import {
  gatedPointerDrag,
  resolveTouchActivation,
  type TouchActivation,
} from './touch-activation';

/**
 * The engine-agnostic delegated-gesture chassis: ONE `pointerDrag`
 * on a container element, an adapter that claims (or declines) each press and
 * receives move/end/cancel, and a live pointer ref for auto-scroll plugins to
 * chase. Shared by the pointer sortable, the placement grid and the canvas
 * surface so gesture ownership rules (innermost claims via `stopPropagation`,
 * Escape cancels, activation threshold, touch long-press) never fork.
 * Injection context only.
 */
export type GestureModifiers = {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
};

export type GestureAdapter = {
  begin(
    origin: HTMLElement | null,
    start: { x: number; y: number },
    modifiers: GestureModifiers,
    button?: number,
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
  /**
   * Observe `pointerdown` in the capture phase — for surfaces whose own
   * capture-phase listeners stop propagation before the bubble phase (editor
   * shields). See {@link PointerDragOptions.capture}. @default false
   */
  capture?: boolean;
  /**
   * Touch presses wait for a long-press before they can start a drag (mouse
   * and pen never wait). See {@link TouchActivation}. Pair it with
   * `touch-action: manipulation` on the surface. @default off
   */
  touchActivation?: TouchActivation | false;
  /**
   * With `touchActivation` on, a touch press that starts inside an element
   * matching this selector skips the long-press and starts at once, like a
   * mouse press. Meant for small deliberate grips (resize, rotate) that carry
   * `touch-action: none` themselves.
   */
  touchImmediateSelector?: string;
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
  const drag = gatedPointerDrag({
    touchActivation: resolveTouchActivation(opts.touchActivation),
    touchImmediate: opts.touchImmediateSelector
      ? (origin) => !!origin?.closest(opts.touchImmediateSelector as string)
      : undefined,
    target: element,
    handleSelector: opts.handleSelector,
    activationThreshold: opts.activationThreshold,
    buttons: opts.buttons,
    stopPropagation: opts.stopPropagation ?? true,
    capture: opts.capture,
  });

  const pointer = { x: 0, y: 0 };
  let dragging = false;
  nestedEffect(() => {
    const g = drag.unthrottled();
    if (g.active && g.pointerId !== null) {
      pointer.x = g.current.x;
      pointer.y = g.current.y;
      if (
        !dragging &&
        adapter.begin(g.origin, g.start, g.modifiers, g.button)
      ) {
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
