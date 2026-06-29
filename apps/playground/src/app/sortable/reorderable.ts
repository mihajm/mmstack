import {
  afterNextRender,
  afterRenderEffect,
  ApplicationRef,
  computed,
  createComponent,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

import {
  draggable,
  dropTarget,
  injectAnnounce,
  injectDndActive,
  injectDndPointer,
  injectDndTargets,
  resolvePostMoveFlash,
  unboxData,
  type DragMeta,
  type Edge,
} from '@mmstack/dnd';

import { DropIndicator } from './drop-indicator';

const isHorizontal = (edges: Edge[] | undefined): boolean =>
  (edges ?? ['top', 'bottom']).some((e) => e === 'left' || e === 'right');

export const REORDERABLE_ID_KEY = Symbol('@mmstack/dnd:reorderable-id');
export const REORDERABLE_GROUP_KEY = Symbol('@mmstack/dnd:reorderable-group');

export type ReorderableMeta = {
  readonly id: symbol;
  readonly group: string | undefined;
};

export type ReorderEvent<T> = { item: T; from: number; to: number };
export type ItemArrivedEvent<T> = { item: T; to: number };
export type ItemLeftEvent<T> = { item: T; from: number };
export type ItemInsertedEvent<T> = { item: T; to: number; source: unknown };

/**
 * Accept items dragged from OUTSIDE any reorderable — e.g. a palette `draggable`
 * whose payload differs from the list item type. `accepts` qualifies the raw
 * dragged payload; `create` maps it to a list item `T` (the inserted "clone") at
 * the resolved index. Without this, a list only takes items from itself or a
 * shared-`group` reorderable.
 */
export type ReorderableInsert<T> = {
  accepts: (data: unknown) => boolean;
  create: (data: unknown, index: number) => T;
};

export type ReorderableOptions<T> = {
  accepts: (d: unknown) => d is T;
  key: (item: T) => string | number;
  /**
   * When two reorderables share the same `group` string they can exchange items
   * via cross-list drag. Omit to restrict to within-list reordering.
   */
  group?: string;
  /** Accept foreign (non-reorderable) drops, mapping the payload to a list item. */
  insert?: ReorderableInsert<T>;
  /**
   * Axis hint — `['top','bottom']` (vertical, default) or `['left','right']`
   * (horizontal). Sets the collision axis and keyboard arrow direction; the
   * insert position is computed by pointer-vs-center collision, not the hitbox.
   */
  edges?: Edge[];
  /** Render the default drop indicator on each item. Defaults to `true`. */
  indicated?: boolean;
  /**
   * Center the indicator line in the gap between items (auto-derived from the
   * spacing). Degrades to a no-op for flush lists. Set `false` to keep the line
   * on the item's border. @default true
   */
  centerLine?: boolean;
  /**
   * How a pending drop is shown. `'indicator'` (default) draws the insertion line;
   * `'gap'` instead opens a SortableJS-style gap at the drop position and dims the
   * dragged item (the line is suppressed). Gap sizing/derivation is effect-free
   * until you opt in.
   */
  placeholder?: 'indicator' | 'gap';
  /**
   * Enable keyboard reordering on focused items: Arrow keys move one step,
   * Ctrl/Cmd+Arrow jumps to the start/end. Items become focusable (`tabindex`).
   * On each keyboard move, the item is post-move-flashed (if the flourish plugin
   * is registered) and announced (via `announceItem`).
   */
  keyboard?: boolean;
  /** FLIP-animate items to their new positions on reorder. @default false */
  animate?: boolean | { duration?: number; easing?: string };
  /** Label for screen-reader announcements of keyboard moves (e.g. `(c) => c.title`). */
  announceItem?: (item: T) => string;
  onReorder?: (event: ReorderEvent<T>) => void;
  onItemArrived?: (event: ItemArrivedEvent<T>) => void;
  onItemLeft?: (event: ItemLeftEvent<T>) => void;
  /** Fires when a foreign item is inserted via `insert`. */
  onItemInserted?: (event: ItemInsertedEvent<T>) => void;
};

export type ReorderableRef<T> = {
  items: Signal<readonly T[]>;
  key: (item: T) => string | number;
  readonly _meta: ReorderableMeta;
  readonly _opts: ReorderableOptions<T>;
  readonly _items: WritableSignal<T[]>;
};

type SlotData = {
  reorderableId: symbol;
  group: string | undefined;
  index: number;
};

function isSlotData(d: unknown): d is SlotData {
  return (
    !!d &&
    typeof d === 'object' &&
    'reorderableId' in d &&
    typeof (d as SlotData).index === 'number'
  );
}

function readSourceMeta(
  meta: DragMeta,
): { id: symbol; group: string | undefined } | null {
  const id = meta[REORDERABLE_ID_KEY] as symbol | undefined;
  if (!id) return null;
  const group = meta[REORDERABLE_GROUP_KEY] as string | undefined;
  return { id, group };
}

function acceptsFromGroup(meta: DragMeta, target: ReorderableMeta): boolean {
  const sourceId = meta[REORDERABLE_ID_KEY] as symbol | undefined;
  if (!sourceId) return false;
  if (sourceId === target.id) return true;
  if (!target.group) return false;
  const sourceGroup = meta[REORDERABLE_GROUP_KEY] as string | undefined;
  return sourceGroup === target.group;
}

// ── Pure list ops (exported for unit tests; not re-exported from the barrel) ──

export function computeInsertIndex(
  targetIndex: number,
  edge: Edge | null,
): number {
  return targetIndex + (edge === 'bottom' || edge === 'right' ? 1 : 0);
}

export function handleSameListReorder<T>(
  ref: ReorderableRef<T>,
  item: T,
  rawTo: number,
): void {
  const arr = ref._items();
  const k = ref.key(item);
  const from = arr.findIndex((i) => ref.key(i) === k);
  if (from === -1) return;
  let to = rawTo;
  if (from < to) to -= 1;
  if (from === to) return;
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, moved);
  ref._items.set(next);
  ref._opts.onReorder?.({ item, from, to });
}

export function handleCrossListArrival<T>(
  ref: ReorderableRef<T>,
  item: T,
  to: number,
): void {
  const next = ref._items().slice();
  const clamped = Math.min(Math.max(to, 0), next.length);
  next.splice(clamped, 0, item);
  ref._items.set(next);
  ref._opts.onItemArrived?.({ item, to: clamped });
}

/** Inserts a foreign payload (mapped via `insert.create`) at `to`. No-op without `insert`. */
export function handleExternalInsert<T>(
  ref: ReorderableRef<T>,
  data: unknown,
  to: number,
): void {
  const insert = ref._opts.insert;
  if (!insert?.accepts(data)) return;
  const next = ref._items().slice();
  const clamped = Math.min(Math.max(to, 0), next.length);
  const item = insert.create(data, clamped);
  next.splice(clamped, 0, item);
  ref._items.set(next);
  ref._opts.onItemInserted?.({ item, to: clamped, source: data });
}

/** Does this dragged payload qualify for THIS reorderable (own/group member, or foreign-insert)? */
function canDropHere<T>(
  ref: ReorderableRef<T>,
  data: unknown,
  meta: DragMeta,
): boolean {
  return acceptsFromGroup(meta, ref._meta) || !!ref._opts.insert?.accepts(data);
}

/**
 * Insert index from item center coordinates (ascending) + the pointer position:
 * the count of centers the pointer has passed. Gap-safe (works in the dead space
 * between items) and stable (centers are cached at drag start, so an opening gap
 * can't feed back) — this is the "closest" collision that kills the jank.
 */
export function insertIndexFromCenters(
  centers: readonly number[],
  pos: number,
): number {
  let i = 0;
  while (i < centers.length && pos > centers[i]) i++;
  return i;
}

/** Pure: moves the item at `from` to final index `to`. */
export function moveWithin<T>(
  arr: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = arr.slice();
  const [m] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, m);
  return next;
}

/**
 * Builds a sortable-list ref over your `WritableSignal<T[]>`. Reorder is a pure
 * splice on your signal; the insertion indicator is derived. Bind the ref to the
 * `mmReorderable` container + `mmReorderableItem` directives. Single-list, or
 * cross-list via a shared `group`. Edges need the hitbox plugin.
 *
 * @example
 * ```ts
 * @Component({
 *   imports: [Reorderable, ReorderableItem],
 *   template: `
 *     <ul [mmReorderable]="list">
 *       @for (c of list.items(); track list.key(c)) {
 *         <li [mmReorderableItem]="c">{{ c.label }}</li>
 *       }
 *     </ul>`,
 * })
 * export class List {
 *   readonly cards = signal<Card[]>([]);
 *   protected readonly list = reorderable(this.cards, {
 *     accepts: isCard,
 *     key: (c) => c.id,
 *     keyboard: true,        // arrows reorder; Ctrl/Cmd+arrow jumps to the end
 *     animate: true,         // FLIP transition on reorder
 *     // group: 'cards',     // cross-list with other reorderables sharing this string
 *   });
 * }
 * ```
 */
export function reorderable<T>(
  items: WritableSignal<T[]>,
  opts: ReorderableOptions<T>,
): ReorderableRef<T> {
  const id = Symbol(`@mmstack/dnd:reorderable[${opts.group ?? 'anon'}]`);
  return {
    items: items.asReadonly(),
    key: opts.key,
    _meta: { id, group: opts.group },
    _opts: opts,
    _items: items,
  };
}

@Directive({
  selector: '[mmReorderable]',
  exportAs: 'mmReorderable',
})
export class Reorderable<T = unknown> {
  readonly ref = input.required<ReorderableRef<T>>({ alias: 'mmReorderable' });

  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly active = injectDndActive();
  private readonly targets = injectDndTargets();
  private readonly pointer = injectDndPointer();

  /** key → index map, computed once per items() change (O(n), shared by items). */
  readonly indexByKey = computed(() => {
    const r = this.ref();
    const m = new Map<string | number, number>();
    r._items().forEach((it, i) => m.set(r.key(it), i));
    return m;
  });

  /** True while the innermost hovered target belongs to THIS list (vs a nested list). */
  private readonly isActiveOwner = computed<boolean>(() => {
    const r = this.ref();
    if (!this.active()) return false;
    const innermost = this.targets()[0];
    if (!innermost) return false;
    const slot = unboxData<SlotData>(innermost.data);
    return !!slot && isSlotData(slot) && slot.reorderableId === r._meta.id;
  });

  // Item centers cached at drag start — stable across the drag, so an opening gap
  // or a moving indicator can't feed back into hit-testing (kills shake + flash).
  private readonly registered = new Set<ReorderableItem<T>>();
  private readonly _centers = signal<readonly number[]>([]);
  _register(item: ReorderableItem<T>): void {
    this.registered.add(item);
  }
  _unregister(item: ReorderableItem<T>): void {
    this.registered.delete(item);
  }

  /** The single global insert index while THIS list is the innermost hovered target. */
  readonly activeInsert = computed<number | null>(() => {
    if (!this.isActiveOwner()) return null;
    const p = this.pointer();
    const pos = isHorizontal(this.ref()._opts.edges) ? p.x : p.y;
    return insertIndexFromCenters(this._centers(), pos);
  });

  // Half the inter-item spacing — offsets the indicator line so it sits centered
  // in the gap between items instead of on an item's border. Measured once.
  _lineOffset = 0;

  // Captured each frame so the drop commits at the SAME index the indicator shows
  // (session signals may be cleared by the time onDrop fires).
  private _lastInsert: number | null = null;
  /** Insert index to commit a drop at (collision result, or the end as a fallback). */
  _insertTarget(): number {
    return this._lastInsert ?? this.ref()._items().length;
  }

  // Gap size is captured at drag start (before the source is hidden), not read live.
  private readonly _draggedSize = signal(0);
  readonly gapSize = computed<number>(() =>
    this.active() ? this._draggedSize() : 0,
  );
  /** Called by the source item at drag start to record its size for the gap. */
  _setDraggedSize(px: number): void {
    this._draggedSize.set(px);
  }

  constructor() {
    const getRef = () => this.ref();
    const host = this.host;

    // Snapshot item centers once per drag (re-measure if the count changes mid-drag).
    // Runs before the items' gap effects (parent effect first), so the source is
    // still in flow and measured.
    effect(() => {
      if (!this.active()) return;
      const count = this.ref()._items().length; // tracked → re-measure on count change
      untracked(() => {
        if (count === 0) {
          this._centers.set([]);
          return;
        }
        const horizontal = isHorizontal(this.ref()._opts.edges);
        this._centers.set(
          [...this.registered]
            .sort((a, b) => a.index() - b.index())
            .map((it) => {
              const r = it.hostEl.getBoundingClientRect();
              return horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
            }),
        );
      });
    });

    // Capture the live collision index so onDrop commits exactly where the line is.
    effect(() => {
      this._lastInsert = this.activeInsert();
    });

    dropTarget<T, SlotData>({
      accepts: (d): d is T => {
        const r = getRef();
        return r._opts.accepts(d) || !!r._opts.insert?.accepts(d);
      },
      data: () => ({
        reorderableId: getRef()._meta.id,
        group: getRef()._meta.group,
        index: getRef()._items().length,
      }),
      canDrop: ({ source: { data, meta } }) =>
        canDropHere(getRef(), data, meta),
      onDrop: ({ data, meta, location }) => {
        // Only act when WE are the innermost target — else a child item handled it.
        if (location.current[0]?.element !== host) return;
        const r = getRef();
        const sourceMeta = readSourceMeta(meta);
        const to = this._insertTarget();
        if (!sourceMeta) {
          handleExternalInsert(r, data, to);
        } else if (sourceMeta.id === r._meta.id) {
          handleSameListReorder(r, data, to);
        } else {
          handleCrossListArrival(r, data, to);
        }
      },
    });

    // Empty list only — a non-empty list's items host the line (incl. the end).
    const containerEdge = computed<Edge | null>(() => {
      const opts = getRef()._opts;
      if (opts.placeholder === 'gap' || !(opts.indicated ?? true)) return null;
      if (getRef()._items().length > 0) return null;
      return this.activeInsert() === 0
        ? isHorizontal(opts.edges)
          ? 'left'
          : 'top'
        : null;
    });

    const envInjector = inject(EnvironmentInjector);
    const appRef = inject(ApplicationRef);
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
      // Measure the inter-item spacing once → half it centers the line in the gap.
      const ordered = [...this.registered].sort(
        (a, b) => a.index() - b.index(),
      );
      if (getRef()._opts.centerLine !== false && ordered.length >= 2) {
        const a = ordered[0].hostEl.getBoundingClientRect();
        const b = ordered[1].hostEl.getBoundingClientRect();
        const gap = isHorizontal(getRef()._opts.edges)
          ? b.left - a.right
          : b.top - a.bottom;
        this._lineOffset = Math.max(0, gap / 2);
      }
      const ref = createComponent(DropIndicator, {
        environmentInjector: envInjector,
      });
      ref.setInput('edgeSource', containerEdge);
      ref.setInput('gap', this._lineOffset);
      host.appendChild(ref.location.nativeElement);
      appRef.attachView(ref.hostView);
      destroyRef.onDestroy(() => {
        appRef.detachView(ref.hostView);
        ref.destroy();
      });
    });
  }
}

@Directive({
  selector: '[mmReorderableItem]',
  exportAs: 'mmReorderableItem',
})
export class ReorderableItem<T = unknown> {
  readonly item = input.required<T>({ alias: 'mmReorderableItem' });
  /** Host element — read by the container to measure item centers for collision. */
  readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** True while THIS item is being dragged — style the source (e.g. a faded ghost). */
  readonly dragging: Signal<boolean>;

  private readonly parent = inject<Reorderable<T>>(Reorderable);

  readonly index = computed(() => {
    const r = this.parent.ref();
    return this.parent.indexByKey().get(r.key(this.item())) ?? -1;
  });

  constructor() {
    const getRef = () => this.parent.ref();
    const hostEl = this.hostEl;
    this.parent._register(this);
    inject(DestroyRef).onDestroy(() => this.parent._unregister(this));
    // Stable per-ref meta object — avoids rebuilding it on every getInitialData read.
    const dragMeta = computed<DragMeta>(() => ({
      [REORDERABLE_ID_KEY]: getRef()._meta.id,
      [REORDERABLE_GROUP_KEY]: getRef()._meta.group,
    }));

    const dragRef = draggable<T, DragMeta>({
      data: this.item,
      meta: dragMeta,
      onDragStart: () => {
        // Record the source size while still in flow, before the gap hides it.
        if (getRef()._opts.placeholder === 'gap') {
          this.parent._setDraggedSize(
            isHorizontal(getRef()._opts.edges)
              ? hostEl.offsetWidth
              : hostEl.offsetHeight,
          );
        }
      },
      onDrop: ({ data, location }) => {
        const target = location.current[0]?.data;
        if (!isSlotData(target)) return;
        const r = getRef();
        if (target.reorderableId === r._meta.id) return; // same-list, target handled it
        const k = r.key(data);
        const from = r._items().findIndex((i) => r.key(i) === k);
        if (from === -1) return;
        r._items.update((arr) => arr.filter((i) => r.key(i) !== k));
        r._opts.onItemLeft?.({ item: data, from });
      },
    });
    this.dragging = dragRef.dragging;

    dropTarget<T, SlotData>({
      accepts: (d): d is T => {
        const r = getRef();
        return r._opts.accepts(d) || !!r._opts.insert?.accepts(d);
      },
      data: () => ({
        reorderableId: getRef()._meta.id,
        group: getRef()._meta.group,
        index: this.index(),
      }),
      canDrop: ({ source: { data, meta } }) =>
        canDropHere(getRef(), data, meta),
      onDrop: ({ data, meta, location }) => {
        // Only the innermost item acts — pragmatic fires onDrop on every stacked
        // target, so a nested same-group reorderable would otherwise double-insert.
        if (location.current[0]?.element !== hostEl) return;
        const r = getRef();
        const to = this.parent._insertTarget(); // collision index = where the line is
        const sourceMeta = readSourceMeta(meta);
        if (!sourceMeta) {
          handleExternalInsert(r, data, to);
        } else if (sourceMeta.id === r._meta.id) {
          handleSameListReorder(r, data, to);
        } else {
          handleCrossListArrival(r, data, to);
        }
      },
    });

    // The "fold": one line per list at the active insert index. "After A" and
    // "before B" resolve to the same index → the same line → no jank, and a nested
    // outer item stays clean (its list isn't the innermost target). Null in gap mode.
    const indicatorEdge = computed<Edge | null>(() => {
      const opts = getRef()._opts;
      if (opts.placeholder === 'gap' || !(opts.indicated ?? true)) return null;
      const ins = this.parent.activeInsert();
      if (ins === null) return null;
      const i = this.index();
      const horizontal = isHorizontal(opts.edges);
      if (ins === i) return horizontal ? 'left' : 'top';
      if (ins === i + 1 && i === getRef()._items().length - 1) {
        return horizontal ? 'right' : 'bottom';
      }
      return null;
    });

    const destroyRef = inject(DestroyRef);
    const envInjector = inject(EnvironmentInjector);
    const appRef = inject(ApplicationRef);
    const flash = resolvePostMoveFlash();
    const announce = injectAnnounce();

    // Gap placeholder (opt-in): pull the source from flow + open an equal gap, so
    // the list height stays constant (no shake). Gated → no effect by default.
    if (getRef()._opts.placeholder === 'gap') {
      const horizontal = isHorizontal(getRef()._opts.edges);
      const beforeProp = horizontal ? 'marginInlineStart' : 'marginBlockStart';
      const afterProp = horizontal ? 'marginInlineEnd' : 'marginBlockEnd';
      effect(() => {
        // Mirror the indicator fold: gap BEFORE the insert item, or AFTER the last
        // item when inserting at the end (no item exists at index === length).
        const ins = this.parent.activeInsert();
        const i = this.index();
        const size = this.parent.gapSize();
        const before = ins === i ? size : 0;
        const after =
          ins === i + 1 && i === getRef()._items().length - 1 ? size : 0;
        hostEl.style[beforeProp] = before ? `${before}px` : '';
        hostEl.style[afterProp] = after ? `${after}px` : '';
        hostEl.style.display = dragRef.dragging() ? 'none' : '';
      });
    }

    // FLIP: slide from the previous to the new screen position on reorder.
    const animate = getRef()._opts.animate;
    if (animate) {
      const cfg = typeof animate === 'object' ? animate : {};
      let prev: { x: number; y: number } | null = null;
      afterRenderEffect({
        earlyRead: () => {
          getRef()._items(); // track any list change so prev never goes stale
          const r = hostEl.getBoundingClientRect();
          return { x: r.left, y: r.top };
        },
        write: (curr) => {
          const c = curr();
          if (prev && (prev.x !== c.x || prev.y !== c.y) && hostEl.animate) {
            hostEl.animate(
              [
                {
                  transform: `translate(${prev.x - c.x}px, ${prev.y - c.y}px)`,
                },
                { transform: 'translate(0, 0)' },
              ],
              { duration: cfg.duration ?? 180, easing: cfg.easing ?? 'ease' },
            );
          }
          prev = c;
        },
      });
    }

    // Render the contained indicator (effect-free: binds the edge signal once); skipped in gap mode.
    afterNextRender(() => {
      if (getRef()._opts.placeholder !== 'gap') {
        if (getComputedStyle(hostEl).position === 'static') {
          hostEl.style.position = 'relative';
        }
        const ref = createComponent(DropIndicator, {
          environmentInjector: envInjector,
        });
        ref.setInput('edgeSource', indicatorEdge);
        ref.setInput('gap', this.parent._lineOffset); // center the line in the gap
        hostEl.appendChild(ref.location.nativeElement);
        appRef.attachView(ref.hostView);
        destroyRef.onDestroy(() => {
          appRef.detachView(ref.hostView);
          ref.destroy();
        });
      }

      // Keyboard reordering (opt-in) — only wire the listener when enabled.
      if (!getRef()._opts.keyboard) return;
      if (!hostEl.hasAttribute('tabindex')) hostEl.tabIndex = 0;

      const controller = new AbortController();
      hostEl.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          if (e.target !== hostEl) return; // don't hijack arrows inside child inputs
          const r = getRef();
          const edges = r._opts.edges ?? ['top', 'bottom'];
          const map: Record<string, number> = {};
          if (edges.includes('top') || edges.includes('bottom')) {
            map['ArrowUp'] = -1;
            map['ArrowDown'] = 1;
          }
          if (edges.includes('left') || edges.includes('right')) {
            map['ArrowLeft'] = -1;
            map['ArrowRight'] = 1;
          }
          const delta = map[e.key];
          if (delta === undefined) return;
          e.preventDefault();
          const from = this.index();
          if (from < 0) return;
          const len = r._items().length;
          const to =
            e.ctrlKey || e.metaKey ? (delta < 0 ? 0 : len - 1) : from + delta;
          if (to < 0 || to >= len || to === from) return;
          const item = this.item();
          r._items.set(moveWithin(r._items(), from, to));
          r._opts.onReorder?.({ item, from, to });
          queueMicrotask(() => hostEl.focus());
          flash?.(hostEl);
          const label = r._opts.announceItem?.(item);
          if (label) announce(`${label} moved to position ${to + 1} of ${len}`);
        },
        { signal: controller.signal },
      );
      destroyRef.onDestroy(() => controller.abort());
    });
  }
}
