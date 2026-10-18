import {
  afterRenderEffect,
  ApplicationRef,
  computed,
  createComponent,
  DestroyRef,
  effect,
  EnvironmentInjector,
  inject,
  Injector,
  inputBinding,
  isDevMode,
  signal,
  untracked,
} from '@angular/core';
import { type Handle, nestedEffect } from '@mmstack/primitives';

import { resolveAutoScroll } from '../provide';

import { draggable } from '../element/draggable';
import { dropTarget } from '../element/drop-target';
import type { DragMeta, Edge } from '../internal/types';
import {
  DndSession,
  injectDndActive,
  injectDndPointer,
  injectDndTargets,
} from '../session';
import { DropIndicator } from './drop-indicator';
import {
  type Axis,
  insertIndexFromCenters,
  type ListAnchor,
  slotAnchor,
  slotOfAnchor,
} from './geometry';
import { keyboardReorder } from './keyboard';
import type { ReorderableController, ReorderableItemBinding } from './types';

/** Symbols carried on a native sortable drag: its source list id + a ref to the source controller. */
const NATIVE_LIST_ID = Symbol('@mmstack/dnd:reorderable-list');
const NATIVE_SOURCE = Symbol('@mmstack/dnd:reorderable-source');
/** The dragged row's occurrence handle (duplicate keys / a repeated object). */
const NATIVE_HANDLE = Symbol('@mmstack/dnd:reorderable-handle');
/** The native container's "not measured during this drag" key sequence. */
const UNMEASURED: readonly never[] = [];

/**
 * Shared drop gate for a native list's container + item drop targets: accept a
 * same-list reorder, a same-group cross-list transfer (with the cycle/consumer
 * guard), or a foreign palette payload via `insert`.
 */
function canDropOnList<T, K>(
  c: ReorderableController<T, K>,
  source: { data: T; meta: DragMeta },
): boolean {
  const meta = source.meta as Record<symbol, unknown>;
  if (meta[NATIVE_LIST_ID] === c.listId) return true;
  const src = meta[NATIVE_SOURCE] as ReorderableController<T, K> | undefined;
  if (src)
    return (
      !!c.group &&
      src.group === c.group &&
      (c.canReceive ? c.canReceive(source.data) : true)
    );
  return !!c.insert?.accepts(source.data); // foreign palette payload
}

/**
 * @internal The native engine's drop commit, given the list it landed on (`c`),
 * the source list (`src`, absent for a foreign payload), the drag payload and the
 * insert slot (+ the hover's neighbour anchor for that slot, when recorded).
 */
export function commitNativeDrop<T, K>(
  c: ReorderableController<T, K>,
  src: ReorderableController<T, K> | undefined,
  data: T,
  slot: number,
  anchor: ListAnchor<Handle<K>> | null,
  handle?: Handle<K>,
): void {
  // the hovered place, by neighbour, resolved against the list as it is NOW
  const to = anchor ? slotOfAnchor(handlesOf(c), anchor) : slot;
  if (to < 0) {
    return warnNative(
      'the drop target changed mid-drag and the hovered neighbour is gone',
    );
  }
  if (!src) {
    c.insertForeign(data, to); // foreign payload → map + insert
    return;
  }
  // the dragged OCCURRENCE in the source's live list (its handle, else the
  // payload's reference or key), never the drag-start payload itself
  const h = occurrenceIn(src, data, handle);
  const from = h === undefined ? -1 : (untracked(src.indexMap).get(h) ?? -1);
  if (from < 0 || h === undefined) {
    return warnNative('the dragged item was removed from its list mid-drag');
  }
  if (src.listId === c.listId) {
    c.moveItem(from, from < to ? to - 1 : to); // insert slot → final index
  } else {
    const item = untracked(src.items)[from];
    if (c.insertAt(item, to)) src.takeOut(item, to, c, h);
  }
}

/** A list's live handles, in order. */
function handlesOf<T, K>(c: ReorderableController<T, K>): Handle<K>[] {
  return untracked(() => c.items().map((_, i) => c.handleAt(i) as Handle<K>));
}

/** The drag's occurrence in `src` now: the handle it carried if still there, else `data`'s. */
function occurrenceIn<T, K>(
  src: ReorderableController<T, K>,
  data: T,
  handle: Handle<K> | undefined,
): Handle<K> | undefined {
  if (handle !== undefined && untracked(src.indexMap).has(handle))
    return handle;
  return untracked(() => src.handleOf(data));
}

function warnNative(reason: string): void {
  if (isDevMode()) {
    console.warn(
      `[@mmstack/dnd] reorderable: ${reason}; the drop was ignored.`,
    );
  }
}

/**
 * The indicator "fold" for the native engine: given the list's single active
 * insert index, which edge (if any) should item `index` draw its drop line on?
 *
 * The whole list shares ONE insert index, so "after item i" and "before item
 * i+1" resolve to the same index → the same single line (no double line, no
 * jank). A line shows BEFORE the item at the insert index; the special end case
 * (`insert === length`) shows AFTER the last item.
 *
 * @param activeInsert the list's insert index, or `null` when not the hovered list
 * @param index this item's index
 * @param lastIndex the last item's index (`length - 1`)
 * @param axis `'y'` → top/bottom, `'x'` → left/right
 */
export function indicatorEdge(
  activeInsert: number | null,
  index: number,
  lastIndex: number,
  axis: Axis,
): Edge | null {
  if (activeInsert === null) return null;
  const horizontal = axis === 'x';
  if (activeInsert === index) return horizontal ? 'left' : 'top';
  if (activeInsert === index + 1 && index === lastIndex)
    return horizontal ? 'right' : 'bottom';
  return null;
}

/**
 * Native-engine container wiring (`engine: 'native'`): the list is a pragmatic
 * drop target; items stay put and a {@link DropIndicator} shows the insert. The
 * insert index comes from the unified session pointer + centers cached at drag
 * start — the SAME collision as the pointer engine, just a different source +
 * render. Creates NO pointer machinery (the pointer connect branched away first).
 */
export function connectNativeContainer<T, K = unknown>(
  controller: () => ReorderableController<T, K>,
  element: HTMLElement,
): void {
  controller().setContainer(element);
  inject(DndSession).ensureNativeMonitor(); // native engine feeds via pragmatic
  const active = injectDndActive();
  const pointer = injectDndPointer();
  const targets = injectDndTargets();

  // Centers cached per drag — stable, so an indicator move can't feed back into hit-testing.
  const centers = signal<readonly number[]>([]);
  // the key sequence those centers were measured against (a hover's anchor names a slot in it)
  // UNMEASURED until this drag's first measurement (reset when the drag ends)
  const centerKeys = signal<readonly Handle<K>[]>(UNMEASURED);
  effect(() => {
    if (!active()) untracked(() => centerKeys.set(UNMEASURED));
  });
  afterRenderEffect({
    earlyRead: () => {
      if (!active()) return null;
      const c = controller();
      void c.items();
      const m = c.measure();
      // a bailed measurement (a row not rendered) has no keys: not measured
      const keys = (m.keys ?? UNMEASURED) as readonly Handle<K>[];
      // native + wrap is unsupported (dev-warned at creation) → degrade to empty
      return { centers: m.kind === 'wrap' ? [] : m.centers, keys };
    },
    write: (measured) => {
      const m = measured();
      if (m) {
        centers.set(m.centers);
        centerKeys.set(m.keys);
      }
    },
  });

  // While scrolling, frozen drag-start centers drift by `scrollDelta`, so the collision shifts the pointer to match.
  const getAutoScroll = resolveAutoScroll(inject(Injector));
  const scrollDelta = signal(0);
  let stopScroll: (() => void) | null = null;
  effect(() => {
    const c = controller();
    const cfg = active() ? c.autoScroll : null;
    untracked(() => {
      if (cfg && !stopScroll) {
        const plugin = getAutoScroll(); // warns once if opted-in but no plugin
        if (!plugin) return;
        stopScroll = plugin({
          element,
          axis: c.axis === 'x' ? 'x' : 'y',
          pointer: () => pointer(),
          edge: cfg.edge,
          speed: cfg.speed,
          edgeProportion: cfg.edgeProportion,
          maxSpeedAt: cfg.maxSpeedAt,
          onScroll: (d: number) => scrollDelta.set(d),
        });
      } else if (!cfg && stopScroll) {
        stopScroll();
        stopScroll = null;
        scrollDelta.set(0);
      }
    });
  });

  const isOwner = computed(
    () => active() && targets().some((t) => t.element === element),
  );
  const activeInsert = computed<number | null>(() => {
    if (!isOwner()) return null;
    const p = pointer();
    const main =
      (controller().axis === 'x' ? p.x : p.y) + scrollDelta();
    return insertIndexFromCenters(centers(), main);
  });
  controller().setNativeInsert(activeInsert);

  // The hovered slot, named by neighbour when the POINTER picks it. A list change
  // under a still pointer keeps the recorded anchor, so the drop lands where the
  // indicator was, not wherever the shifted rows put that slot index.
  let seenKeys: readonly Handle<K>[] | null = null;
  let seenPointer: unknown = null;
  effect(() => {
    const ins = activeInsert();
    const keys = centerKeys();
    const p = pointer();
    untracked(() => {
      const c = controller();
      const kept = c.nativeHoverAnchor();
      const listMoved = keys !== seenKeys && p === seenPointer;
      seenKeys = keys;
      seenPointer = p;
      if (ins == null) c.setNativeHoverAnchor(null);
      // not measured (yet, or a row not rendered): nothing new to name; keep what was recorded
      else if (keys === UNMEASURED) return;
      else if (!(listMoved && kept)) {
        c.setNativeHoverAnchor(slotAnchor(keys, ins));
      }
    });
  });

  dropTarget<T, { listId: symbol }>({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accept-all guard; the real gate is canDrop (own-list / same-group meta)
    accepts: (d): d is T => true,
    data: () => ({ listId: controller().listId }),
    canDrop: ({ source }) => canDropOnList(controller(), source),
    onDrop: ({ data, meta }) => {
      const c = controller();
      // read synchronously before the deferred effect clears it
      const to = untracked(c.nativeInsert);
      if (to == null) return;
      const tags = meta as Record<symbol, unknown>;
      const src = tags[NATIVE_SOURCE] as
        ReorderableController<T, K> | undefined;
      const handle = tags[NATIVE_HANDLE] as Handle<K> | undefined;
      commitNativeDrop(
        c,
        src,
        data,
        to,
        untracked(c.nativeHoverAnchor),
        handle,
      );
    },
  });

  inject(DestroyRef).onDestroy(() => {
    stopScroll?.();
    controller().setNativeInsert(null);
    controller().dispose?.();
  });
}

/**
 * Native-engine item wiring: a pragmatic `draggable` (carrying the list id) +
 * a {@link DropIndicator} drawing the fold edge. Returns the same
 * {@link ReorderableItemBinding} the directive expects, with inert transform /
 * transition (the item doesn't move) and `isSource` from the native drag.
 */
export function connectNativeItem<T, K = unknown>(
  controller: () => ReorderableController<T, K>,
  item: () => T,
  element: HTMLElement,
): ReorderableItemBinding<K> {
  nestedEffect((onCleanup) => {
    const c = controller();
    const it = item();
    const k = c.key(it);
    c.register(k, element, it); // binds the row to its occurrence
    onCleanup(() => c.unregister(k, element));
  });

  const itemKey = computed(() => controller().key(item()));
  let state: ReturnType<ReorderableController<T, K>['itemState']> | undefined;
  // O(1) via the shared handle→index map; the row's occurrence, not its key
  const index = computed(() =>
    (state ??= controller().itemState(item, element)).index(),
  );

  const dragRef = draggable<T, DragMeta>({
    data: item,
    meta: () => {
      const c = controller();
      return {
        [NATIVE_LIST_ID]: c.listId,
        [NATIVE_SOURCE]: c,
        [NATIVE_HANDLE]: c.keyForElement(element),
      };
    },
  });

  // Item is ALSO a drop target: onDropTargetChange advances the session pointer (vs. continuous onDrag). No onDrop.
  dropTarget<T, { listId: symbol; index: number }>({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accept-all guard; the real gate is canDrop
    accepts: (d): d is T => true,
    data: () => ({ listId: controller().listId, index: index() }),
    canDrop: ({ source }) => canDropOnList(controller(), source),
  });

  const edge = computed(() =>
    indicatorEdge(
      controller().nativeInsert(),
      index(),
      controller().items().length - 1,
      controller().axis === 'x' ? 'x' : 'y',
    ),
  );

  const envInjector = inject(EnvironmentInjector);
  const appRef = inject(ApplicationRef);
  const ref = createComponent(DropIndicator, {
    environmentInjector: envInjector,
    bindings: [inputBinding('edge', edge)],
  });
  element.appendChild(ref.location.nativeElement);
  appRef.attachView(ref.hostView);
  inject(DestroyRef).onDestroy(() => {
    appRef.detachView(ref.hostView);
    ref.destroy();
  });

  const { onKeydown, tabIndex } = keyboardReorder(
    controller,
    item,
    index,
    element,
    inject(Injector),
  );

  // FLIP-on-commit
  const anim = controller().animation;
  if (anim) {
    const active = injectDndActive();
    let prev: { x: number; y: number } | null = null;
    const measure = () => {
      const r = element.getBoundingClientRect();
      return { x: r.left, y: r.top };
    };
    effect(() => {
      if (active()) untracked(() => (prev = measure()));
    });
    afterRenderEffect({
      earlyRead: () => {
        controller().items(); // track reorder → re-measure
        return measure();
      },
      write: (curr) => {
        const c = curr();
        if (prev && (prev.x !== c.x || prev.y !== c.y) && element.animate) {
          element.animate(
            [
              { transform: `translate(${prev.x - c.x}px, ${prev.y - c.y}px)` },
              { transform: 'translate(0, 0)' },
            ],
            { duration: anim.duration, easing: anim.easing },
          );
        }
        prev = c;
      },
    });
  }

  const zero = computed(() => 0);
  return {
    itemKey,
    index,
    isSource: dragRef.dragging,
    transform: zero,
    transformX: zero,
    transformY: zero,
    transformCss: computed(() => ''),
    transitionCss: computed(() => ''),
    tabIndex,
    onKeydown,
  };
}
