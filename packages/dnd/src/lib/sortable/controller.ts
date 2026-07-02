import {
  computed,
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

import { withDefaults } from '../provide';
import type { DragEngine } from '../session';
import { injectReorderableDefaults } from './defaults';
import {
  type Axis,
  centerAlong,
  clampInsert,
  closeDisplacement,
  displacement,
  insertIndexFromCenters,
  moveWithin,
  openDisplacement,
  type RectLike,
  sizeAlong,
  startAlong,
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
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  return mac ? e.metaKey : e.ctrlKey;
}

/** Default auto-scroll: px from a scroll edge where it engages + max speed (px/frame). */
const DEFAULT_AUTOSCROLL = { edge: 48, speed: 16 } as const;

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
  const deadband = options.deadband ?? 4;
  const engine: DragEngine = options.engine ?? 'native';
  const activationThreshold = options.activationThreshold ?? 5;
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
  }
  const listId = Symbol('@mmstack/dnd:reorderable');
  // null whenever no source set (idle / not hovered) → onDrop's untracked read reflects live state.
  const insertSource = signal<Signal<number | null> | null>(null);
  const nativeInsert = computed(() => insertSource()?.() ?? null);
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

  const byKey = new Map<K, HTMLElement>();
  const byEl = new Map<HTMLElement, K>();
  const geometry = signal<DragGeometry | null>(null);
  const activeKey = signal<K | null>(null);
  const startMain = signal(0);
  const pointerMain = signal(0);
  const startCross = signal(0); // off-axis, for 2D follow when dragging cross-list
  const pointerCross = signal(0);
  // Main-axis scroll since drag start: compensates collision + dragged item WITHOUT re-measuring cached centers.
  const scrollDelta = signal(0);

  const active = computed(() => activeKey() !== null);
  const session = sortableSession({
    geometry,
    // Centers are frozen at drag start; container scrolls Δ shifts items -Δ, so shift pointer +Δ to match.
    pointer: computed(() => pointerMain() + scrollDelta()),
    active,
    deadband,
  });

  const indexMap = computed(() => {
    const map = new Map<K, number>();
    const arr = source();
    for (let i = 0; i < arr.length; i++) map.set(key(arr[i]), i);
    return map;
  });

  const projMain = (p: { x: number; y: number }) => (axis === 'y' ? p.y : p.x);
  const projCross = (p: { x: number; y: number }) => (axis === 'y' ? p.x : p.y);
  const oneAxis = (v: number) =>
    axis === 'y' ? `translateY(${v}px)` : `translateX(${v}px)`;

  const spliceInto = (arr: readonly T[], index: number, item: T): T[] => {
    const next = arr.slice();
    next.splice(clampInsert(index, next.length), 0, item);
    return next;
  };

  let container: HTMLElement | null = null;
  let boundsCache: RectLike | null = null;
  let measureCache = new Map<
    SortableGroupMember<T>,
    { centers: readonly number[]; axis: Axis }
  >();

  const ensureMeasured = (m: SortableGroupMember<T>) => {
    let r = measureCache.get(m);
    if (!r) {
      r = m.measure();
      measureCache.set(m, r);
    }
    return r;
  };

  const begin = (k: K, geom: DragGeometry, start: number) => {
    startMain.set(start);
    pointerMain.set(start);
    scrollDelta.set(0);
    geometry.set(geom);
    activeKey.set(k);
  };

  const beginGesture = (k: K, start: { x: number; y: number }) => {
    const centers: number[] = [];
    const starts: number[] = [];
    const sizes: number[] = [];
    // Measure in source order; a missing node means rendered set ≠ source() (e.g. filtered) → bail vs. misalign.
    for (const it of untracked(source)) {
      const node = byKey.get(key(it));
      if (!node) return;
      const r = node.getBoundingClientRect();
      centers.push(centerAlong(r, axis));
      starts.push(startAlong(r, axis));
      sizes.push(sizeAlong(r, axis));
    }
    const sourceIdx = untracked(indexMap).get(k) ?? -1;
    // Footprint = source slot + adjacent gap (after it, else before), not a fixed gap, for variable gaps.
    const gap =
      sourceIdx >= 0 && sourceIdx + 1 < starts.length
        ? starts[sourceIdx + 1] - (starts[sourceIdx] + sizes[sourceIdx])
        : sourceIdx > 0
          ? starts[sourceIdx] - (starts[sourceIdx - 1] + sizes[sourceIdx - 1])
          : 0;
    const footprint = sourceIdx >= 0 ? sizes[sourceIdx] + gap : 0;
    startCross.set(projCross(start));
    pointerCross.set(projCross(start));
    begin(k, { source: sourceIdx, centers, footprint, axis }, projMain(start));
    if (group) {
      measureCache = new Map();
      for (const m of group.members()) m.refreshBounds();
    }
  };

  const move = (p: { x: number; y: number }) => {
    pointerMain.set(projMain(p));
    if (!group || !groupApi) return;
    pointerCross.set(projCross(p));
    const srcIdx = untracked(session.source);
    const dragged = srcIdx >= 0 ? untracked(source)[srcIdx] : undefined;
    const target = group.targetAt(
      p.x,
      p.y,
      (m) =>
        m === self ||
        dragged === undefined ||
        m.canReceive?.(dragged) !== false,
    );
    // Sticky: outside every list keeps the last resolved target — no snap-back / flip-flop.
    if (!target) return;
    if (target === self) {
      if (untracked(groupApi.activeSource) === self) groupApi.clearActive();
      return;
    }
    // over a foreign list → compute the insert in ITS coordinate space
    const tg = ensureMeasured(target);
    const insert = insertIndexFromCenters(
      tg.centers,
      tg.axis === 'y' ? p.y : p.x,
    );
    groupApi.setActive({
      source: self,
      target,
      sourceIndex: untracked(session.source),
      insertIndex: insert,
      footprint: untracked(geometry)?.footprint ?? 0,
    });
  };

  // Single reset point so a new drag-state signal can't be forgotten (and dispose() can tear down mid-drag).
  const resetDragState = () => {
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

  const end = () => {
    const crossTarget =
      groupApi &&
      untracked(groupApi.activeSource) === self &&
      untracked(groupApi.activeTarget) !== self
        ? untracked(groupApi.activeTarget)
        : null;

    if (crossTarget && groupApi) {
      // Ended over a foreign list: transfer, or no-op if the transfer is invalid —
      // never fall back to a same-list move computed from a pointer outside this list.
      const from = untracked(session.source);
      const to = untracked(groupApi.activeInsertIndex);
      const item = from >= 0 ? untracked(source)[from] : undefined;
      if (item !== undefined && to >= 0) {
        crossTarget.insertAt(item, to);
        self.takeOut(item, to);
      }
    } else {
      const to = untracked(session.insertIndex);
      const from = untracked(session.source);
      if (from >= 0 && to >= 0 && from !== to) {
        source.update((arr) => moveWithin(arr, from, to));
        options.onReorder?.({ from, to, items: untracked(source) });
      }
    }

    resetDragState();
  };

  const glide = animation
    ? `transform var(--mm-sortable-duration, ${animation.duration}ms) var(--mm-sortable-easing, ${animation.easing})`
    : 'none';

  const itemState = (item: () => T): ReorderableItemState<K> => {
    const itemKey = computed(() => key(item()));
    const index = computed(() => indexMap().get(itemKey()) ?? -1);
    const isSource = computed(() => activeKey() === itemKey());

    const transform = computed(() => {
      // +scrollDelta keeps the dragged item under the finger as the list scrolls
      if (isSource()) return pointerMain() - startMain() + scrollDelta();
      if (groupApi) {
        const src = groupApi.activeSource();
        const tgt = groupApi.activeTarget();
        if (src && src !== tgt) {
          if (tgt === self)
            return openDisplacement(
              index(),
              groupApi.activeInsertIndex(),
              groupApi.activeFootprint(),
            );
          if (src === self)
            return closeDisplacement(
              index(),
              groupApi.activeSourceIndex(),
              groupApi.activeFootprint(),
            );
          return 0; // list not involved in this drag
        }
      }
      const insert = session.insertIndex();
      const geom = geometry();
      if (insert < 0 || !geom) return 0;
      return displacement(index(), geom.source, insert, geom.footprint);
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
        // single list: axis-locked follow (deliberate). grouped: free 2D so dragging OUT doesn't feel sticky.
        if (!group) return main ? oneAxis(main) : '';
        const cross = pointerCross() - startCross();
        if (!main && !cross) return '';
        const dx = axis === 'y' ? cross : main;
        const dy = axis === 'y' ? main : cross;
        return `translate(${dx}px, ${dy}px)`;
      }
      const t = transform();
      return t ? oneAxis(t) : '';
    });

    return {
      itemKey,
      index,
      isSource,
      transform,
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
    activeKey: activeKey.asReadonly(),
    insertIndex: session.insertIndex,
    reservedSpace: computed(() =>
      groupApi &&
      groupApi.activeTarget() === self &&
      groupApi.activeSource() !== self &&
      // EMPTY target has no items to shift (min-height is the slot) → reserving footprint doubles the gap.
      source().length > 0
        ? groupApi.activeFootprint()
        : 0,
    ),
    keyboard,
    jumpModifier,
    onKeyboardKeydown: options.onKeyboardKeydown,
    announceMove,
    moveItem: (from, to) => {
      if (from < 0 || to < 0 || from === to) return;
      source.update((arr) => moveWithin(arr, from, to));
      options.onReorder?.({ from, to, items: untracked(source) });
    },
    takeOut: (item, to) => {
      const k = key(item);
      const from = untracked(source).findIndex((i) => key(i) === k);
      if (from < 0) return;
      source.update((arr) => arr.filter((i) => key(i) !== k));
      options.onItemLeft?.({ item, from, to });
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
    itemState,
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
    begin,
    beginGesture,
    move,
    end,
    cancel: resetDragState,
    dispose: () => {
      // destroyed mid-drag → tear down so sibling lists aren't left driven by a dead source.
      if (untracked(activeKey) !== null) resetDragState();
      group?.unregister(self);
    },
    bounds: () => boundsCache,
    refreshBounds: () => {
      boundsCache = container ? container.getBoundingClientRect() : null;
    },
    measure: () => {
      const centers: number[] = [];
      for (const it of untracked(source)) {
        const node = byKey.get(key(it));
        if (node) centers.push(centerAlong(node.getBoundingClientRect(), axis));
      }
      return { centers, axis };
    },
    insertAt: (item, index) => {
      source.update((arr) => spliceInto(arr, index, item));
      options.onItemArrived?.({ item, index });
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
