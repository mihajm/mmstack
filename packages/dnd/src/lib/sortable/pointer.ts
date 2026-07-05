import {
  computed,
  DestroyRef,
  inject,
  Injector,
  untracked,
} from '@angular/core';
import { nestedEffect } from '@mmstack/primitives';

import { driveGesture } from '../internal/gesture';
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
  // Resolved once; the driver's live `pointer` is what the plugin chases each frame.
  const getAutoScroll = resolveAutoScroll(inject(Injector));
  let stopScroll: (() => void) | null = null;

  const startAutoScroll = (): void => {
    const c = untracked(controller);
    if (!c.autoScroll || stopScroll) return;
    const plugin = getAutoScroll(); // warns once if opted-in but no plugin
    if (!plugin) return;
    stopScroll = plugin({
      element,
      axis: c.axis === 'x' ? 'x' : 'y',
      pointer: () => driver.pointer,
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

  const driver = driveGesture(
    element,
    {
      begin: (origin, start) => {
        const c = untracked(controller);
        if (!origin || untracked(c.activeKey) !== null) return false;
        const itemEl = origin.closest(ITEM_SELECTOR) as HTMLElement | null;
        const k = itemEl ? c.keyForElement(itemEl) : undefined;
        if (k === undefined) return false;
        c.beginGesture(k, start);
        return true;
      },
      move: (p) => untracked(controller).move(p),
      // Escape / pointercancel / teardown abort the drag; only a real release commits.
      end: () => untracked(controller).end(),
      cancel: () => untracked(controller).cancel(),
      onDragStart: startAutoScroll,
      onDragEnd: stopAutoScroll,
    },
    {
      handleSelector: HANDLE_SELECTOR,
      activationThreshold: untracked(controller).activationThreshold,
      // nested list claims the pointerdown so the outer one doesn't also start a drag (innermost wins).
      stopPropagation: true,
    },
  );
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
    transformX: computed(() => get().transformX()),
    transformY: computed(() => get().transformY()),
    transformCss: computed(() => get().transformCss()),
    transitionCss: computed(() => get().transitionCss()),
    tabIndex,
    onKeydown,
  };
}
