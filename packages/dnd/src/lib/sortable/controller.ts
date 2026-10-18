import {
  computed,
  inject,
  Injector,
  isDevMode,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';

import { type Handle } from '@mmstack/primitives';

import { occurrences } from '../internal/occurrences';
import { resolveTouchActivation } from '../internal/touch-activation';
import { withDefaults } from '../provide';
import type { DragEngine } from '../session';
import { injectReorderableDefaults } from './defaults';
import { currentTranslate } from './dom';
import {
  anchorOf,
  type Axis,
  centerAlong,
  clampInsert,
  closeDisplacement,
  closeSlotOf,
  displacement,
  insertIndexForMeasure,
  type ListAnchor,
  slotAnchor,
  slotOfAnchor,
  type MemberMeasure,
  moveWithin,
  openDisplacement,
  openSlotOf,
  type Point,
  type RectLike,
  sizeAlong,
  startAlong,
  wrapVirtualSlot,
} from './geometry';
import { getGroupInternals, type SortableGroupMember } from './group';
import { type DragGeometry, sortableSession } from './session';
import type {
  ReorderableController,
  ReorderableItemState,
  ReorderableOptions,
  ReorderableOptionsAll,
} from './types';

const DEFAULT_ANIMATION = {
  duration: 200,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** The platform "primary" modifier: Cmd on macOS, Ctrl elsewhere. */
function defaultJumpModifier(e: KeyboardEvent): boolean {
  const mac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(
      navigator.platform || navigator.userAgent || '',
    );
  return mac ? e.metaKey : e.ctrlKey;
}

/** Default auto-scroll: px from a scroll edge where it engages + max speed (px/frame). */
const DEFAULT_AUTOSCROLL = { edge: 48, speed: 16 } as const;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function reorderable<T, K>(
  source: WritableSignal<T[]>,
  opts: ReorderableOptions<T, K>,
): ReorderableController<T, K> {
  const raw = opts as ReorderableOptionsAll<T, K>;
  // Pure by design: DI defaults apply only when an injector is present (see injectReorderable).
  const options = withDefaults(
    raw,
    raw.injector ? injectReorderableDefaults(raw.injector) : null,
  );
  const axis = options.axis ?? 'y';
  const wrap = axis === 'wrap';
  // wrap collision reads main = y, cross = x (row-major flow)
  const collisionAxis: Axis = axis === 'x' ? 'x' : 'y';
  const deadband = options.deadband ?? 4;
  const engine: DragEngine = options.engine ?? 'native';
  const activationThreshold = options.activationThreshold ?? 5;
  const touchActivation =
    engine === 'pointer' ? resolveTouchActivation(options.touchActivation) : null;
  // The per-call union forbids these, but a DI default can flip the engine under an engine-specific option.
  if (isDevMode()) {
    if (engine === 'pointer' && (options.insert || options.onItemInserted)) {
      console.warn(
        '[@mmstack/dnd] reorderable: `insert`/`onItemInserted` are native-engine options and are ignored under engine "pointer" (was the engine flipped by a DI default?).',
      );
    }
    if (engine === 'native' && options.activationThreshold !== undefined) {
      console.warn(
        '[@mmstack/dnd] reorderable: `activationThreshold` is a pointer-engine option and is ignored under engine "native" (was the engine flipped by a DI default?).',
      );
    }
    if (engine === 'native' && raw.touchActivation) {
      console.warn(
        '[@mmstack/dnd] reorderable: `touchActivation` is a pointer-engine option and is ignored under engine "native" (the browser owns touch activation there).',
      );
    }
    if (engine === 'native' && wrap) {
      console.warn(
        "[@mmstack/dnd] reorderable: `axis: 'wrap'` is a pointer-engine layout — the native indicator engine has no 2D indicator placement and falls back to vertical behaviour. Use `engine: 'pointer'`.",
      );
    }
  }
  const listId = Symbol('@mmstack/dnd:reorderable');
  // null whenever no source set (idle / not hovered) → onDrop's untracked read reflects live state.
  const insertSource = signal<Signal<number | null> | null>(null);
  const nativeInsert = computed(() => insertSource()?.() ?? null);
  const nativeHoverAnchor = signal<ListAnchor<Handle<K>> | null>(null);
  const { key, group } = options;
  const groupApi = group ? getGroupInternals(group) : null;
  const keyboard = options.keyboard ?? true;
  const jumpModifier = options.jumpModifier ?? defaultJumpModifier;
  const announceMove =
    options.announceMove === false
      ? null // opted out → no live region is created (see item connect)
      : (options.announceMove ??
        ((e: { to: number; total: number }) =>
          `Moved to position ${e.to + 1} of ${e.total}`));
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
  const geometry = signal<DragGeometry | null>(null);
  const activeKey = signal<Handle<K> | null>(null);
  const startMain = signal(0);
  const pointerMain = signal(0);
  const startCross = signal(0); // off-axis, for 2D follow when dragging cross-list
  const pointerCross = signal(0);
  const scrollDelta = signal(0);

  const active = computed(() => activeKey() !== null);
  const session = sortableSession({
    geometry,
    pointer: computed(() => pointerMain() + scrollDelta()),
    pointerCross,
    active,
    deadband,
  });

  const indexMap = occ.indexMap;
  /** The live handles, in source order (untracked). */
  const liveHandles = () => untracked(occ.state).handles;

  const projMain = (p: { x: number; y: number }) =>
    collisionAxis === 'y' ? p.y : p.x;
  const projCross = (p: { x: number; y: number }) =>
    collisionAxis === 'y' ? p.x : p.y;
  const oneAxis = (v: number) =>
    collisionAxis === 'y' ? `translateY(${v}px)` : `translateX(${v}px)`;

  /** Same-list commit (drop or keyboard): splice + `onReorder` with the landing anchor. */
  const commitReorder = (from: number, to: number) => {
    untracked(occ.state); // observe the state the move starts from (handle continuity)
    source.update((arr) => moveWithin(arr, from, to));
    const items = untracked(source);
    const hs = liveHandles();
    const at = clampInsert(to, items.length - 1);
    options.onReorder?.({
      from,
      to,
      items,
      moved: hs[at],
      anchor: anchorOf(hs, hs[at], at, 'final'),
    });
  };

  const spliceInto = (arr: readonly T[], index: number, item: T): T[] => {
    const next = arr.slice();
    next.splice(clampInsert(index, next.length), 0, item);
    return next;
  };

  let container: HTMLElement | null = null;
  let boundsCache: RectLike | null = null;
  let measureCache = new Map<SortableGroupMember<T>, MemberMeasure>();

  const ensureMeasured = (m: SortableGroupMember<T>) => {
    let r = measureCache.get(m);
    if (!r) {
      r = m.measure();
      measureCache.set(m, r);
    }
    return r;
  };

  const rectOf = (el: HTMLElement): RectLike => el.getBoundingClientRect();

  /**
   * Where `el` sits in LAYOUT, in the drag-start frame: its rect minus the
   * translate it renders with now (a running glide reads mid-way), plus the
   * main-axis scroll travelled since drag start. Used only to re-measure mid-drag.
   */
  const layoutRectOf = (el: HTMLElement): RectLike => {
    const r = el.getBoundingClientRect();
    const t = currentTranslate(el);
    const sd = untracked(scrollDelta);
    return {
      left: r.left - t.x + (collisionAxis === 'x' ? sd : 0),
      top: r.top - t.y + (collisionAxis === 'y' ? sd : 0),
      width: r.width,
      height: r.height,
    };
  };

  /** Linear layout in source order; `null` when a row is not rendered (rendered set ≠ source()). */
  const measureLinear = (read: (el: HTMLElement) => RectLike) => {
    const centers: number[] = [];
    const starts: number[] = [];
    const sizes: number[] = [];
    for (const h of liveHandles()) {
      const node = occ.elementFor(h);
      if (!node) return null;
      const r = read(node);
      centers.push(centerAlong(r, collisionAxis));
      starts.push(startAlong(r, collisionAxis));
      sizes.push(sizeAlong(r, collisionAxis));
    }
    return { centers, starts, sizes };
  };

  /** Footprint = source slot + adjacent gap (after it, else before), not a fixed gap, for variable gaps. */
  const footprintAt = (
    m: { starts: number[]; sizes: number[] },
    i: number,
  ): number => {
    const { starts, sizes } = m;
    const gap =
      i >= 0 && i + 1 < starts.length
        ? starts[i + 1] - (starts[i] + sizes[i])
        : i > 0
          ? starts[i] - (starts[i - 1] + sizes[i - 1])
          : 0;
    return i >= 0 ? sizes[i] + gap : 0;
  };

  /**
   * Wrap layout snapshot: 2D centers in source order plus the median column/row
   * pitch (same-row x steps vs row-break y jumps, split by half the first
   * item's height). Pitch falls back to the source item's own size for
   * degenerate layouts (single item / single row / single column).
   */
  const measureWrap = (
    read: (el: HTMLElement) => RectLike = rectOf,
  ): {
    centers: Point[];
    colPitch: number;
    rowPitch: number;
  } | null => {
    const centers: Point[] = [];
    let firstH = 0;
    let firstW = 0;
    for (const h of liveHandles()) {
      const node = occ.elementFor(h);
      if (!node) return null; // rendered set ≠ source() (e.g. filtered) → bail vs. misalign
      const r = read(node);
      if (!centers.length) {
        firstH = r.height;
        firstW = r.width;
      }
      centers.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    const rowTol = firstH / 2 || 1;
    const colDeltas: number[] = [];
    const rowDeltas: number[] = [];
    for (let i = 1; i < centers.length; i++) {
      const dy = centers[i].y - centers[i - 1].y;
      if (Math.abs(dy) < rowTol) colDeltas.push(centers[i].x - centers[i - 1].x);
      else rowDeltas.push(dy);
    }
    return {
      centers,
      colPitch: median(colDeltas) || firstW,
      rowPitch: median(rowDeltas) || firstH,
    };
  };

  // The last cross-list hover: its target and the hovered slot named by neighbour.
  let hover: {
    target: SortableGroupMember<T>;
    anchor: ListAnchor<unknown> | null;
  } | null = null;

  // The key sequence the geometry was measured against (S1: a mid-drag key change re-measures).
  let measuredFrom: readonly T[] | null = null;
  let measuredHandles: readonly Handle<K>[] = [];

  const begin = (k: Handle<K>, geom: DragGeometry, start: number) => {
    measuredFrom = untracked(source);
    measuredHandles = liveHandles();
    startMain.set(start);
    pointerMain.set(start);
    scrollDelta.set(0);
    geometry.set(geom);
    activeKey.set(k);
  };

  const beginGesture = (k: Handle<K>, start: { x: number; y: number }) => {
    if (wrap) {
      const m = measureWrap();
      const sourceIdx = untracked(indexMap).get(k) ?? -1;
      if (!m || sourceIdx < 0) return;
      startCross.set(projCross(start));
      pointerCross.set(projCross(start));
      begin(
        k,
        { kind: 'wrap', source: sourceIdx, ...m },
        projMain(start),
      );
      if (group) {
        measureCache = new Map();
        for (const gm of group.members()) gm.refreshBounds();
      }
      return;
    }
    // Measure in source order; a missing node means rendered set ≠ source() (e.g. filtered) → bail vs. misalign.
    const m = measureLinear(rectOf);
    if (!m) return;
    const sourceIdx = untracked(indexMap).get(k) ?? -1;
    startCross.set(projCross(start));
    pointerCross.set(projCross(start));
    begin(
      k,
      {
        source: sourceIdx,
        centers: m.centers,
        footprint: footprintAt(m, sourceIdx),
        axis: collisionAxis,
      },
      projMain(start),
    );
    if (group) {
      measureCache = new Map();
      for (const m of group.members()) m.refreshBounds();
    }
  };

  /** The gap a target list should open for OUR dragged item, in ITS flow axis. */
  const outgoingFootprint = (tg: MemberMeasure): number => {
    const geom = untracked(geometry);
    if (!geom) return 0;
    if (geom.kind !== 'wrap') return geom.footprint;
    return tg.kind !== 'wrap' && tg.axis === 'x'
      ? geom.colPitch
      : geom.rowPitch;
  };

  const move = (p: { x: number; y: number }) => {
    pointerMain.set(projMain(p));
    if (wrap || group) pointerCross.set(projCross(p));
    if (!group || !groupApi) return;
    const k = untracked(activeKey);
    if (k === null) return; // no drag (or one abandoned mid-gesture): never drive sibling lists
    // the dragged item is its KEY in the live list, never the drag-start slot
    const srcIdx = untracked(indexMap).get(k) ?? -1;
    const dragged = srcIdx >= 0 ? untracked(source)[srcIdx] : undefined;
    // untracked: targetAt reads the members signal; move() runs inside the
    // gesture effect, which must not re-fire on register/unregister
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
    // Sticky: outside every list keeps the last resolved target — no snap-back / flip-flop.
    if (!target) return;
    if (target === self) {
      if (untracked(groupApi.activeSource) === self) groupApi.clearActive();
      return;
    }
    // over a foreign container → compute the insert in ITS coordinate space
    const tg = ensureMeasured(target);
    const insert = insertIndexForMeasure(tg, p.x, p.y);
    // name the hovered slot by neighbour in the list it was measured against
    hover = {
      target,
      anchor: tg.keys ? slotAnchor(tg.keys, insert) : null,
    };
    groupApi.setActive({
      source: self,
      target,
      sourceIndex: srcIdx,
      insertIndex: insert,
      footprint: outgoingFootprint(tg),
      targetMeasure: tg,
      item: dragged,
      x: p.x,
      y: p.y,
    });
  };

  /**
   * The insert slot in `target` the hover pointed at, resolved NOW by its
   * neighbour anchor (the target may have changed since); `null` = that
   * neighbour is gone. Targets without anchors keep the raw `index`.
   */
  const hoveredSlot = (
    target: SortableGroupMember<T>,
    index: number,
  ): number | null => {
    if (!hover || hover.target !== target || !hover.anchor) return index;
    if (!target.slotOfAnchor) return index;
    const slot = target.slotOfAnchor(hover.anchor);
    return slot < 0 ? null : slot;
  };

  // Single reset point so a new drag-state signal can't be forgotten (and dispose() can tear down mid-drag).
  const resetDragState = () => {
    hover = null;
    geometry.set(null);
    activeKey.set(null);
    startMain.set(0);
    pointerMain.set(0);
    startCross.set(0);
    pointerCross.set(0);
    scrollDelta.set(0);
    if (groupApi && untracked(groupApi.activeSource) === self) {
      groupApi.clearActive();
    }
  };

  /** Give up the in-flight drag, dev-warned: the drop would otherwise act on a guess. */
  const abandon = (reason: string): false => {
    if (isDevMode()) {
      console.warn(
        `[@mmstack/dnd] reorderable: ${reason}; the drag was cancelled.`,
      );
    }
    resetDragState();
    return false;
  };

  const sameHandles = (a: readonly Handle<K>[], b: readonly Handle<K>[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  /**
   * Keep the drag geometry true to the live list (pointer engine). The
   * snapshot is valid while the key sequence it was measured against holds;
   * when another writer changes it mid-drag, re-measure the rendered rows
   * (layout position, transforms subtracted) and rebase the follow so the
   * dragged row stays under the pointer. Returns whether the drag is still
   * alive; the dragged key gone, or a row that cannot be measured, abandons it.
   * Only the render pass measures (`measure`); the drop path never does, since
   * before the change has rendered the DOM still shows the old order.
   */
  const syncGeometry = (measure: boolean): boolean => {
    const k = untracked(activeKey);
    const geom = untracked(geometry);
    if (k === null || !geom) return false;
    const arr = untracked(source);
    if (arr === measuredFrom) return true;
    if (sameHandles(liveHandles(), measuredHandles)) {
      measuredFrom = arr; // an edit in place: the measured layout still holds
      return true;
    }
    const idx = untracked(indexMap).get(k) ?? -1;
    if (idx < 0) {
      return abandon('the dragged item was removed from the list mid-drag');
    }
    if (!measure) {
      return abandon(
        'the list changed mid-drag and the change has not rendered yet, so the drop position is unknown',
      );
    }
    const unmeasurable =
      'the list changed mid-drag and a row is not rendered, so the drop position cannot be measured';
    if (geom.kind === 'wrap') {
      const m = measureWrap(layoutRectOf);
      if (!m) return abandon(unmeasurable);
      const was = geom.centers[geom.source];
      const now = m.centers[idx];
      if (was && now) {
        startMain.update((v) => v + now.y - was.y);
        startCross.update((v) => v + now.x - was.x);
      }
      geometry.set({ kind: 'wrap', source: idx, ...m });
    } else {
      const m = measureLinear(layoutRectOf);
      if (!m) return abandon(unmeasurable);
      const was = geom.centers[geom.source];
      if (was !== undefined) startMain.update((v) => v + m.centers[idx] - was);
      geometry.set({
        source: idx,
        centers: m.centers,
        footprint: footprintAt(m, idx),
        axis: collisionAxis,
      });
    }
    measuredFrom = arr;
    measuredHandles = liveHandles();
    return true;
  };

  const end = () => {
    const k = untracked(activeKey);
    const crossTarget =
      groupApi &&
      untracked(groupApi.activeSource) === self &&
      untracked(groupApi.activeTarget) !== self
        ? untracked(groupApi.activeTarget)
        : null;

    if (k !== null && crossTarget && groupApi) {
      const to = hoveredSlot(
        crossTarget,
        untracked(groupApi.activeInsertIndex),
      );
      if (to === null) {
        abandon(
          'the drop target changed mid-drag and the hovered neighbour is gone',
        );
        return;
      }
      // the dragged KEY in the live list carries over, never the drag-start slot
      const from = untracked(indexMap).get(k) ?? -1;
      if (from < 0) {
        abandon('the dragged item was removed from the list mid-drag');
        return;
      }
      const item = untracked(source)[from];
      const px =
        collisionAxis === 'y'
          ? untracked(pointerCross)
          : untracked(pointerMain);
      const py =
        collisionAxis === 'y'
          ? untracked(pointerMain)
          : untracked(pointerCross);
      // a refused drop (both paths false) is a NO-OP: the item stays home
      const taken = crossTarget.insertAtPoint?.(item, px, py)
        ? true
        : to >= 0
          ? crossTarget.insertAt(item, to)
          : false;
      if (taken) self.takeOut(item, to, crossTarget, k);
    } else if (k !== null) {
      // a key change the render pass has not re-measured yet abandons the drop
      if (!syncGeometry(false)) return;
      const to = untracked(session.insertIndex);
      const from = untracked(indexMap).get(k) ?? -1;
      if (from >= 0 && to >= 0 && from !== to) {
        commitReorder(from, to);
      }
    }

    resetDragState();
  };

  const glide = animation
    ? `transform var(--mm-sortable-duration, ${animation.duration}ms) var(--mm-sortable-easing, ${animation.easing})`
    : 'none';

  const itemState = (
    item: () => T,
    element?: HTMLElement,
  ): ReorderableItemState<K> => {
    const itemKey = computed(() => key(item()));
    // the row's occurrence: its element's binding, else the item's first occurrence
    const handle = computed(
      () => (element && occ.keyForElement(element)) ?? occ.handleOf(item()),
    );
    const index = computed(() => {
      const h = handle();
      return h === undefined ? -1 : (indexMap().get(h) ?? -1);
    });
    const isSource = computed(() => {
      const h = handle();
      return h !== undefined && activeKey() === h;
    });
    const sameListSlot = wrap ? session.slotFor(index) : null;

    const transform = computed(() => {
      // +scrollDelta keeps the dragged item under the finger as the list scrolls
      if (isSource()) return pointerMain() - startMain() + scrollDelta();
      if (groupApi) {
        const src = groupApi.activeSource();
        const tgt = groupApi.activeTarget();
        if (src && src !== tgt) {
          if (wrap) return 0; // wrap lists move by slot vectors, not scalars
          if (tgt === self)
            return openDisplacement(
              index(),
              groupApi.activeInsertIndex(),
              options.insertSize ?? groupApi.activeFootprint(),
            );
          if (src === self)
            return closeDisplacement(
              index(),
              groupApi.activeSourceIndex(),
              groupApi.activeFootprint(),
            );
          return 0;
        }
      }
      const insert = session.insertIndex();
      const geom = geometry();
      if (insert < 0 || !geom || geom.kind === 'wrap') return 0;
      return displacement(index(), geom.source, insert, geom.footprint);
    });

    /**
     * Wrap displacement, decomposed: which SLOT this item currently renders at
     * (`-1` = at rest). An integer leaf — only items whose slot actually
     * changes renotify; the x/y lookups below are pure math off the static
     * drag-start centers.
     */
    const wrapSlot = computed(() => {
      if (!wrap || isSource()) return -1;
      const i = index();
      if (i < 0) return -1;
      if (groupApi) {
        const src = groupApi.activeSource();
        const tgt = groupApi.activeTarget();
        if (src && src !== tgt) {
          if (tgt === self) return openSlotOf(i, groupApi.activeInsertIndex());
          if (src === self)
            return closeSlotOf(i, groupApi.activeSourceIndex());
          return -1;
        }
      }
      const geom = geometry();
      if (!geom || geom.kind !== 'wrap') return -1;
      const ins = session.insertIndex();
      if (ins < 0) return -1;
      return sameListSlot ? sameListSlot() : -1;
    });

    /** The wrap centers this item displaces within (own drag or incoming-target). */
    const wrapCenters = ():
      | { centers: readonly Point[]; colPitch: number; rowPitch: number }
      | null => {
      const geom = geometry();
      if (geom?.kind === 'wrap') return geom;
      const tm = groupApi?.activeTargetMeasure();
      if (tm?.kind === 'wrap' && groupApi?.activeTarget() === self) return tm;
      return null;
    };

    const wrapDeltaAlong = (pick: (p: Point) => number): number => {
      const slot = wrapSlot();
      if (slot < 0) return 0;
      const i = index();
      if (slot === i) return 0;
      const m = wrapCenters();
      if (!m || i >= m.centers.length) return 0;
      const target =
        slot < m.centers.length
          ? m.centers[slot]
          : wrapVirtualSlot(m.centers, m.colPitch, m.rowPitch);
      return pick(target) - pick(m.centers[i]);
    };

    const transformX = computed(() => {
      if (wrap) return wrapDeltaAlong((p) => p.x);
      return collisionAxis === 'x' ? transform() : 0;
    });
    const transformY = computed(() => {
      if (wrap) return wrapDeltaAlong((p) => p.y);
      return collisionAxis === 'y' ? transform() : 0;
    });

    const involved = computed(() => {
      if (activeKey() !== null) return true; // this is the source list
      if (groupApi) {
        const src = groupApi.activeSource();
        return !!src && src !== self && groupApi.activeTarget() === self;
      }
      return false;
    });

    const transformCss = computed(() => {
      if (isSource()) {
        const main = pointerMain() - startMain() + scrollDelta();
        // single linear list: axis-locked follow (deliberate). grouped or wrap:
        // free 2D — the axis is a collision concern, not a leash.
        if (!group && !wrap) return main ? oneAxis(main) : '';
        const cross = pointerCross() - startCross();
        if (!main && !cross) return '';
        const dx = collisionAxis === 'y' ? cross : main;
        const dy = collisionAxis === 'y' ? main : cross;
        return `translate(${dx}px, ${dy}px)`;
      }
      if (wrap) {
        const dx = transformX();
        const dy = transformY();
        return dx || dy ? `translate(${dx}px, ${dy}px)` : '';
      }
      const t = transform();
      return t ? oneAxis(t) : '';
    });

    return {
      itemKey,
      index,
      isSource,
      transform,
      transformX,
      transformY,
      transformCss,
      transitionCss: computed(() =>
        isSource() ? 'none' : involved() ? glide : 'none',
      ),
    };
  };

  const self: ReorderableController<T, K> = {
    items: source,
    key,
    indexMap,
    axis,
    engine,
    group,
    listId,
    nativeInsert,
    setNativeInsert: (src) => insertSource.set(src),
    nativeHoverAnchor: nativeHoverAnchor.asReadonly(),
    setNativeHoverAnchor: (a) => nativeHoverAnchor.set(a),
    activeKey: activeKey.asReadonly(),
    insertIndex: session.insertIndex,
    reservedSpace: computed(() =>
      groupApi &&
      groupApi.activeTarget() === self &&
      groupApi.activeSource() !== self &&
      // EMPTY target has no items to shift (min-height is the slot) → reserving footprint doubles the gap.
      source().length > 0
        ? (options.insertSize ?? groupApi.activeFootprint())
        : 0,
    ),
    insertSize: options.insertSize,
    keyboard,
    jumpModifier,
    onKeyboardKeydown: options.onKeyboardKeydown,
    announceMove,
    moveItem: (from, to) => {
      if (from < 0 || to < 0 || from === to) return;
      if (from >= untracked(source).length) return;
      commitReorder(from, to);
    },
    takeOut: (item, to, target, handle) => {
      // exactly ONE occurrence leaves: the dragged handle's, else the item's own
      const h = handle ?? untracked(() => occ.handleOf(item));
      const from = h === undefined ? -1 : (untracked(indexMap).get(h) ?? -1);
      if (from < 0 || h === undefined) return;
      untracked(occ.state); // observe the state before the removal (handle continuity)
      source.update((arr) => arr.filter((_, i) => i !== from));
      const anchor = (target?.anchorFor?.(item) ?? null) as ListAnchor<
        Handle<K>
      > | null;
      options.onItemLeft?.({ item, from, to, moved: h, anchor });
    },
    insert: options.insert,
    insertForeign: (data, index) => {
      if (!options.insert?.accepts(data)) return;
      const item = options.insert.create(data, index);
      source.update((arr) => spliceInto(arr, index, item));
      options.onItemInserted?.({ item, index });
    },
    setScrollDelta: (d) => scrollDelta.set(d),
    autoScroll,
    animation,
    activationThreshold,
    touchActivation,
    itemState,
    register: (k, el, item) => occ.register(k, el, item),
    unregister: (k, el) => occ.unregister(k, el),
    keyForElement: (el) => untracked(() => occ.keyForElement(el)),
    elementFor: (h) => untracked(() => occ.elementFor(h)),
    handleOf: (item) => occ.handleOf(item),
    handleAt: (i) => occ.handleAt(i),
    setContainer: (el) => {
      container = el;
    },
    begin,
    beginGesture,
    move,
    end,
    syncGeometry: () => {
      syncGeometry(true);
    },
    cancel: resetDragState,
    dispose: () => {
      // destroyed mid-drag → tear down so sibling lists aren't left driven by a dead source.
      if (untracked(activeKey) !== null) resetDragState();
      // destroyed while the hovered TARGET → the source's end() must not commit into us
      if (groupApi && untracked(groupApi.activeTarget) === self) {
        groupApi.clearActive();
      }
      group?.unregister(self);
    },
    bounds: () => boundsCache,
    refreshBounds: () => {
      boundsCache = container ? container.getBoundingClientRect() : null;
    },
    measure: () => {
      if (wrap) {
        const m = measureWrap();
        return m
          ? { kind: 'wrap' as const, ...m, keys: liveHandles() }
          : { kind: 'wrap' as const, centers: [], colPitch: 0, rowPitch: 0 };
      }
      const centers: number[] = [];
      const hs = liveHandles();
      for (const h of hs) {
        const node = occ.elementFor(h);
        // rendered set ≠ source() → misaligned indices; empty is the safe bail
        if (!node) return { centers: [], axis: collisionAxis };
        centers.push(centerAlong(node.getBoundingClientRect(), collisionAxis));
      }
      return { centers, axis: collisionAxis, keys: hs };
    },
    slotOfAnchor: (anchor) =>
      slotOfAnchor(liveHandles(), anchor as ListAnchor<Handle<K>>),
    insertAt: (item, index) => {
      untracked(occ.state); // observe the state before the arrival (handle continuity)
      source.update((arr) => spliceInto(arr, index, item));
      const hs = liveHandles();
      const at = clampInsert(index, hs.length - 1);
      options.onItemArrived?.({
        item,
        index,
        moved: hs[at],
        anchor: anchorOf(hs, hs[at], at, 'final'),
      });
      return true;
    },
    anchorFor: (item) => {
      const h = untracked(() => occ.handleOf(item));
      const i = h === undefined ? -1 : (untracked(indexMap).get(h) ?? -1);
      return i < 0 ? null : anchorOf(liveHandles(), h, i, 'final');
    },
    // untracked: a consumer predicate may read tree signals — don't subscribe move()'s effect to them.
    canReceive: options.canReceive
      ? // eslint-disable-next-line  @typescript-eslint/no-non-null-assertion
        (item) => untracked(() => options.canReceive!(item))
      : undefined,
  };

  group?.register(self);
  return self;
}

/**
 * DI-aware {@link reorderable}: captures the current `Injector` and hands it to the
 * pure factory so `provideReorderableDefaults` / `provideDndDefaults` apply. Call
 * from an injection context (a component field); pass `opts.injector` to override.
 */
export function injectReorderable<T, K>(
  source: WritableSignal<T[]>,
  opts: ReorderableOptions<T, K>,
): ReorderableController<T, K> {
  const injector =
    (opts as ReorderableOptionsAll<T, K>).injector ?? inject(Injector);
  return reorderable(source, { ...opts, injector } as ReorderableOptions<T, K>);
}
