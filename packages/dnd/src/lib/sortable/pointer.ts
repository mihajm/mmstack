import {
  computed,
  DestroyRef,
  inject,
  Injector,
  untracked,
} from '@angular/core';
import { nestedEffect, pointerDrag } from '@mmstack/primitives';

import { resolveAutoScroll } from '../provide';
import { HANDLE_SELECTOR, ITEM_SELECTOR } from './dom';
import { keyboardReorder } from './keyboard';
import type {
  ReorderableController,
  ReorderableItemBinding,
  ReorderableItemState,
} from './types';

/** Pointer-engine container wiring (the delegated gesture + edge auto-scroll). */
export function connectPointerContainer<T, K = unknown>(
  controller: () => ReorderableController<T, K>,
  element: HTMLElement,
): void {
  const drag = pointerDrag({
    target: element,
    handleSelector: HANDLE_SELECTOR,
    activationThreshold: 5,
    // nested list claims the pointerdown so the outer one doesn't also start a drag (innermost wins).
    stopPropagation: true,
  });

  // Resolved once; the live `pointer` object below is what the plugin chases each frame.
  const getAutoScroll = resolveAutoScroll(inject(Injector));
  const pointer = { x: 0, y: 0 };
  let stopScroll: (() => void) | null = null;

  const startAutoScroll = (): void => {
    const c = untracked(controller);
    if (!c.autoScroll || stopScroll) return;
    const plugin = getAutoScroll(); // warns once if opted-in but no plugin
    if (!plugin) return;
    stopScroll = plugin({
      element,
      axis: c.axis,
      pointer: () => pointer,
      edge: c.autoScroll.edge,
      speed: c.autoScroll.speed,
      edgeProportion: c.autoScroll.edgeProportion,
      maxSpeedAt: c.autoScroll.maxSpeedAt,
      onScroll: (d: number) => c.setScrollDelta(d),
    });
  };

  const stopAutoScroll = (): void => {
    stopScroll?.();
    stopScroll = null;
  };

  controller().setContainer(element); // one-time (matches the native container)
  inject(DestroyRef).onDestroy(() => {
    stopAutoScroll();
    untracked(controller).dispose?.();
  });

  let dragging = false;
  nestedEffect(() => {
    const g = drag.unthrottled();
    const c = controller();
    if (g.active && g.pointerId !== null) {
      pointer.x = g.current.x;
      pointer.y = g.current.y;
      if (!dragging && g.origin && untracked(c.activeKey) === null) {
        const itemEl = g.origin.closest(ITEM_SELECTOR) as HTMLElement | null;
        const k = itemEl ? c.keyForElement(itemEl) : undefined;
        if (k !== undefined) {
          c.beginGesture(k, g.start);
          dragging = true;
          startAutoScroll();
        }
      }
      if (dragging) c.move(g.current);
    } else if (dragging) {
      c.end();
      dragging = false;
      stopAutoScroll();
    }
  });
}

/** Pointer-engine item wiring: registration + FLIP itemState + keyboard reorder. */
export function connectPointerItem<T, K = unknown>(
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

  let inner: ReorderableItemState<K> | undefined;
  const get = () => (inner ??= controller().itemState(item));

  const { onKeydown, tabIndex } = keyboardReorder(
    () => controller(),
    item,
    () => get().index(),
    element,
    inject(Injector),
  );

  return {
    itemKey: computed(() => get().itemKey()),
    index: computed(() => get().index()),
    isSource: computed(() => get().isSource()),
    transform: computed(() => get().transform()),
    transformCss: computed(() => get().transformCss()),
    transitionCss: computed(() => get().transitionCss()),
    tabIndex,
    onKeydown,
  };
}
