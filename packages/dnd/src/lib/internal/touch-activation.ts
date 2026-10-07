import {
  computed,
  DestroyRef,
  effect,
  inject,
  isSignal,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  pointerDrag,
  type PointerDragOptions,
  type PointerDragSignal,
  type PointerDragState,
} from '@mmstack/primitives';

/**
 * Long-press activation for touch. A touch press must rest for `delay` ms
 * before it can become a drag; until then the page scrolls normally. Mouse and
 * pen presses are never delayed.
 *
 * - Moving more than `tolerance` px during the delay abandons the press, so the
 *   gesture stays a scroll.
 * - Lifting the finger, or the browser taking the touch over (`pointercancel`),
 *   during the delay abandons it too.
 * - Once the delay has passed, the drag proceeds as usual (it still starts
 *   after the activation threshold), and the page no longer scrolls for the
 *   rest of that touch.
 *
 * While it is set, the library's drag surfaces use `touch-action: manipulation`
 * instead of `none`, so a finger resting on an item can still scroll the page.
 */
export type TouchActivation = {
  /** Milliseconds a touch must rest before a drag can start. */
  readonly delay: number;
  /** Pixels a touch may wander during the delay before the press is abandoned. @default 5 */
  readonly tolerance?: number;
};

/** A resolved {@link TouchActivation}, or `null` when off. */
export type ResolvedTouchActivation = {
  readonly delay: number;
  readonly tolerance: number;
};

const DEFAULT_TOLERANCE = 5;

/** `false`, `undefined` or a non-positive delay mean off. */
export function resolveTouchActivation(
  value: TouchActivation | false | null | undefined,
): ResolvedTouchActivation | null {
  if (!value || !(value.delay > 0)) return null;
  return {
    delay: value.delay,
    tolerance: Math.max(0, value.tolerance ?? DEFAULT_TOLERANCE),
  };
}

/** The `touch-action` a drag surface carries: `manipulation` under a long-press, else `fallback`. */
export function surfaceTouchAction(
  touch: ResolvedTouchActivation | null,
  fallback: string,
): string {
  return touch ? 'manipulation' : fallback;
}

type Target = NonNullable<PointerDragOptions['target']>;

const resolveEl = (t: unknown): HTMLElement | null => {
  if (!t) return null;
  if (t instanceof HTMLElement) return t;
  const native = (t as { nativeElement?: unknown }).nativeElement;
  return native instanceof HTMLElement ? native : null;
};

/**
 * {@link pointerDrag} with an optional touch long-press in front of it. With
 * `touchActivation` off it IS `pointerDrag`. With it on, the returned signal
 * reports `active: false` for a touch gesture until the delay has passed, and
 * `onChange` sees the same gated states. Injection context only.
 */
export function gatedPointerDrag(
  opts: PointerDragOptions & {
    touchActivation?: ResolvedTouchActivation | null;
    /** A touch press starting on an element this accepts arms at once, like a mouse press. */
    touchImmediate?: (origin: HTMLElement | null) => boolean;
  },
): PointerDragSignal {
  const { touchActivation: touch, touchImmediate, onChange, ...rest } = opts;
  if (!touch) return pointerDrag({ ...rest, onChange });

  const tolerance2 = touch.tolerance * touch.tolerance;
  const armed = signal(false);
  let gesture: number | null = null;
  let isTouch = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const gate = (s: PointerDragState, on: boolean): PointerDragState =>
    s.active && !on ? { ...s, active: false } : s;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = false;
  };

  const drag = pointerDrag({
    ...rest,
    onChange: (s) => {
      if (s.pointerId === null) {
        clear();
        gesture = null;
        isTouch = false;
        armed.set(false);
        onChange?.(s);
        return;
      }
      if (s.pointerId !== gesture) {
        gesture = s.pointerId;
        isTouch = s.pointerType === 'touch';
        clear();
        if (isTouch && !touchImmediate?.(s.origin)) {
          armed.set(false);
          pending = true;
          timer = setTimeout(() => {
            timer = undefined;
            pending = false;
            armed.set(true);
            const now = untracked(drag.unthrottled);
            if (onChange && now.pointerId !== null) onChange(now);
          }, touch.delay);
        } else {
          armed.set(true);
        }
      } else if (pending) {
        const dx = s.current.x - s.start.x;
        const dy = s.current.y - s.start.y;
        if (dx * dx + dy * dy > tolerance2) {
          clear();
          drag.cancel(); // re-enters with the cancelled idle state
          return;
        }
      }
      onChange?.(gate(s, untracked(armed)));
    },
  });

  // Registered for the surface's whole life: a touchmove listener added only
  // once a touch has begun can be treated as passive by the browser.
  const onTouchMove = (e: TouchEvent) => {
    if (isTouch && gesture !== null && untracked(armed) && e.cancelable) {
      e.preventDefault();
    }
  };
  const onContextMenu = (e: Event) => {
    if (isTouch && gesture !== null) e.preventDefault();
  };
  const listen = (el: HTMLElement): (() => void) => {
    const ac = new AbortController();
    el.addEventListener('touchmove', onTouchMove, {
      passive: false,
      signal: ac.signal,
    });
    el.addEventListener('contextmenu', onContextMenu, { signal: ac.signal });
    return () => ac.abort();
  };

  const target = rest.target as Target | undefined;
  if (isSignal(target)) {
    effect((cleanup) => {
      const el = resolveEl((target as Signal<unknown>)());
      if (el) cleanup(listen(el));
    });
  } else {
    const el = resolveEl(target);
    if (el) inject(DestroyRef).onDestroy(listen(el));
  }

  const view = computed(() =>
    gate(drag(), armed()),
  ) as Signal<PointerDragState> & {
    unthrottled: Signal<PointerDragState>;
    cancel: () => void;
  };
  view.unthrottled = computed(() => gate(drag.unthrottled(), armed()));
  view.cancel = () => drag.cancel();
  return view as PointerDragSignal;
}
