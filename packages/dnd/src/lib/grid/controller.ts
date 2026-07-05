import {
  computed,
  inject,
  Injector,
  linkedSignal,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';

import { withDefaults } from '../provide';
import {
  insertIndexForMeasure,
  type MemberMeasure,
  type RectLike,
} from '../sortable/geometry';
import {
  getGroupInternals,
  type SortableGroup,
  type SortableGroupMember,
} from '../sortable/group';
import type { ReorderableAnimation } from '../sortable/types';
import { injectPlacementGridDefaults } from './defaults';
import {
  canPlaceAt,
  compactGrid,
  gridRows,
  moveGridItem,
  placeGridItem,
  resizeGridItem,
  validTargets,
  type GridPlacement,
} from './layout';

const DEFAULT_ANIMATION = {
  duration: 200,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;
const DEFAULT_AUTOSCROLL = { edge: 48, speed: 16 } as const;

export type PlacementResizeDirection = 'e' | 's' | 'se';

/**
 * Everything a placement drag needs, captured ONCE at gesture start: the
 * container's content origin and cell metrics (viewport px) plus the pointer
 * start. Pure math against this snapshot turns every later pointer frame into
 * a cell — no DOM reads mid-drag.
 */
export type PlacementDragSnapshot = {
  readonly kind: 'move' | 'resize';
  readonly direction?: PlacementResizeDirection;
  /** Container content origin, viewport px. */
  readonly originX: number;
  readonly originY: number;
  /** Cell size, px (excluding gap). */
  readonly cellW: number;
  readonly cellH: number;
  /** Gap between cells, px. */
  readonly gap: number;
  /** Pointer at gesture start, viewport px. */
  readonly startX: number;
  readonly startY: number;
};

export type PlacementGridItemState<K = unknown> = {
  readonly itemKey: Signal<K>;
  readonly isActive: Signal<boolean>;
  /** Rendered cell rect — the live preview during a drag, the source at rest. */
  readonly cellX: Signal<number>;
  readonly cellY: Signal<number>;
  readonly spanW: Signal<number>;
  readonly spanH: Signal<number>;
  /** Active item's free-follow position, px from the container origin. */
  readonly dragX: Signal<number>;
  readonly dragY: Signal<number>;
  readonly transitionCss: Signal<string>;
};

export type PlacementGridOptions<T extends GridPlacement, K> = {
  /** Stable identity for an item. */
  readonly key: (item: T) => K;
  /** Column count (reactive via getter). */
  readonly cols: number | (() => number);
  /** Row height px; defaults to the cell width (square cells). */
  readonly rowHeight?: number | (() => number);
  /** Gap between cells, px (both axes). @default 0 */
  readonly gap?: number | (() => number);
  /**
   * `'vertical'` (default): colliding items push down and gravity pulls
   * everything up — the dashboard reflow. `'none'`: nothing moves; a cell is
   * either free (see `canPlace`) or the drop is rejected — the form-builder
   * model, rendered from {@link PlacementGridController.targetMask}.
   */
  readonly compact?: 'vertical' | 'none';
  /** Extra placement validity on top of the built-in overlap/bounds check. */
  readonly canPlace?: (
    item: T,
    x: number,
    y: number,
    items: readonly T[],
  ) => boolean;
  /** Shared cross-container group — palette/list → grid and back. */
  readonly group?: SortableGroup<T>;
  /** Whether an item from another group member may drop here. */
  readonly canReceive?: (item: T) => boolean;
  /** Arrow keys move the focused item one cell; Shift+arrows resize. @default true */
  readonly keyboard?: boolean;
  /** Screen-reader message after a keyboard move/resize, `false` to disable. */
  readonly announcePlace?:
    | false
    | ((event: {
        item: T;
        x: number;
        y: number;
        w: number;
        h: number;
      }) => string);
  /** Sibling glide during the drag preview, or `false` for instant. */
  readonly animation?: ReorderableAnimation | false;
  /** Opt-in edge auto-scroll (both axes) while dragging. */
  readonly autoScroll?:
    | { edge?: number; speed?: number; edgeProportion?: number; maxSpeedAt?: number }
    | false;
  /** Px the pointer must travel before a drag activates. @default 5 */
  readonly activationThreshold?: number;
  readonly injector?: Injector;
  /** After a move commits (drop or keyboard). */
  readonly onPlace?: (event: {
    item: T;
    x: number;
    y: number;
    items: readonly T[];
  }) => void;
  /** After a resize commits. */
  readonly onResize?: (event: {
    item: T;
    w: number;
    h: number;
    items: readonly T[];
  }) => void;
  /** After an item arrives from another group member. */
  readonly onItemArrived?: (event: { item: T; x: number; y: number }) => void;
  /** After an item leaves for another group member. */
  readonly onItemLeft?: (event: { item: T }) => void;
};

export type PlacementGridController<
  T extends GridPlacement,
  K = unknown,
> = SortableGroupMember<T> & {
  readonly items: Signal<readonly T[]>;
  readonly key: (item: T) => K;
  readonly cols: () => number;
  readonly gap: () => number;
  /** Row height px, or `null` for square cells (the cell width). */
  readonly rowHeight: (() => number) | null;
  readonly compact: 'vertical' | 'none';
  /** Rows the (preview) layout occupies — drive the container's height. */
  readonly rows: Signal<number>;
  readonly activeKey: Signal<K | null>;
  /**
   * The active drag is currently over ANOTHER group member (a tray, a list) —
   * restyle the dragged item to preview what it will become there.
   */
  readonly crossTarget: Signal<boolean>;
  /** The active gesture's projected cell, or `null` (never-valid / idle). */
  readonly projectedCell: Signal<{ x: number; y: number } | null>;
  /** The live preview layout (the source array when idle). */
  readonly previewLayout: Signal<readonly T[]>;
  /**
   * `compact: 'none'` affordance mask for the active item (`mask[y*cols+x]`),
   * `null` outside a drag — render drop cells from it.
   */
  readonly targetMask: Signal<Uint8Array | null>;
  readonly keyboard: boolean;
  readonly announcePlace:
    | ((event: { item: T; x: number; y: number; w: number; h: number }) => string)
    | null;
  readonly animation: { duration: number; easing: string } | null;
  readonly autoScroll: {
    edge: number;
    speed: number;
    edgeProportion?: number;
    maxSpeedAt?: number;
  } | null;
  readonly activationThreshold: number;
  readonly group?: SortableGroup<T>;
  itemState(item: () => T): PlacementGridItemState<K>;
  /** Keyboard commit: move the item one step (clamped/validated). */
  moveBy(key: K, dx: number, dy: number): boolean;
  /** Keyboard commit: resize the item by whole cells (min 1×1). */
  resizeBy(key: K, dw: number, dh: number): boolean;
  /** Pure drag-start from a measured snapshot. Unit-testable without DOM. */
  begin(key: K, snapshot: PlacementDragSnapshot): void;
  /** @internal DOM edge: measure the container, then {@link begin} a move. */
  beginGesture(key: K, start: { x: number; y: number }): void;
  /** @internal DOM edge: measure, then {@link begin} a resize. */
  beginResizeGesture(
    key: K,
    direction: PlacementResizeDirection,
    start: { x: number; y: number },
  ): void;
  /** @internal feed a pointer move (viewport coords). */
  move(point: { x: number; y: number }): void;
  /** @internal end the drag, committing the preview (or a cross-container transfer). */
  end(): void;
  cancel(): void;
  dispose(): void;
  /** @internal item DOM registration. */
  register(key: K, el: HTMLElement): void;
  unregister(key: K, el: HTMLElement): void;
  keyForElement(el: HTMLElement): K | undefined;
  setContainer(el: HTMLElement | null): void;
  /** @internal auto-scroll compensation, px (x = horizontal, y = vertical). */
  setScrollDelta(x: number, y: number): void;
};

function resolveNum(
  v: number | (() => number) | undefined,
  fallback: number,
): () => number {
  if (v === undefined) return () => fallback;
  return typeof v === 'number' ? () => v : v;
}

/**
 * A controlled spanning grid (the Retool / react-grid-layout / form-builder
 * model): items own cell rects on a fixed-column grid; dragging projects the
 * pointer to a cell and PREVIEWS the reflow as pure derivation — the source
 * signal is written exactly once, at drop. `compact: 'none'` + `canPlace`
 * turns the same controller into a validity-masked grid (GridState mode).
 */
export function placementGrid<T extends GridPlacement, K>(
  source: WritableSignal<T[]>,
  opts: PlacementGridOptions<T, K>,
): PlacementGridController<T, K> {
  const options = withDefaults(
    opts,
    opts.injector ? injectPlacementGridDefaults(opts.injector) : null,
  );
  const { key, group } = options;
  const groupApi = group ? getGroupInternals(group) : null;
  const cols = resolveNum(options.cols, 12);
  const gap = resolveNum(options.gap, 0);
  const rowHeight = options.rowHeight
    ? resolveNum(options.rowHeight, 0)
    : null;
  const compact = options.compact ?? 'vertical';
  const keyboard = options.keyboard ?? true;
  const activationThreshold = options.activationThreshold ?? 5;
  const announcePlace =
    options.announcePlace === false
      ? null
      : (options.announcePlace ??
        ((e: { x: number; y: number; w: number; h: number }) =>
          `Moved to column ${e.x + 1}, row ${e.y + 1}`));
  const animation =
    options.animation === false
      ? null
      : {
          duration: options.animation?.duration ?? DEFAULT_ANIMATION.duration,
          easing: options.animation?.easing ?? DEFAULT_ANIMATION.easing,
        };
  const autoScroll = options.autoScroll
    ? {
        edge: options.autoScroll.edge ?? DEFAULT_AUTOSCROLL.edge,
        speed: options.autoScroll.speed ?? DEFAULT_AUTOSCROLL.speed,
        edgeProportion: options.autoScroll.edgeProportion,
        maxSpeedAt: options.autoScroll.maxSpeedAt,
      }
    : null;

  const byKey = new Map<K, HTMLElement>();
  const byEl = new Map<HTMLElement, K>();
  let container: HTMLElement | null = null;
  let boundsCache: RectLike | null = null;

  const activeKey = signal<K | null>(null);
  const pointerX = signal(0);
  const pointerY = signal(0);
  const scrollX = signal(0);
  const scrollY = signal(0);
  let snap: PlacementDragSnapshot | null = null;
  let dragStartItems: readonly T[] | null = null;
  let dragStartItem: T | null = null;

  const indexByKey = (arr: readonly T[], k: K) =>
    arr.findIndex((i) => key(i) === k);

  const placeGate = (item: T, x: number, y: number, items: readonly T[]) => {
    if (compact === 'none' && !canPlaceAt(items, key, key(item), x, y, item.w, item.h, cols())) {
      return false;
    }
    // untracked: a consumer predicate may read its own signals — the preview
    // derivation graph must not subscribe to them (same rule as canReceive)
    return options.canPlace
      ? untracked(() => options.canPlace?.(item, x, y, items)) !== false
      : true;
  };

  const stepX = () => (snap ? snap.cellW + snap.gap : 1);
  const stepY = () => (snap ? snap.cellH + snap.gap : 1);

  /** The projected cell (move) or spans (resize) — quantized, validated, sticky. */
  const projected = linkedSignal<
    { active: boolean; px: number; py: number },
    { x: number; y: number } | null
  >({
    source: () => ({
      active: activeKey() !== null,
      px: pointerX() + scrollX(),
      py: pointerY() + scrollY(),
    }),
    computation: ({ active, px, py }, prev) => {
      if (!active || !snap || !dragStartItem || !dragStartItems) return null;
      const it = dragStartItem;
      if (snap.kind === 'resize') {
        const dx = snap.direction !== 's' ? px - snap.startX : 0;
        const dy = snap.direction !== 'e' ? py - snap.startY : 0;
        const wPx = it.w * stepX() - snap.gap + dx;
        const hPx = it.h * stepY() - snap.gap + dy;
        const w = Math.max(1, Math.min(Math.round((wPx + snap.gap) / stepX()), cols() - it.x));
        const h = Math.max(1, Math.round((hPx + snap.gap) / stepY()));
        if (prev?.value && prev.value.x === w && prev.value.y === h) {
          return prev.value;
        }
        if (
          compact === 'none' &&
          !canPlaceAt(dragStartItems, key, key(it), it.x, it.y, w, h, cols())
        ) {
          return prev?.value ?? null;
        }
        return { x: w, y: h }; // spans, not cells, in resize mode
      }
      const basePxX = it.x * stepX();
      const basePxY = it.y * stepY();
      const cx = Math.round((basePxX + (px - snap.startX)) / stepX());
      const cy = Math.round((basePxY + (py - snap.startY)) / stepY());
      const x = Math.max(0, Math.min(cx, cols() - it.w));
      const maxY =
        compact === 'none' ? gridRows(dragStartItems) : Number.POSITIVE_INFINITY;
      const y = Math.max(0, Math.min(cy, maxY));
      if (prev?.value && prev.value.x === x && prev.value.y === y) {
        return prev.value;
      }
      if (!placeGate(it, x, y, dragStartItems)) {
        return prev?.value ?? null;
      }
      return { x, y };
    },
  });

  const previewLayout = computed<readonly T[]>(() => {
    const k = activeKey();
    if (k === null) return source();
    const p = projected();
    if (!p || !snap || !dragStartItems) return dragStartItems ?? source();
    if (snap.kind === 'resize') {
      if (compact === 'none') {
        return dragStartItems.map((i) =>
          key(i) === k ? { ...i, w: p.x, h: p.y } : i,
        );
      }
      return resizeGridItem(dragStartItems, key, k, p.x, p.y, cols());
    }
    if (compact === 'none') {
      return dragStartItems.map((i) =>
        key(i) === k ? { ...i, x: p.x, y: p.y } : i,
      );
    }
    return moveGridItem(dragStartItems, key, k, p.x, p.y, cols());
  });

  const previewMap = computed(() => {
    const map = new Map<K, T>();
    for (const it of previewLayout()) map.set(key(it), it);
    return map;
  });

  /**
   * A `compact: 'none'` drop may land below every occupied row, so during a
   * move the grid grows by the dragged item's own height — the same
   * make-room-while-hovering contract as a list's reserved space. `rows`
   * (and the container height bound to it) includes that headroom, so every
   * cell in {@link targetMask} stays inside the grid's border.
   */
  const dragRows = computed<number>(() => {
    if (compact !== 'none' || activeKey() === null) return 0;
    if (!dragStartItems || !dragStartItem || snap?.kind !== 'move') return 0;
    return gridRows(dragStartItems) + dragStartItem.h;
  });

  const rows = computed(() =>
    Math.max(gridRows(previewLayout()), dragRows()),
  );

  const targetMask = computed<Uint8Array | null>(() => {
    const k = activeKey();
    if (k === null || compact !== 'none' || !dragStartItems) return null;
    // origins deeper than the occupied rows are equivalent, minus dead space
    return validTargets(
      dragStartItems,
      key,
      k,
      cols(),
      gridRows(dragStartItems) + 1,
    );
  });

  const resetDragState = () => {
    activeKey.set(null);
    pointerX.set(0);
    pointerY.set(0);
    scrollX.set(0);
    scrollY.set(0);
    snap = null;
    dragStartItems = null;
    dragStartItem = null;
    if (groupApi && untracked(groupApi.activeSource) === self) {
      groupApi.clearActive();
    }
  };

  const commitLayout = (next: readonly T[]) => {
    // release the drag hold: gravity applies to the moved item too
    const settled = compact === 'vertical' ? compactGrid(next, key) : next;
    source.set(settled as T[]);
    return settled;
  };

  const measureSnapshot = (
    kind: 'move' | 'resize',
    direction: PlacementResizeDirection | undefined,
    start: { x: number; y: number },
  ): PlacementDragSnapshot | null => {
    if (!container) return null;
    const r = container.getBoundingClientRect();
    const g = gap();
    const c = cols();
    const cellW = (r.width - g * (c - 1)) / c;
    const cellH = rowHeight ? rowHeight() : cellW;
    if (cellW <= 0) return null;
    return {
      kind,
      direction,
      originX: r.left,
      originY: r.top,
      cellW,
      cellH,
      gap: g,
      startX: start.x,
      startY: start.y,
    };
  };

  const begin = (k: K, snapshot: PlacementDragSnapshot) => {
    const arr = untracked(source);
    const idx = indexByKey(arr, k);
    if (idx < 0) return;
    snap = snapshot;
    dragStartItems = arr;
    dragStartItem = arr[idx];
    pointerX.set(snapshot.startX);
    pointerY.set(snapshot.startY);
    scrollX.set(0);
    scrollY.set(0);
    activeKey.set(k);
    if (group) for (const m of group.members()) m.refreshBounds();
  };

  const measureCache = new Map<SortableGroupMember<T>, MemberMeasure>();
  const ensureMeasured = (m: SortableGroupMember<T>) => {
    let r = measureCache.get(m);
    if (!r) {
      r = m.measure();
      measureCache.set(m, r);
    }
    return r;
  };

  const move = (p: { x: number; y: number }) => {
    pointerX.set(p.x);
    pointerY.set(p.y);
    if (!group || !groupApi || untracked(activeKey) === null) return;
    if (snap?.kind === 'resize') return;
    const dragged = dragStartItem ?? undefined;
    const target = untracked(() =>
      group.targetAt(
        p.x,
        p.y,
        (m) =>
          m === self ||
          dragged === undefined ||
          m.canReceive?.(dragged) !== false,
      ),
    );
    if (!target) return;
    if (target === self) {
      if (untracked(groupApi.activeSource) === self) groupApi.clearActive();
      return;
    }
    const tg = ensureMeasured(target);
    groupApi.setActive({
      source: self,
      target,
      sourceIndex: dragStartItems && dragged ? indexByKey(dragStartItems, key(dragged)) : -1,
      insertIndex: insertIndexForMeasure(tg, p.x, p.y),
      footprint:
        tg.kind !== 'wrap' && tg.axis === 'x'
          ? (dragged?.w ?? 1) * stepX()
          : (dragged?.h ?? 1) * stepY(),
      targetMeasure: tg,
    });
  };

  const end = () => {
    const k = untracked(activeKey);
    if (k === null) return resetDragState();

    const crossTarget =
      groupApi &&
      untracked(groupApi.activeSource) === self &&
      untracked(groupApi.activeTarget) !== self
        ? untracked(groupApi.activeTarget)
        : null;

    if (crossTarget && groupApi && dragStartItem) {
      const item = dragStartItem;
      const to = untracked(groupApi.activeInsertIndex);
      const px = untracked(pointerX);
      const py = untracked(pointerY);
      const taken = crossTarget.insertAtPoint?.(item, px, py)
        ? true
        : to >= 0
          ? crossTarget.insertAt(item, to)
          : false;
      if (taken) {
        const next = untracked(source).filter((i) => key(i) !== k);
        source.set(
          (compact === 'vertical' ? compactGrid(next, key) : next) as T[],
        );
        options.onItemLeft?.({ item });
      }
      return resetDragState();
    }

    const p = untracked(projected);
    const wasResize = snap?.kind === 'resize';
    const preview = untracked(previewLayout);
    const item = dragStartItem;
    if (p && item) {
      const before = untracked(source);
      const settled = commitLayout(preview);
      if (settled !== before) {
        const placed = settled.find((i) => key(i) === k);
        if (placed) {
          if (wasResize) {
            options.onResize?.({ item, w: placed.w, h: placed.h, items: settled });
          } else {
            options.onPlace?.({ item, x: placed.x, y: placed.y, items: settled });
          }
        }
      }
    }
    resetDragState();
  };

  const findFirstFit = (
    items: readonly T[],
    item: T,
  ): { x: number; y: number } => {
    const c = cols();
    const maxY = gridRows(items) + item.h;
    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x <= c - item.w; x++) {
        if (
          canPlaceAt(items, key, key(item), x, y, item.w, item.h, c) &&
          (options.canPlace ? options.canPlace(item, x, y, items) !== false : true)
        ) {
          return { x, y };
        }
      }
    }
    return { x: 0, y: gridRows(items) };
  };

  const receive = (item: T, x: number, y: number): boolean => {
    const arr = untracked(source);
    const c = cols();
    const nx = Math.max(0, Math.min(x, c - item.w));
    const ny = Math.max(0, y);
    const placed = { ...item, x: nx, y: ny };
    if (!placeGate(placed, nx, ny, arr)) return false;
    if (compact === 'none') {
      source.set([...arr, placed] as T[]);
    } else {
      source.set(
        compactGrid(placeGridItem([...arr, placed], key, key(item)), key) as T[],
      );
    }
    options.onItemArrived?.({ item: placed, x: nx, y: ny });
    return true;
  };

  const itemState = (item: () => T): PlacementGridItemState<K> => {
    const itemKey = computed(() => key(item()));
    const isActive = computed(() => activeKey() === itemKey());
    const previewItem = computed(() => {
      if (activeKey() === null) return item();
      return previewMap().get(itemKey()) ?? item();
    });

    const glide = animation
      ? `transform var(--mm-grid-duration, ${animation.duration}ms) var(--mm-grid-easing, ${animation.easing}), width var(--mm-grid-duration, ${animation.duration}ms) var(--mm-grid-easing, ${animation.easing}), height var(--mm-grid-duration, ${animation.duration}ms) var(--mm-grid-easing, ${animation.easing})`
      : 'none';

    return {
      itemKey,
      isActive,
      cellX: computed(() => previewItem().x),
      cellY: computed(() => previewItem().y),
      spanW: computed(() => previewItem().w),
      spanH: computed(() => previewItem().h),
      dragX: computed(() => {
        if (!isActive() || !snap || !dragStartItem || snap.kind === 'resize') {
          return 0;
        }
        return (
          dragStartItem.x * stepX() +
          (pointerX() + scrollX() - snap.startX)
        );
      }),
      dragY: computed(() => {
        if (!isActive() || !snap || !dragStartItem || snap.kind === 'resize') {
          return 0;
        }
        return (
          dragStartItem.y * stepY() +
          (pointerY() + scrollY() - snap.startY)
        );
      }),
      transitionCss: computed(() =>
        isActive() ? 'none' : activeKey() !== null ? glide : 'none',
      ),
    };
  };

  /**
   * Commit a keyboard step, treating a gravity-reverted move (the item settles
   * back where it started) as a no-op — arrows can't float an item in mid-air
   * under `compact: 'vertical'`.
   */
  const commitKeyboard = (k: K, next: readonly T[], before: readonly T[]): boolean => {
    if (next === before) return false;
    const orig = before.find((i) => key(i) === k);
    const settled = commitLayout(next);
    const placed = settled.find((i) => key(i) === k);
    if (
      orig &&
      placed &&
      placed.x === orig.x &&
      placed.y === orig.y &&
      placed.w === orig.w &&
      placed.h === orig.h
    ) {
      source.set(before as T[]);
      return false;
    }
    return true;
  };

  const self: PlacementGridController<T, K> = {
    items: source,
    key,
    cols,
    gap,
    rowHeight,
    compact,
    rows,
    activeKey: activeKey.asReadonly(),
    crossTarget: computed(() => {
      if (!groupApi || activeKey() === null) return false;
      const tgt = groupApi.activeTarget();
      return groupApi.activeSource() === self && tgt !== null && tgt !== self;
    }),
    projectedCell: computed(() =>
      snap?.kind === 'resize' ? null : projected(),
    ),
    previewLayout,
    targetMask,
    keyboard,
    announcePlace,
    animation,
    autoScroll,
    activationThreshold,
    group,
    itemState,
    moveBy: (k, dx, dy) => {
      const arr = untracked(source);
      const it = arr.find((i) => key(i) === k);
      if (!it) return false;
      const c = cols();
      const nx = Math.max(0, Math.min(it.x + dx, c - it.w));
      const ny = Math.max(0, it.y + dy);
      if (nx === it.x && ny === it.y) return false;
      if (!placeGate(it, nx, ny, arr)) return false;
      if (compact === 'none') {
        source.set(arr.map((i) => (key(i) === k ? { ...i, x: nx, y: ny } : i)) as T[]);
        options.onPlace?.({ item: it, x: nx, y: ny, items: untracked(source) });
        return true;
      }
      const moved = moveGridItem(arr, key, k, nx, ny, c);
      if (!commitKeyboard(k, moved, arr)) return false;
      const placed = untracked(source).find((i) => key(i) === k);
      if (placed) {
        options.onPlace?.({ item: it, x: placed.x, y: placed.y, items: untracked(source) });
      }
      return true;
    },
    resizeBy: (k, dw, dh) => {
      const arr = untracked(source);
      const it = arr.find((i) => key(i) === k);
      if (!it) return false;
      const c = cols();
      const nw = Math.max(1, Math.min(it.w + dw, c - it.x));
      const nh = Math.max(1, it.h + dh);
      if (nw === it.w && nh === it.h) return false;
      if (compact === 'none') {
        if (!canPlaceAt(arr, key, k, it.x, it.y, nw, nh, c)) return false;
        source.set(arr.map((i) => (key(i) === k ? { ...i, w: nw, h: nh } : i)) as T[]);
        options.onResize?.({ item: it, w: nw, h: nh, items: untracked(source) });
        return true;
      }
      const resized = resizeGridItem(arr, key, k, nw, nh, c);
      if (!commitKeyboard(k, resized, arr)) return false;
      const placed = untracked(source).find((i) => key(i) === k);
      if (placed) {
        options.onResize?.({ item: it, w: placed.w, h: placed.h, items: untracked(source) });
      }
      return true;
    },
    begin,
    beginGesture: (k, start) => {
      const s = measureSnapshot('move', undefined, start);
      if (s) begin(k, s);
    },
    beginResizeGesture: (k, direction, start) => {
      const s = measureSnapshot('resize', direction, start);
      if (s) begin(k, s);
    },
    move,
    end,
    cancel: resetDragState,
    dispose: () => {
      if (untracked(activeKey) !== null) resetDragState();
      if (groupApi && untracked(groupApi.activeTarget) === self) {
        groupApi.clearActive();
      }
      group?.unregister(self);
    },
    register: (k, el) => {
      byKey.set(k, el);
      byEl.set(el, k);
    },
    unregister: (k, el) => {
      if (byKey.get(k) === el) byKey.delete(k);
      if (byEl.get(el) === k) byEl.delete(el);
    },
    keyForElement: (el) => byEl.get(el),
    setContainer: (el) => {
      container = el;
    },
    setScrollDelta: (x, y) => {
      scrollX.set(x);
      scrollY.set(y);
    },
    bounds: () => boundsCache,
    refreshBounds: () => {
      boundsCache = container ? container.getBoundingClientRect() : null;
    },
    // not index-based: sources fall through to insertAtPoint; hovering opens no gap
    measure: () => ({ centers: [], axis: 'y' as const }),
    insertAt: (item) => {
      const spot = findFirstFit(untracked(source), item);
      return receive(item, spot.x, spot.y);
    },
    insertAtPoint: (item, x, y) => {
      const b = boundsCache ?? (container ? container.getBoundingClientRect() : null);
      if (!b) return false;
      const g = gap();
      const c = cols();
      const cellW = (b.width - g * (c - 1)) / c;
      const cellH = rowHeight ? rowHeight() : cellW;
      if (cellW <= 0) return false;
      // center the incoming item's span on the pointed cell
      const cx = Math.floor((x - b.left) / (cellW + g)) - Math.floor((item.w - 1) / 2);
      const cy = Math.floor((y - b.top) / (cellH + g)) - Math.floor((item.h - 1) / 2);
      return receive(item, cx, cy);
    },
    canReceive: options.canReceive
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (item) => untracked(() => options.canReceive!(item))
      : undefined,
  };

  group?.register(self);
  return self;
}

/**
 * DI-aware {@link placementGrid}: captures the current `Injector` so
 * `providePlacementGridDefaults` / `provideDndDefaults` apply.
 */
export function injectPlacementGrid<T extends GridPlacement, K>(
  source: WritableSignal<T[]>,
  opts: PlacementGridOptions<T, K>,
): PlacementGridController<T, K> {
  const injector = opts.injector ?? inject(Injector);
  return placementGrid(source, { ...opts, injector });
}
