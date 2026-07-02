import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  isDevMode,
  isSignal,
  PLATFORM_ID,
  type Signal,
} from '@angular/core';
import { throttled } from '../throttled';
import { runInSensorContext, type SensorRunOptions } from './sensor-options';

export type PointerPoint = { x: number; y: number };

export type PointerModifiers = {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
};

export type PointerDragState = {
  /** A gesture is past the activation threshold (distinguishes a drag from a click). */
  active: boolean;
  /** Pointer position at the pointerdown that began the gesture. */
  start: PointerPoint;
  /** Latest pointer position. */
  current: PointerPoint;
  /** `current - start`, computed on the same update as `current` (never torn). */
  delta: PointerPoint;
  /** The captured pointer id, or `null` when idle. */
  pointerId: number | null;
  /** Modifier keys at the latest update. */
  modifiers: PointerModifiers;
  /** Mouse button that started the gesture (`-1` when idle). */
  button: number;
  /** The pointing device: `'mouse' | 'touch' | 'pen'` (`''` when idle). */
  pointerType: string;
  /**
   * The element the gesture started on: the `handleSelector` match when one is
   * set (so a single delegated listener can tell which child started the drag),
   * otherwise the listener's element. `null` when idle.
   */
  origin: HTMLElement | null;
  /**
   * Whether the LAST gesture ended by being aborted (`pointercancel` /
   * `lostpointercapture` / Escape / `cancel()`) rather than a normal `pointerup`.
   * Only meaningful on the idle transition — consumers ending a drag branch on it
   * to distinguish "drop here" from "abort". Sticky until the next `pointerdown`.
   */
  cancelled: boolean;
};

export type PointerDragOptions = SensorRunOptions & {
  /**
   * Element that receives `pointerdown`. An `HTMLElement`, `ElementRef`, or a
   * `Signal` of one (listeners re-attach when it changes). Defaults to the host
   * `ElementRef`.
   */
  target?:
    | HTMLElement
    | ElementRef<HTMLElement>
    | Signal<HTMLElement | ElementRef<HTMLElement> | null | undefined>;
  /** `'client'` (viewport) or `'page'` coordinates. @default 'client' */
  coordinateSpace?: 'client' | 'page';
  /** Pixels the pointer must travel before `active` flips true. @default 3 */
  activationThreshold?: number;
  /**
   * Throttle (ms) for `current`/`delta` updates. @default 16
   *
   * Note: a final sub-throttle move right before `pointerup` may not surface on
   * the throttled view (it coalesces into the terminal idle). Logic that must act
   * on the *exact* release position should read {@link PointerDragSignal.unthrottled}.
   */
  throttle?: number;
  /** Only start when the pointerdown target matches this selector (delegated handles). */
  handleSelector?: string;
  /** Mouse buttons that may start a gesture. @default [0] (primary) */
  buttons?: number[];
  /**
   * Stop the `pointerdown` from propagating once this sensor claims it. Lets an
   * inner sensor win over an outer one on the same element tree (e.g. a nested
   * sortable inside another). @default false
   */
  stopPropagation?: boolean;
};

type InternalPointerDragSignal = Signal<PointerDragState> & {
  unthrottled: Signal<PointerDragState>;
  cancel: () => void;
};

/** A gesture signal with an `unthrottled` view and an imperative `cancel()`. */
export type PointerDragSignal = Signal<PointerDragState> & {
  readonly unthrottled: Signal<PointerDragState>;
  /** Abort the current gesture and reset to idle (e.g. on Escape / programmatically). */
  cancel: () => void;
};

const IDLE: PointerDragState = {
  active: false,
  start: { x: 0, y: 0 },
  current: { x: 0, y: 0 },
  delta: { x: 0, y: 0 },
  pointerId: null,
  modifiers: { shift: false, alt: false, ctrl: false, meta: false },
  button: -1,
  pointerType: '',
  origin: null,
  cancelled: false,
};

/** Terminal state of an aborted gesture — same idle shape, `cancelled: true`. */
const CANCELLED: PointerDragState = { ...IDLE, cancelled: true };

function stateEqual(a: PointerDragState, b: PointerDragState): boolean {
  return (
    a.active === b.active &&
    a.cancelled === b.cancelled &&
    a.pointerId === b.pointerId &&
    a.current.x === b.current.x &&
    a.current.y === b.current.y &&
    a.button === b.button &&
    a.pointerType === b.pointerType &&
    a.origin === b.origin &&
    a.modifiers.shift === b.modifiers.shift &&
    a.modifiers.alt === b.modifiers.alt &&
    a.modifiers.ctrl === b.modifiers.ctrl &&
    a.modifiers.meta === b.modifiers.meta
  );
}

/**
 * Tracks a pointer *gesture* (pointerdown → capture → move → up) as a signal —
 * the foundation for pointer-based drag/move/resize/marquee on a canvas. Unlike
 * native HTML5 drag, pointer events fire continuously and coordinates are
 * reliable. SSR-safe; cleans up its listeners automatically.
 *
 * @example
 * ```ts
 * const drag = pointerDrag({ activationThreshold: 4 });
 * const position = computed(() => {
 *   const d = drag();
 *   return d.active ? { x: base.x + d.delta.x, y: base.y + d.delta.y } : base;
 * });
 * ```
 */
export function pointerDrag(opt?: PointerDragOptions): PointerDragSignal {
  return runInSensorContext(opt?.injector, () => createPointerDrag(opt));
}

function createPointerDrag(opt?: PointerDragOptions): PointerDragSignal {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const base = computed(() => IDLE, {
      debugName: opt?.debugName ?? 'pointerDrag',
    }) as InternalPointerDragSignal;
    base.unthrottled = base;
    base.cancel = () => undefined;
    return base;
  }

  const hostRef = inject(ElementRef<HTMLElement>, { optional: true });
  const {
    target = hostRef?.nativeElement,
    coordinateSpace = 'client',
    activationThreshold = 3,
    throttle = 16,
    handleSelector,
    buttons = [0],
    stopPropagation = false,
    debugName = 'pointerDrag',
  } = opt ?? {};

  const resolve = (t: unknown): HTMLElement | null => {
    if (!t) return null;
    return t instanceof ElementRef ? t.nativeElement : (t as HTMLElement);
  };

  if (!isSignal(target) && !resolve(target)) {
    if (isDevMode())
      console.warn('pointerDrag: no target element (host ElementRef missing).');
    const base = computed(() => IDLE, { debugName }) as InternalPointerDragSignal;
    base.unthrottled = base;
    base.cancel = () => undefined;
    return base;
  }

  const state = throttled(IDLE, {
    ms: throttle,
    leading: true,
    trailing: true,
    equal: stateEqual,
    debugName,
  });

  const threshold2 = activationThreshold * activationThreshold;

  let startPoint: PointerPoint = { x: 0, y: 0 };
  let activePointerId: number | null = null;
  let activeButton = -1;
  let activePointerType = '';
  let activeOrigin: HTMLElement | null = null;
  let activated = false;
  let gesture: AbortController | null = null;

  const coord = (e: PointerEvent): PointerPoint =>
    coordinateSpace === 'page'
      ? { x: e.pageX, y: e.pageY }
      : { x: e.clientX, y: e.clientY };

  const mods = (e: PointerEvent): PointerModifiers => ({
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
  });

  const end = (cancelled = false): void => {
    gesture?.abort();
    gesture = null;
    activePointerId = null;
    activeButton = -1;
    activePointerType = '';
    activeOrigin = null;
    activated = false;
    state.set(cancelled ? CANCELLED : IDLE);
    state.flush(); // terminal transition: reflect idle now, not on the trailing edge
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== activePointerId) return;
    const current = coord(e);
    const delta = { x: current.x - startPoint.x, y: current.y - startPoint.y };
    if (!activated && delta.x * delta.x + delta.y * delta.y >= threshold2) {
      activated = true; // squared compare — no sqrt on the pre-activation path
    }
    state.set({
      active: activated,
      start: startPoint,
      current,
      delta,
      pointerId: activePointerId,
      modifiers: mods(e),
      button: activeButton, // pointermove button is -1; keep the down-button
      pointerType: activePointerType,
      origin: activeOrigin,
      cancelled: false,
    });
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId === activePointerId) end();
  };

  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId === activePointerId) end(true);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && activePointerId !== null) end(true);
  };

  const onDown = (el: HTMLElement) => (e: PointerEvent): void => {
    if (activePointerId !== null) return;
    if (!buttons.includes(e.button)) return;
    const matched = handleSelector
      ? ((e.target as Element)?.closest?.(handleSelector) as HTMLElement | null)
      : el;
    if (!matched) return; // handleSelector set but pointerdown landed outside a handle
    if (stopPropagation) e.stopPropagation(); // claim it: an outer sensor won't also start
    activePointerId = e.pointerId;
    activeButton = e.button;
    activePointerType = e.pointerType;
    activeOrigin = matched;
    activated = false;
    startPoint = coord(e);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported (older browsers / test env) — listeners still work
    }
    gesture = new AbortController();
    const signal = gesture.signal;
    el.addEventListener('pointermove', onMove as EventListener, { signal });
    el.addEventListener('pointerup', onUp as EventListener, { signal });
    el.addEventListener('pointercancel', onCancel as EventListener, { signal });
    el.addEventListener('lostpointercapture', onCancel as EventListener, {
      signal,
    });
    window.addEventListener('keydown', onKey, { signal });
    state.set({
      active: false,
      start: startPoint,
      current: startPoint,
      delta: { x: 0, y: 0 },
      pointerId: e.pointerId,
      modifiers: mods(e),
      button: e.button,
      pointerType: activePointerType,
      origin: activeOrigin,
      cancelled: false,
    });
  };

  const attach = (el: HTMLElement): (() => void) => {
    const controller = new AbortController();
    el.addEventListener('pointerdown', onDown(el) as EventListener, {
      signal: controller.signal,
    });
    return () => {
      controller.abort();
      end(true); // teardown mid-gesture is an abort, not a drop
    };
  };

  if (isSignal(target)) {
    effect((cleanup) => {
      const el = resolve(target());
      if (!el) return;
      cleanup(attach(el));
    });
  } else {
    const el = resolve(target);
    if (el) inject(DestroyRef).onDestroy(attach(el));
  }

  const base = state.asReadonly() as InternalPointerDragSignal;
  base.unthrottled = state.original;
  base.cancel = () => end(true);
  return base;
}
