import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  computed,
  Directive,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type Signal,
  untracked,
} from '@angular/core';

import { injectAnnounce } from '../a11y/a11y';
import { driveGesture } from '../internal/gesture';
import { resolveAutoScroll } from '../provide';
import type {
  PlacementGridController,
  PlacementGridItemState,
  PlacementResizeDirection,
} from './controller';
import type { GridPlacement } from './layout';

const ITEM_ATTR = 'data-mm-placement-item';
const RESIZE_ATTR = 'data-mm-placement-resize';
const HANDLE_ATTR = 'data-mm-placement-handle';
/** Presses delegate through handles and resize grips; a bare item is its own handle. */
const GRID_HANDLE_SELECTOR = `[${RESIZE_ATTR}],[${HANDLE_ATTR}],[${ITEM_ATTR}]`;

const DIRECTIONS: readonly PlacementResizeDirection[] = ['e', 's', 'se'];

/** What the grid container directive binds: sizing + the px unit for items. */
export type PlacementGridBinding = {
  /** Cell width px (live, from the container's measured width). */
  readonly unitX: Signal<number>;
  /** Cell height px (rowHeight option, or square = unitX). */
  readonly unitY: Signal<number>;
  /** Container height px covering the (preview) rows. */
  readonly heightPx: Signal<number>;
};

/**
 * Container wiring: the ONE delegated gesture (move + resize arbitration by
 * data attribute), two-axis edge auto-scroll, and the live cell-unit signals
 * items use to map cells to px. Injection context only.
 */
export function connectPlacementGrid<T extends GridPlacement, K = unknown>(
  controller: () => PlacementGridController<T, K>,
  element?: HTMLElement,
): PlacementGridBinding {
  const el =
    element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const server = isPlatformServer(inject(PLATFORM_ID));

  const width = signal(0);
  if (!server && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) width.set(w);
    });
    ro.observe(el);
    inject(DestroyRef).onDestroy(() => ro.disconnect());
  }

  const unitX = computed(() => {
    const c = untracked(controller);
    const cols = c.cols();
    const g = c.gap();
    const w = width();
    return w > 0 ? (w - g * (cols - 1)) / cols : 0;
  });
  const unitY = computed(() => {
    const c = untracked(controller);
    return c.rowHeight ? c.rowHeight() : unitX();
  });
  const heightPx = computed(() => {
    const c = untracked(controller);
    const rows = c.rows();
    if (rows <= 0) return 0;
    return rows * unitY() + (rows - 1) * c.gap();
  });

  if (server) {
    return { unitX, unitY, heightPx };
  }

  const injector = inject(Injector);

  // Two plugin instances — one per axis — so a tall AND wide grid scrolls both ways.
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

  inject(DestroyRef).onDestroy(() => {
    stopAutoScroll();
    untracked(controller).dispose();
  });

  // deferred: a required `controller` input isn't readable at construction
  const driver = { pointer: { x: 0, y: 0 } };
  afterNextRender(
    () => {
      controller().setContainer(el);
      const live = runInInjectionContext(injector, () =>
        driveGesture(
          el,
          {
            begin: (origin, start) => {
              const c = untracked(controller);
              if (!origin || untracked(c.activeKey) !== null) return false;
              const hit = origin.closest(`[${RESIZE_ATTR}],[${ITEM_ATTR}]`);
              if (!hit) return false;
              const itemEl = hit.hasAttribute(ITEM_ATTR)
                ? (hit as HTMLElement)
                : (hit.closest(`[${ITEM_ATTR}]`) as HTMLElement | null);
              const k = itemEl ? c.keyForElement(itemEl) : undefined;
              if (k === undefined) return false;
              const dir = hit.getAttribute(RESIZE_ATTR);
              if (dir !== null) {
                c.beginResizeGesture(
                  k,
                  DIRECTIONS.includes(dir as PlacementResizeDirection)
                    ? (dir as PlacementResizeDirection)
                    : 'se',
                  start,
                );
              } else {
                c.beginGesture(k, start);
              }
              return untracked(c.activeKey) !== null;
            },
            move: (p) => untracked(controller).move(p),
            end: () => untracked(controller).end(),
            cancel: () => untracked(controller).cancel(),
            onDragStart: startAutoScroll,
            onDragEnd: stopAutoScroll,
          },
          {
            handleSelector: GRID_HANDLE_SELECTOR,
            activationThreshold: untracked(controller).activationThreshold,
            stopPropagation: true,
          },
        ),
      );
      driver.pointer = live.pointer;
      el.setAttribute('data-mm-grid-ready', ''); // gestures wired (style/test seam)
    },
    { injector },
  );

  return { unitX, unitY, heightPx };
}

/** Per-item binding: preview-projected px styles + keyboard. */
export type PlacementGridItemBinding<K = unknown> = PlacementGridItemState<K> & {
  /** `translate(xPx, yPx)` — preview position, or free-follow while dragged. */
  readonly transformCss: Signal<string>;
  readonly widthPx: Signal<number>;
  readonly heightPx: Signal<number>;
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
 * Item wiring: registration, preview-projected px bindings and the keyboard
 * (arrows move a cell, Shift+arrows resize a cell; commits announce). The
 * array order never changes on a grid commit, so focus needs no restoring.
 */
export function connectPlacementGridItem<T extends GridPlacement, K = unknown>(
  controller: () => PlacementGridController<T, K>,
  item: () => T,
  unit: PlacementGridBinding,
  element?: HTMLElement,
): PlacementGridItemBinding<K> {
  const el =
    element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const injector = inject(Injector);

  afterNextRender(
    () => {
      const c = controller();
      const k = c.key(item());
      c.register(k, el);
    },
    { injector },
  );
  inject(DestroyRef).onDestroy(() => {
    const c = untracked(controller);
    c.unregister(c.key(untracked(item)), el);
  });

  let inner: PlacementGridItemState<K> | undefined;
  const get = () => (inner ??= controller().itemState(item));

  const px = (cells: number, unitPx: number, gapPx: number) =>
    cells * (unitPx + gapPx);

  const transformCss = computed(() => {
    const s = get();
    const c = controller();
    if (s.isActive() && c.projectedCell() !== null) {
      return `translate(${s.dragX()}px, ${s.dragY()}px)`;
    }
    const g = c.gap();
    return `translate(${px(s.cellX(), unit.unitX(), g)}px, ${px(s.cellY(), unit.unitY(), g)}px)`;
  });

  const widthPx = computed(() => {
    const s = get();
    const g = controller().gap();
    return s.spanW() * unit.unitX() + (s.spanW() - 1) * g;
  });
  const heightPx = computed(() => {
    const s = get();
    const g = controller().gap();
    return s.spanH() * unit.unitY() + (s.spanH() - 1) * g;
  });

  let announce: ((message: string) => void) | null | undefined;
  const getAnnounce = (): ((message: string) => void) | null => {
    if (announce === undefined) {
      announce = controller().announcePlace
        ? runInInjectionContext(injector, () => injectAnnounce())
        : null;
    }
    return announce;
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const c = controller();
    if (!c.keyboard) return;
    const dir = ARROWS[event.key];
    if (!dir) return;
    event.preventDefault();
    const it = item();
    const k = c.key(it);
    const ok = event.shiftKey
      ? c.resizeBy(k, dir.x, dir.y)
      : c.moveBy(k, dir.x, dir.y);
    const message = c.announcePlace;
    if (ok && message) {
      const placed = c.items().find((i) => c.key(i) === k);
      if (placed) {
        getAnnounce()?.(
          message({ item: it, x: placed.x, y: placed.y, w: placed.w, h: placed.h }),
        );
      }
    }
  };

  return {
    itemKey: computed(() => get().itemKey()),
    isActive: computed(() => get().isActive()),
    cellX: computed(() => get().cellX()),
    cellY: computed(() => get().cellY()),
    spanW: computed(() => get().spanW()),
    spanH: computed(() => get().spanH()),
    dragX: computed(() => get().dragX()),
    dragY: computed(() => get().dragY()),
    transitionCss: computed(() => get().transitionCss()),
    transformCss,
    widthPx,
    heightPx,
    tabIndex: computed(() => (controller().keyboard ? 0 : null)),
    onKeydown,
  };
}

/**
 * The grid container. Bind a {@link PlacementGridController}:
 * `<div [mmPlacementGrid]="grid">` — it owns the delegated gesture, sizes
 * itself to the (preview) rows, and exposes the cell units to items.
 */
@Directive({
  selector: '[mmPlacementGrid]',
  exportAs: 'mmPlacementGrid',
  host: {
    '[style.position]': "'relative'",
    '[style.display]': "'block'",
    '[style.height.px]': 'binding.heightPx()',
    '[style.--mm-grid-rows]': 'controller().rows()',
  },
})
export class PlacementGrid<T extends GridPlacement, K = unknown> {
  readonly controller = input.required<PlacementGridController<T, K>>({
    alias: 'mmPlacementGrid',
  });
  protected readonly binding = connectPlacementGrid<T, K>(() =>
    this.controller(),
  );
  /** Cell units for items (and consumer chrome like mask affordances). */
  get units(): PlacementGridBinding {
    return this.binding;
  }
}

/**
 * A grid item: `<div [mmPlacementGridItem]="widget">`. Positions itself by
 * transform from the live preview; add `[data-mm-placement-handle]` children
 * to scope dragging, and resize grips via {@link PlacementGridResizeHandle}.
 */
@Directive({
  selector: '[mmPlacementGridItem]',
  exportAs: 'mmPlacementGridItem',
  host: {
    [ITEM_ATTR]: '',
    '[attr.tabindex]': 'state.tabIndex()',
    '[style.position]': "'absolute'",
    '[style.top]': "'0'",
    '[style.left]': "'0'",
    '[style.touch-action]': "'none'",
    '[style.user-select]': "'none'",
    '[style.transform]': 'state.transformCss()',
    '[style.width.px]': 'state.widthPx()',
    '[style.height.px]': 'state.heightPx()',
    '[style.transition]': 'state.transitionCss()',
    '[style.zIndex]': 'state.isActive() ? 1 : null',
    '[class.mm-grid-dragging]': 'state.isActive()',
    '(keydown)': 'state.onKeydown($event)',
  },
})
export class PlacementGridItem<T extends GridPlacement, K = unknown> {
  readonly item = input.required<T>({ alias: 'mmPlacementGridItem' });
  private readonly parent = inject<PlacementGrid<T, K>>(PlacementGrid);
  protected readonly state = connectPlacementGridItem<T, K>(
    () => this.parent.controller(),
    () => this.item(),
    this.parent.units,
  );
}

/**
 * A resize grip inside an item: `<div mmPlacementGridResizeHandle="se">`.
 * The container's gesture arbitrates to a resize when the press lands here.
 */
@Directive({
  selector: '[mmPlacementGridResizeHandle]',
  host: {
    '[attr.data-mm-placement-resize]': 'direction()',
    '[style.touch-action]': "'none'",
  },
})
export class PlacementGridResizeHandle {
  readonly direction = input<PlacementResizeDirection>('se', {
    alias: 'mmPlacementGridResizeHandle',
  });
}
