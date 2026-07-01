import {
  afterNextRender,
  computed,
  type Injector,
  runInInjectionContext,
  type Signal,
} from '@angular/core';

import { injectAnnounce } from '../a11y/a11y';
import type { ReorderableController } from './types';

/**
 * The keyboard-reorder behaviour shared by both engines: focus an item, arrow
 * keys move it one step (axis-aware), jump-modifier + arrow moves it to the
 * start/end. Each move commits via `moveItem`, is announced, and keeps focus.
 *
 * A list may replace the built-in arrow/jump logic with its own
 * {@link ReorderableController.onKeyboardKeydown} — that handler receives the
 * event plus an `api` whose `move(to)` reuses this same commit/announce/focus
 * plumbing. Returns the `keydown` handler + a `tabIndex` signal (`0` when keyboard
 * is on, else `null`).
 */
export function keyboardReorder<T, K>(
  controller: () => ReorderableController<T, K>,
  item: () => T,
  index: () => number,
  element: HTMLElement,
  injector: Injector,
): { onKeydown: (event: KeyboardEvent) => void; tabIndex: Signal<number | null> } {
  // Needs the stored injector: injectAnnounce() uses inject(), but this runs from keydown (no injection context).
  let announce: ((message: string) => void) | null | undefined;
  const getAnnounce = (): ((message: string) => void) | null => {
    if (announce === undefined)
      announce = controller().announceMove
        ? runInInjectionContext(injector, () => injectAnnounce())
        : null;
    return announce;
  };

  // Re-focus after DOM settles: Angular reconciliation detaches/re-inserts the node on a backward move → blur.
  // scrollIntoView because focus() only scrolls when focus MOVES, so retain-focus could slide it under a scroller.
  const applyMove = (from: number, rawTo: number): void => {
    const c = controller();
    const total = c.items().length; // read fresh: a custom handler may move() twice
    const to = Math.min(Math.max(rawTo, 0), total - 1);
    if (from < 0 || to === from) return;
    c.moveItem(from, to);
    const message = c.announceMove;
    if (message) getAnnounce()?.(message({ item: item(), from, to, total }));
    afterNextRender(
      () => {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
      { injector },
    );
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const c = controller();
    if (!c.keyboard) return;
    const from = index();
    if (from < 0) return;
    const total = c.items().length;

    // Custom handler fully owns keydown (including preventDefault); `api.move` reuses our commit/announce/focus.
    if (c.onKeyboardKeydown) {
      c.onKeyboardKeydown(event, {
        item: item(),
        index: from,
        total,
        axis: c.axis,
        jump: c.jumpModifier(event),
        move: (to) => applyMove(from, to),
      });
      return;
    }

    const horizontal = c.axis === 'x';
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== fwd) return;

    const dir = event.key === fwd ? 1 : -1;
    const to = c.jumpModifier(event)
      ? dir > 0
        ? total - 1
        : 0
      : from + dir;
    if (Math.min(Math.max(to, 0), total - 1) === from) return; // already at the edge

    event.preventDefault();
    applyMove(from, to);
  };

  return {
    onKeydown,
    tabIndex: computed(() => (controller().keyboard ? 0 : null)),
  };
}
