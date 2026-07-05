import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  PLATFORM_ID,
  runInInjectionContext,
  type Signal,
  untracked,
} from '@angular/core';

import { injectAnnounce } from '../a11y/a11y';
import { driveGesture } from '../internal/gesture';
import { resolveAutoScroll } from '../provide';
import { arbitrate, CANVAS_ITEM_ATTR } from './arbiter';
import type { CanvasController, CanvasItemState } from './controller';
import type { ResizeDirection } from './transform';

/**
 * Surface wiring: the ONE delegated gesture (arbitrated into move / resize /
 * rotate / marquee), plain-click selection semantics, two-axis edge
 * auto-scroll, and the a11y announce sink. Injection context only.
 */
export function connectCanvasSurface<T, K = unknown>(
  controller: () => CanvasController<T, K>,
  element?: HTMLElement,
): void {
  const el =
    element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  if (isPlatformServer(inject(PLATFORM_ID))) return;
  const injector = inject(Injector);

  const getAutoScroll = resolveAutoScroll(injector);
  const stops: (() => void)[] = [];
  const startAutoScroll = (): void => {
    const c = untracked(controller);
    if (!c.autoScroll || stops.length) return;
    const plugin = getAutoScroll();
    if (!plugin) return;
    const deltas = { x: 0, y: 0 };
    for (const axis of ['x', 'y'] as const) {
      stops.push(
        plugin({
          element: el,
          axis,
          pointer: () => driver.pointer,
          edge: c.autoScroll.edge,
          speed: c.autoScroll.speed,
          edgeProportion: c.autoScroll.edgeProportion,
          maxSpeedAt: c.autoScroll.maxSpeedAt,
          onScroll: (d: number) => {
            deltas[axis] = d;
            c.setScrollDelta(deltas.x, deltas.y);
          },
        }),
      );
    }
  };
  const stopAutoScroll = (): void => {
    for (const stop of stops) stop();
    stops.length = 0;
  };

  const driver = { pointer: { x: 0, y: 0 } };

  // Click-driven selection. Two traps: pointer capture retargets the click to
  // the surface (so the real target is recorded on capture-phase pointerdown),
  // and the click fires BEFORE the gesture effect processes the release (so
  // drag-vs-click is decided by press distance, not gesture state).
  let pressTarget: Element | null = null;
  let pressPoint = { x: 0, y: 0 };
  const onPointerDown = (e: PointerEvent): void => {
    pressTarget = e.target as Element | null;
    pressPoint = { x: e.clientX, y: e.clientY };
  };
  const onClick = (e: MouseEvent): void => {
    const target = pressTarget;
    pressTarget = null;
    const c = untracked(controller);
    const dx = e.clientX - pressPoint.x;
    const dy = e.clientY - pressPoint.y;
    const threshold = c.activationThreshold;
    if (dx * dx + dy * dy >= threshold * threshold) return;
    const arb = arbitrate(target, el);
    if (arb.mode === 'move') {
      const k = c.keyForElement(arb.itemEl);
      if (k !== undefined) c.press(k, e.shiftKey);
    } else if (arb.mode === 'marquee') {
      c.clearPress();
    }
  };

  // deferred: a required `controller` input isn't readable at construction
  afterNextRender(
    () => {
      const c = controller();
      c.setSurface(el);
      let announce: ((message: string) => void) | undefined;
      c.setAnnounce((message) => {
        announce ??= runInInjectionContext(injector, () => injectAnnounce());
        announce(message);
      });

      const live = runInInjectionContext(injector, () =>
        driveGesture(
          el,
          {
            begin: (origin, start, modifiers) => {
              const arb = arbitrate(origin, el);
              return untracked(controller).beginFromPress(
                arb,
                start,
                modifiers.shift,
              );
            },
            move: (p, modifiers) => untracked(controller).move(p, modifiers),
            end: () => untracked(controller).end(),
            cancel: () => untracked(controller).cancel(),
            onDragStart: startAutoScroll,
            onDragEnd: stopAutoScroll,
          },
          {
            activationThreshold: untracked(controller).activationThreshold,
            stopPropagation: true,
          },
        ),
      );
      driver.pointer = live.pointer;
      el.addEventListener('pointerdown', onPointerDown, true);
      el.addEventListener('click', onClick);
      el.setAttribute('data-mm-canvas-ready', ''); // gestures wired (style/test seam)
    },
    { injector },
  );

  inject(DestroyRef).onDestroy(() => {
    el.removeEventListener('pointerdown', onPointerDown, true);
    el.removeEventListener('click', onClick);
    stopAutoScroll();
    untracked(controller).dispose();
  });
}

/** Per-item binding: rendered box + transform + keyboard. */
export type CanvasItemBinding<K = unknown> = CanvasItemState<K> & {
  readonly tabIndex: Signal<number | null>;
  onKeydown(event: KeyboardEvent): void;
};

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Item wiring: registration + rendered-state bindings + keyboard (arrows
 * nudge the selection by a grid step, Shift = ×10, Cmd/Ctrl+arrows resize).
 */
export function connectCanvasItem<T, K = unknown>(
  controller: () => CanvasController<T, K>,
  item: () => T,
  element?: HTMLElement,
): CanvasItemBinding<K> {
  const el =
    element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const injector = inject(Injector);

  afterNextRender(
    () => {
      const c = controller();
      c.register(c.key(item()), el);
    },
    { injector },
  );
  inject(DestroyRef).onDestroy(() => {
    const c = untracked(controller);
    c.unregister(c.key(untracked(item)), el);
  });

  let inner: CanvasItemState<K> | undefined;
  const get = () => (inner ??= controller().itemState(item));

  const onKeydown = (event: KeyboardEvent): void => {
    const c = controller();
    if (!c.keyboard) return;
    const dir = ARROWS[event.key];
    if (!dir) return;
    const k = c.key(item());
    if (!c.selection.has(k)) c.selection.set([k]);
    const resize = event.metaKey || event.ctrlKey;
    const moved = resize
      ? c.nudgeResize(dir.x, dir.y, event.shiftKey)
      : c.nudge(dir.x, dir.y, event.shiftKey);
    if (moved) event.preventDefault();
  };

  return {
    itemKey: computed(() => get().itemKey()),
    participating: computed(() => get().participating()),
    selected: computed(() => get().selected()),
    leftPx: computed(() => get().leftPx()),
    topPx: computed(() => get().topPx()),
    widthPx: computed(() => get().widthPx()),
    heightPx: computed(() => get().heightPx()),
    transformCss: computed(() => get().transformCss()),
    tabIndex: computed(() => (controller().keyboard ? 0 : null)),
    onKeydown,
  };
}

/**
 * The canvas surface: `<div [mmCanvas]="ctrl">`. Owns the single delegated
 * gesture; render items (and your selection chrome / guides SVG) inside it.
 */
@Directive({
  selector: '[mmCanvas]',
  exportAs: 'mmCanvas',
  host: {
    '[style.position]': "'relative'",
    '[style.touch-action]': "'none'",
  },
})
export class Canvas<T, K = unknown> {
  readonly controller = input.required<CanvasController<T, K>>({
    alias: 'mmCanvas',
  });
  constructor() {
    connectCanvasSurface<T, K>(() => this.controller());
  }
}

/**
 * A canvas item: `<div [mmCanvasItem]="widget">`. Positions itself from the
 * rendered frame (remote overlays win), free-follows via transform while
 * dragged, and carries the keyboard.
 */
@Directive({
  selector: '[mmCanvasItem]',
  exportAs: 'mmCanvasItem',
  host: {
    [CANVAS_ITEM_ATTR]: '',
    '[attr.tabindex]': 'state.tabIndex()',
    '[style.position]': "'absolute'",
    '[style.left.px]': 'state.leftPx()',
    '[style.top.px]': 'state.topPx()',
    '[style.width.px]': 'state.widthPx()',
    '[style.height.px]': 'state.heightPx()',
    '[style.transform]': 'state.transformCss()',
    '[style.user-select]': "'none'",
    '[style.zIndex]': 'state.participating() ? 1 : null',
    '[class.mm-canvas-selected]': 'state.selected()',
    '[class.mm-canvas-dragging]': 'state.participating()',
    '(keydown)': 'state.onKeydown($event)',
  },
})
export class CanvasItem<T, K = unknown> {
  readonly item = input.required<T>({ alias: 'mmCanvasItem' });
  private readonly parent = inject<Canvas<T, K>>(Canvas);
  protected readonly state = connectCanvasItem<T, K>(
    () => this.parent.controller(),
    () => this.item(),
  );
}

/** A move handle inside an item — scopes dragging to itself. */
@Directive({
  selector: '[mmCanvasHandle]',
  host: { 'data-mm-canvas-handle': '', '[style.touch-action]': "'none'" },
})
export class CanvasHandle {}

/**
 * A resize handle (selection chrome): `<div mmCanvasResizeHandle="se">`.
 * Acts on the single selected item; render inside or outside items.
 */
@Directive({
  selector: '[mmCanvasResizeHandle]',
  host: {
    '[attr.data-mm-canvas-resize]': 'direction()',
    '[style.touch-action]': "'none'",
  },
})
export class CanvasResizeHandle {
  readonly direction = input<ResizeDirection>('se', {
    alias: 'mmCanvasResizeHandle',
  });
}

/** A rotate handle (selection chrome) — acts on the single selected item. */
@Directive({
  selector: '[mmCanvasRotateHandle]',
  host: { 'data-mm-canvas-rotate': '', '[style.touch-action]': "'none'" },
})
export class CanvasRotateHandle {}
