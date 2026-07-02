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
  signal,
  untracked,
} from '@angular/core';
import { nestedEffect } from '@mmstack/primitives';

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
import { type Axis, insertIndexFromCenters } from './geometry';
import { keyboardReorder } from './keyboard';
import type { ReorderableController, ReorderableItemBinding } from './types';

/** Symbols carried on a native sortable drag: its source list id + a ref to the source controller. */
const NATIVE_LIST_ID = Symbol('@mmstack/dnd:reorderable-list');
const NATIVE_SOURCE = Symbol('@mmstack/dnd:reorderable-source');

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
  // Re-measured post-layout on ANY source change (a same-length reorder mid-drag — e.g. a
  // concurrent keyboard move — shifts the rects just like an insert/removal does).
  const centers = signal<readonly number[]>([]);
  afterRenderEffect({
    earlyRead: () => {
      if (!active()) return null;
      const c = controller();
      void c.items();
      return c.measure().centers;
    },
    write: (measured) => {
      const m = measured();
      if (m) centers.set(m);
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
          axis: c.axis,
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
    const main = (controller().axis === 'y' ? p.y : p.x) + scrollDelta();
    return insertIndexFromCenters(centers(), main);
  });
  controller().setNativeInsert(activeInsert);

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
      const src = (meta as Record<symbol, unknown>)[NATIVE_SOURCE] as
        | ReorderableController<T, K>
        | undefined;
      if (!src) {
        c.insertForeign(data, to); // foreign payload → map + insert
      } else if (src.listId === c.listId) {
        const from = c.indexMap().get(c.key(data)) ?? -1;
        if (from < 0) return;
        c.moveItem(from, from < to ? to - 1 : to); // insert slot → final index
      } else {
        c.insertAt(data, to);
        src.takeOut(data, to);
      }
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
    const k = c.key(item());
    c.register(k, element);
    onCleanup(() => c.unregister(k, element));
  });

  const itemKey = computed(() => controller().key(item()));
  const index = computed(() => {
    const c = controller();
    return c.indexMap().get(c.key(item())) ?? -1; // O(1), shared map (not per-item findIndex)
  });

  const dragRef = draggable<T, DragMeta>({
    data: item,
    meta: () => {
      const c = controller();
      return { [NATIVE_LIST_ID]: c.listId, [NATIVE_SOURCE]: c };
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
      controller().axis,
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

  // FLIP-on-commit: glide from old box to new after a reorder (items don't move DURING a native drag).
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

  return {
    itemKey,
    index,
    isSource: dragRef.dragging,
    transform: computed(() => 0),
    transformCss: computed(() => ''),
    transitionCss: computed(() => ''),
    tabIndex,
    onKeydown,
  };
}
