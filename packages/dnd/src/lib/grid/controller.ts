import {
  computed,
  inject,
  Injector,
  isDevMode,
  linkedSignal,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { type Handle } from '@mmstack/primitives';

import {
  resolveTouchActivation,
  type ResolvedTouchActivation,
  type TouchActivation,
} from '../internal/touch-activation';
import { occurrences } from '../internal/occurrences';
import { withDefaults } from '../provide';
import {
  insertIndexForMeasure,
  type ListAnchor,
  type MemberMeasure,
  type RectLike,
  slotAnchor,
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

/** An item a move displaced by consequence: its address before and after the commit. */
export type PlacementDisplaced<K = unknown> = {
  /** The displaced item's handle: its raw key unless that key has duplicates. */
  readonly key: Handle<K>;
  readonly from: GridPlacement;
  readonly to: GridPlacement;
};

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
  /**
   * Column count (reactive via getter). Commits and new drags read the live
   * value; a change DURING a drag keeps the gesture's cell metrics until it
   * ends — cancel in-flight drags when reflowing columns.
   */
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
    | {
        edge?: number;
        speed?: number;
        edgeProportion?: number;
        maxSpeedAt?: number;
      }
    | false;
  /** Px the pointer must travel before a drag activates. @default 5 */
  readonly activationThreshold?: number;
  /**
   * Touch presses wait for a long-press before they can drag; mouse and pen
   * start immediately. Items and grips then use `touch-action: manipulation`
   * so the page scrolls until the press activates. See {@link TouchActivation}.
   * `false` opts out of a DI default. @default off
   */
  readonly touchActivation?: TouchActivation | false;
  readonly injector?: Injector;
  /** After a move commits (drop or keyboard). A drop or step that changes no address fires nothing. */
  readonly onPlace?: (event: {
    item: T;
    x: number;
    y: number;
    items: readonly T[];
    /**
     * The OTHER items whose address the move changed by consequence (pushed or
     * pulled by the reflow), each against its own previous address, in source
     * order. Empty under `compact: 'none'`. The dragged item is never listed.
     */
    displaced: readonly PlacementDisplaced<K>[];
  }) => void;
  /** After a resize commits. */
  readonly onResize?: (event: {
    item: T;
    w: number;
    h: number;
    items: readonly T[];
    /** As on `onPlace`: the OTHER items the resize pushed or pulled, `[]` under `compact: 'none'`. */
    displaced: readonly PlacementDisplaced<K>[];
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
  /** The dragged occurrence's handle (the raw key unless that key has duplicates), or `null`. */
  readonly activeKey: Signal<Handle<K> | null>;
  /**
   * The active drag is currently over ANOTHER group member (a tray, a list) —
   * restyle the dragged item to preview what it will become there.
   */
  readonly crossTarget: Signal<boolean>;
  /**
   * The active move's projected cell, or `null` (idle, resizing, never-valid,
   * or the pointer is outside the grid).
   */
  readonly projectedCell: Signal<{ x: number; y: number } | null>;
  /**
   * The active move's pointer is outside the grid, so releasing now cancels
   * the move: the preview shows the original layout and the source is not
   * written. The test uses the grid box as it was at drag start (shifted by
   * auto-scroll), not the box the preview grows or shrinks to, so it depends
   * on the pointer position alone. Always `false` when idle and during a resize.
   */
  readonly dropOutside: Signal<boolean>;
  /**
   * A foreign group drag hovering THIS grid, projected to the rect it would
   * occupy on drop — `null` when idle, not hovered, or the drop would be
   * rejected. Render it like the local drop-target highlight so arrivals
   * preview before they land.
   */
  readonly incomingCell: Signal<(GridPlacement & { key: K }) | null>;
  /** The live preview layout (the source array when idle). */
  readonly previewLayout: Signal<readonly T[]>;
  /**
   * `compact: 'none'` affordance mask for the active item (`mask[y*cols+x]`),
   * `null` outside a drag — render drop cells from it.
   */
  readonly targetMask: Signal<Uint8Array | null>;
  readonly keyboard: boolean;
  readonly announcePlace:
    | ((event: {
        item: T;
        x: number;
        y: number;
        w: number;
        h: number;
      }) => string)
    | null;
  readonly animation: { duration: number; easing: string } | null;
  readonly autoScroll: {
    edge: number;
    speed: number;
    edgeProportion?: number;
    maxSpeedAt?: number;
  } | null;
  readonly activationThreshold: number;
  /** Resolved touch long-press, or `null` when off. */
  readonly touchActivation: ResolvedTouchActivation | null;
  readonly group?: SortableGroup<T>;
  /** `element` binds the state to that item's occurrence (see `register`). */
  itemState(item: () => T, element?: HTMLElement): PlacementGridItemState<K>;
  /** Keyboard commit: move the item one step (clamped/validated). */
  moveBy(handle: Handle<K>, dx: number, dy: number): boolean;
  /** Keyboard commit: resize the item by whole cells (min 1×1). */
  resizeBy(handle: Handle<K>, dw: number, dh: number): boolean;
  /** Pure drag-start from a measured snapshot. Unit-testable without DOM. */
  begin(handle: Handle<K>, snapshot: PlacementDragSnapshot): void;
  /** @internal DOM edge: measure the container, then {@link begin} a move. */
  beginGesture(handle: Handle<K>, start: { x: number; y: number }): void;
  /** @internal DOM edge: measure, then {@link begin} a resize. */
  beginResizeGesture(
    handle: Handle<K>,
    direction: PlacementResizeDirection,
    start: { x: number; y: number },
  ): void;
  /** @internal feed a pointer move (viewport coords). */
  move(point: { x: number; y: number }): void;
  /**
   * @internal end the drag, committing the preview (or a cross-container
   * transfer); a move released outside the grid commits nothing.
   */
  end(): void;
  cancel(): void;
  dispose(): void;
  /** @internal item DOM registration. */
  /**
   * `item` binds the element to its OCCURRENCE: a reference found once in the
   * source is that row; a reference repeated binds the first occurrence no
   * other element holds yet (registration order). Without `item` (or for a
   * reference no longer in the source) the key decides.
   */
  register(key: K, el: HTMLElement, item?: T): void;
  unregister(key: K, el: HTMLElement): void;
  keyForElement(el: HTMLElement): Handle<K> | undefined;
  /** @internal the live position of an occurrence, or `-1`. */
  indexOf(handle: Handle<K>): number;
  setContainer(el: HTMLElement | null): void;
  /** @internal auto-scroll compensation, px (x = horizontal, y = vertical). */
  setScrollDelta(x: number, y: number): void;
};

/**
 * Layout runs over CELLS: each item's address plus its position. The pure layout
 * functions identify items by a key; the position is the one identity that is
 * unique even when two items share a key (or one object is listed twice), and
 * results keep input order, so cell `i` maps straight back to item `i`.
 */
type Cell = GridPlacement & { readonly i: number };
const cellIndex = (c: Cell) => c.i;
const cellsOf = (arr: readonly GridPlacement[]): Cell[] =>
  arr.map((it, i) => ({ x: it.x, y: it.y, w: it.w, h: it.h, i }));

/** Map cells back onto items: an item whose address held is the same object; the array too, if none moved. */
function fromCells<T extends GridPlacement>(
  arr: readonly T[],
  cells: readonly GridPlacement[],
): readonly T[] {
  let changed = false;
  const out = arr.map((it, i) => {
    const c = cells[i];
    if (sameAddress(it, c)) return it;
    changed = true;
    return { ...it, x: c.x, y: c.y, w: c.w, h: c.h };
  });
  return changed ? out : arr;
}

const sameAddress = (a: GridPlacement, b: GridPlacement): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const addressOf = (i: GridPlacement): GridPlacement => ({
  x: i.x,
  y: i.y,
  w: i.w,
  h: i.h,
});

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
 *
 * Placement events carry addresses (`x`, `y`, `w`, `h`), not neighbour anchors:
 * a grid has no order to name a position by.
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
  const rowHeight = options.rowHeight ? resolveNum(options.rowHeight, 0) : null;
  const compact = options.compact ?? 'vertical';
  const keyboard = options.keyboard ?? true;
  const activationThreshold = options.activationThreshold ?? 5;
  const touchActivation = resolveTouchActivation(options.touchActivation);
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

  // identity = the occurrence (a handle: the raw key until that key is duplicated)
  const occ = occurrences(source, key);
  const liveIndex = (h: Handle<K>) => untracked(occ.indexMap).get(h) ?? -1;
  let container: HTMLElement | null = null;
  let boundsCache: RectLike | null = null;

  const activeKey = signal<Handle<K> | null>(null);
  const pointerX = signal(0);
  const pointerY = signal(0);
  const scrollX = signal(0);
  const scrollY = signal(0);
  // The drag record, frozen at gesture start. `activeKey` publishes it: `begin()` fills these
  // before setting the key and `resetDragState()` clears the key before emptying them, and
  // every derivation reads `activeKey()` first, so none ever sees a half-written record.
  const startRows = signal(0);
  let snap: PlacementDragSnapshot | null = null;
  let dragStartItems: readonly T[] | null = null;
  let dragStartItem: T | null = null;
  let dragStartIdx = -1;
  let dragStartHandles: readonly Handle<K>[] = [];
  // The last cross-container hover: its target and the hovered slot named by neighbour.
  let hover: {
    target: SortableGroupMember<T>;
    anchor: ListAnchor<unknown> | null;
  } | null = null;

  /** Could the item at position `idx` (`-1`: not in `items`) take this rect, nobody moving? */
  const fitsAt = (
    items: readonly T[],
    idx: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => canPlaceAt(cellsOf(items), cellIndex, idx, x, y, w, h, cols());

  const placeGate = (
    item: T,
    idx: number,
    x: number,
    y: number,
    items: readonly T[],
  ) => {
    if (compact === 'none' && !fitsAt(items, idx, x, y, item.w, item.h)) {
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
        const w = Math.max(
          1,
          Math.min(Math.round((wPx + snap.gap) / stepX()), cols() - it.x),
        );
        const h = Math.max(1, Math.round((hPx + snap.gap) / stepY()));
        if (prev?.value && prev.value.x === w && prev.value.y === h) {
          return prev.value;
        }
        if (
          compact === 'none' &&
          !fitsAt(dragStartItems, dragStartIdx, it.x, it.y, w, h)
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
      // one band below the occupied rows is every distinct outcome (gravity
      // settles anything deeper the same way); it also bounds the grid's
      // growth, so a pointer far below stays outside the grid
      const y = Math.max(0, Math.min(cy, gridRows(dragStartItems)));
      if (prev?.value && prev.value.x === x && prev.value.y === y) {
        return prev.value;
      }
      if (!placeGate(it, dragStartIdx, x, y, dragStartItems)) {
        return prev?.value ?? null;
      }
      return { x, y };
    },
  });

  /**
   * Content-space hit test against the grid box as it was when the drag
   * started, plus the band a move may grow into below the occupied rows
   * (origin shifted by auto-scroll, rows frozen at drag start). The
   * preview grows and shrinks the rendered grid, so testing the live box made
   * the result depend on the path the pointer took; the frozen box makes it a
   * function of the pointer alone. Inactive and resize: never outside.
   */
  const outside = computed(() => {
    if (activeKey() === null || !snap || snap.kind !== 'move') return false;
    const s = snap;
    const c = cols();
    // a move may land one band below the occupied rows (see the projection),
    // so the box always includes that band, whatever the compaction
    const r = Math.max(
      startRows(),
      gridRows(dragStartItems ?? []) + (dragStartItem?.h ?? 0),
    );
    const x = pointerX() + scrollX() - s.originX;
    const y = pointerY() + scrollY() - s.originY;
    const width = c * s.cellW + (c - 1) * s.gap;
    const height = r > 0 ? r * s.cellH + (r - 1) * s.gap : 0;
    return x < 0 || y < 0 || x > width || y > height;
  });

  const previewLayout = computed<readonly T[]>(() => {
    const k = activeKey();
    if (k === null) return source();
    if (outside()) return dragStartItems ?? source();
    const p = projected();
    if (!p || !snap || !dragStartItems) return dragStartItems ?? source();
    return step(dragStartItems, dragStartIdx, p, snap.kind === 'resize');
  });

  /** Handle → previewed item (positions follow the drag-start snapshot). */
  const previewMap = computed(() => {
    const map = new Map<Handle<K>, T>();
    const layout = previewLayout();
    const hs = activeKey() === null ? occ.state().handles : dragStartHandles;
    for (let i = 0; i < layout.length; i++) map.set(hs[i], layout[i]);
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

  /** Point → cell for an arriving item (span-centered on the pointed cell). */
  const cellFromPoint = (
    item: T,
    x: number,
    y: number,
  ): { x: number; y: number } | null => {
    const b =
      boundsCache ?? (container ? container.getBoundingClientRect() : null);
    if (!b) return null;
    const g = gap();
    const c = cols();
    const cellW = (b.width - g * (c - 1)) / c;
    const cellH = rowHeight ? rowHeight() : cellW;
    if (cellW <= 0) return null;
    const cx =
      Math.floor((x - b.left) / (cellW + g)) - Math.floor((item.w - 1) / 2);
    const cy =
      Math.floor((y - b.top) / (cellH + g)) - Math.floor((item.h - 1) / 2);
    return {
      x: Math.max(0, Math.min(cx, c - item.w)),
      y: Math.max(0, cy),
    };
  };

  /**
   * A foreign group drag hovering THIS grid, projected to its drop rect —
   * the arrival counterpart of {@link projectedCell}, and only present when
   * the drop would be accepted (invalid cells show nothing, pairing with the
   * validity mask instead of lying).
   */
  const incomingCell = computed<(GridPlacement & { key: K }) | null>(
    () => {
      if (!groupApi) return null;
      if (
        groupApi.activeTarget() !== self ||
        groupApi.activeSource() === self
      ) {
        return null;
      }
      const item = groupApi.activeItem() as T | null;
      if (!item) return null;
      const cell = cellFromPoint(item, groupApi.activeX(), groupApi.activeY());
      if (!cell) return null;
      if (!placeGate({ ...item, ...cell }, -1, cell.x, cell.y, source())) {
        return null;
      }
      return { ...cell, w: item.w, h: item.h, key: key(item) };
    },
    {
      // recomputes per pointer frame; renotifies only on an actual cell change
      equal: (a, b) =>
        a === b ||
        (a !== null &&
          b !== null &&
          a.x === b.x &&
          a.y === b.y &&
          a.w === b.w &&
          a.h === b.h &&
          a.key === b.key),
    },
  );

  const rows = computed(() => {
    // an empty grid keeps one row of height so it stays a visible, hittable
    // drop target (the grid counterpart of the empty-list min-height contract)
    const floor = source().length === 0 ? 1 : 0;
    // and an incoming hover can extend below the last occupied row
    const inc = incomingCell();
    return Math.max(
      gridRows(previewLayout()),
      dragRows(),
      floor,
      inc ? inc.y + inc.h : 0,
    );
  });

  const targetMask = computed<Uint8Array | null>(() => {
    const k = activeKey();
    if (k === null || compact !== 'none' || !dragStartItems) return null;
    // origins deeper than the occupied rows are equivalent, minus dead space
    return validTargets(
      cellsOf(dragStartItems),
      cellIndex,
      dragStartIdx,
      cols(),
      gridRows(dragStartItems) + 1,
    );
  });

  const resetDragState = () => {
    hover = null;
    activeKey.set(null);
    startRows.set(0);
    pointerX.set(0);
    pointerY.set(0);
    scrollX.set(0);
    scrollY.set(0);
    snap = null;
    dragStartItems = null;
    dragStartItem = null;
    dragStartIdx = -1;
    dragStartHandles = [];
    if (groupApi && untracked(groupApi.activeSource) === self) {
      groupApi.clearActive();
    }
  };

  /** Release the drag hold: gravity applies to the moved item too. Pure. */
  const settle = (next: readonly T[]): readonly T[] =>
    compact === 'vertical'
      ? fromCells(next, compactGrid(cellsOf(next), cellIndex))
      : next;

  /**
   * The pure step a drop (or a preview) applies to the item at `idx`: move to
   * `p` or resize to spans `p`, with the reflow of the compaction mode.
   */
  const step = (
    items: readonly T[],
    idx: number,
    p: { x: number; y: number },
    resize: boolean,
  ): readonly T[] => {
    if (idx < 0) return items;
    if (compact === 'none') {
      return items.map((it, i) =>
        i !== idx
          ? it
          : resize
            ? { ...it, w: p.x, h: p.y }
            : { ...it, x: p.x, y: p.y },
      );
    }
    const cells = cellsOf(items);
    return fromCells(
      items,
      resize
        ? resizeGridItem(cells, cellIndex, idx, p.x, p.y, cols())
        : moveGridItem(cells, cellIndex, idx, p.x, p.y, cols()),
    );
  };

  /** Same address (x, y, w, h) at every position — a layout that changed nothing, whatever the references. */
  const sameAddresses = (a: readonly T[], b: readonly T[]): boolean => {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (!sameAddress(a[i], b[i])) return false;
    return true;
  };

  /** The other items (by handle) whose address changed between `before` and `after`, in order. */
  const displacedBy = (
    before: readonly T[],
    after: readonly T[],
    movedIdx: number,
  ): PlacementDisplaced<K>[] => {
    const hs = untracked(occ.state).handles;
    const out: PlacementDisplaced<K>[] = [];
    for (let i = 0; i < after.length; i++) {
      const was = before[i];
      if (i === movedIdx || !was || sameAddress(was, after[i])) continue;
      out.push({ key: hs[i], from: addressOf(was), to: addressOf(after[i]) });
    }
    return out;
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

  const begin = (k: Handle<K>, snapshot: PlacementDragSnapshot) => {
    const arr = untracked(source);
    const idx = liveIndex(k);
    if (idx < 0) return;
    snap = snapshot;
    dragStartItems = arr;
    dragStartItem = arr[idx];
    dragStartIdx = idx;
    dragStartHandles = untracked(occ.state).handles;
    // the resting grid's rows, read before the key publishes the drag (the
    // hit test reads them, so it cannot be what supplies them)
    startRows.set(untracked(rows));
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
    const insert = insertIndexForMeasure(tg, p.x, p.y);
    // name the hovered slot by neighbour in the list it was measured against
    hover = { target, anchor: tg.keys ? slotAnchor(tg.keys, insert) : null };
    groupApi.setActive({
      source: self,
      target,
      sourceIndex: dragStartIdx,
      insertIndex: insert,
      footprint:
        tg.kind !== 'wrap' && tg.axis === 'x'
          ? (dragged?.w ?? 1) * stepX()
          : (dragged?.h ?? 1) * stepY(),
      targetMeasure: tg,
      item: dragged,
      x: p.x,
      y: p.y,
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

    // the dragged KEY in the live source is what commits, never the drag-start snapshot
    const before = untracked(source);
    const idx = liveIndex(k);
    if (idx < 0) return resetDragState(); // removed by another writer mid-drag: nothing to place
    const item = before[idx];

    if (crossTarget && groupApi) {
      let to = untracked(groupApi.activeInsertIndex);
      // an index target: the hovered neighbour, resolved against its live list
      if (
        hover?.target === crossTarget &&
        hover.anchor &&
        crossTarget.slotOfAnchor
      ) {
        to = crossTarget.slotOfAnchor(hover.anchor);
        if (to < 0 && !crossTarget.insertAtPoint) {
          if (isDevMode()) {
            console.warn(
              '[@mmstack/dnd] placementGrid: the drop target changed mid-drag and the hovered neighbour is gone; the drag was cancelled.',
            );
          }
          return resetDragState();
        }
      }
      const px = untracked(pointerX);
      const py = untracked(pointerY);
      const taken = crossTarget.insertAtPoint?.(item, px, py)
        ? true
        : to >= 0
          ? crossTarget.insertAt(item, to)
          : false;
      if (taken) {
        // exactly this occurrence leaves
        const from = liveIndex(k);
        const next = untracked(source).filter((_, i) => i !== from);
        source.set(settle(next) as T[]);
        options.onItemLeft?.({ item });
      }
      return resetDragState();
    }

    if (untracked(outside)) return resetDragState();

    const p = untracked(projected);
    const wasResize = snap?.kind === 'resize';
    if (p) {
      // the preview was built from the snapshot; the commit re-runs the same pure
      // step over the live source, so a concurrent writer's change survives
      const next = liveStep(before, item, idx, p, wasResize);
      const settled = next ? settle(next) : before;
      // a drop that changes no address is silent: no write, no event
      if (!sameAddresses(before, settled)) {
        source.set(settled as T[]);
        const placed = settled[idx];
        if (placed) {
          if (wasResize) {
            options.onResize?.({
              item,
              w: placed.w,
              h: placed.h,
              items: settled,
              displaced: displacedBy(before, settled, idx),
            });
          } else {
            options.onPlace?.({
              item,
              x: placed.x,
              y: placed.y,
              items: settled,
              displaced: displacedBy(before, settled, idx),
            });
          }
        }
      }
    }
    resetDragState();
  };

  /**
   * The drop's step over the LIVE items: the move (or resize) the preview showed,
   * re-validated against what is there now. `null` = it no longer fits (a
   * `compact: 'none'` cell taken meanwhile, or `canPlace` refuses) ⇒ no-op.
   */
  const liveStep = (
    live: readonly T[],
    item: T,
    idx: number,
    p: { x: number; y: number },
    resize: boolean,
  ): readonly T[] | null => {
    if (resize) {
      if (compact === 'none' && !fitsAt(live, idx, item.x, item.y, p.x, p.y)) {
        return null;
      }
    } else if (!placeGate(item, idx, p.x, p.y, live)) return null;
    return step(live, idx, p, resize);
  };

  const findFirstFit = (
    items: readonly T[],
    item: T,
  ): { x: number; y: number } => {
    const c = cols();
    const maxY = gridRows(items) + item.h;
    const cells = cellsOf(items); // the arriving item is not among them
    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x <= c - item.w; x++) {
        if (
          canPlaceAt(cells, cellIndex, -1, x, y, item.w, item.h, c) &&
          (options.canPlace
            ? options.canPlace(item, x, y, items) !== false
            : true)
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
    if (!placeGate(placed, -1, nx, ny, arr)) return false;
    if (compact === 'none') {
      source.set([...arr, placed] as T[]);
    } else {
      const all = [...arr, placed];
      const cells = cellsOf(all);
      source.set(
        fromCells(
          all,
          compactGrid(placeGridItem(cells, cellIndex, arr.length), cellIndex),
        ) as T[],
      );
    }
    options.onItemArrived?.({ item: placed, x: nx, y: ny });
    return true;
  };

  const itemState = (
    item: () => T,
    element?: HTMLElement,
  ): PlacementGridItemState<K> => {
    const itemKey = computed(() => key(item()));
    // the item's occurrence: its element's binding, else the item's first occurrence
    const handle = computed(
      () => (element && occ.keyForElement(element)) ?? occ.handleOf(item()),
    );
    const isActive = computed(() => {
      const h = handle();
      return h !== undefined && activeKey() === h;
    });
    const previewItem = computed(() => {
      const h = handle();
      if (activeKey() === null || h === undefined) return item();
      return previewMap().get(h) ?? item();
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
          dragStartItem.x * stepX() + (pointerX() + scrollX() - snap.startX)
        );
      }),
      dragY: computed(() => {
        if (!isActive() || !snap || !dragStartItem || snap.kind === 'resize') {
          return 0;
        }
        return (
          dragStartItem.y * stepY() + (pointerY() + scrollY() - snap.startY)
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
  const commitKeyboard = (
    next: readonly T[],
    before: readonly T[],
  ): boolean => {
    const settled = settle(next);
    if (sameAddresses(before, settled)) return false; // settled back home: no write
    source.set(settled as T[]);
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
      snap?.kind === 'resize' || outside() ? null : projected(),
    ),
    dropOutside: outside,
    incomingCell,
    previewLayout,
    targetMask,
    keyboard,
    announcePlace,
    animation,
    autoScroll,
    activationThreshold,
    touchActivation,
    group,
    itemState,
    moveBy: (k, dx, dy) => {
      const arr = untracked(source);
      const idx = liveIndex(k);
      const it = arr[idx];
      if (!it) return false;
      const c = cols();
      const nx = Math.max(0, Math.min(it.x + dx, c - it.w));
      const ny = Math.max(0, it.y + dy);
      if (nx === it.x && ny === it.y) return false;
      if (!placeGate(it, idx, nx, ny, arr)) return false;
      if (compact === 'none') {
        source.set(step(arr, idx, { x: nx, y: ny }, false) as T[]);
        options.onPlace?.({
          item: it,
          x: nx,
          y: ny,
          items: untracked(source),
          displaced: [],
        });
        return true;
      }
      const moved = step(arr, idx, { x: nx, y: ny }, false);
      if (!commitKeyboard(moved, arr)) return false;
      const placed = untracked(source)[idx];
      if (placed) {
        options.onPlace?.({
          item: it,
          x: placed.x,
          y: placed.y,
          items: untracked(source),
          displaced: displacedBy(arr, untracked(source), idx),
        });
      }
      return true;
    },
    resizeBy: (k, dw, dh) => {
      const arr = untracked(source);
      const idx = liveIndex(k);
      const it = arr[idx];
      if (!it) return false;
      const c = cols();
      const nw = Math.max(1, Math.min(it.w + dw, c - it.x));
      const nh = Math.max(1, it.h + dh);
      if (nw === it.w && nh === it.h) return false;
      if (compact === 'none') {
        if (!fitsAt(arr, idx, it.x, it.y, nw, nh)) return false;
        source.set(step(arr, idx, { x: nw, y: nh }, true) as T[]);
        options.onResize?.({
          item: it,
          w: nw,
          h: nh,
          items: untracked(source),
          displaced: [],
        });
        return true;
      }
      const resized = step(arr, idx, { x: nw, y: nh }, true);
      if (!commitKeyboard(resized, arr)) return false;
      const placed = untracked(source)[idx];
      if (placed) {
        options.onResize?.({
          item: it,
          w: placed.w,
          h: placed.h,
          items: untracked(source),
          displaced: displacedBy(arr, untracked(source), idx),
        });
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
    register: (k, el, item) => occ.register(k, el, item),
    unregister: (k, el) => occ.unregister(k, el),
    keyForElement: (el) => untracked(() => occ.keyForElement(el)),
    indexOf: (h) => liveIndex(h),
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
      const cell = cellFromPoint(item, x, y);
      if (!cell) return false;
      return receive(item, cell.x, cell.y);
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
