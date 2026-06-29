import { isPlatformServer } from '@angular/common';
import {
  computed,
  ElementRef,
  inject,
  PLATFORM_ID,
  type Signal,
} from '@angular/core';
import { pointerDrag } from '@mmstack/primitives';

import { intersects, normalizeRect, type Box } from './geometry';

export type MarqueeItem<T> = { id: unknown; box: Box; value: T };

export type MarqueeOptions = {
  activationThreshold?: number;
  /** Mouse buttons that begin a marquee. @default [0] */
  buttons?: number[];
};

export type MarqueeRef<T> = {
  selecting: Signal<boolean>;
  /** Live rubber-band rectangle in host-local coordinates (`null` when idle). */
  rect: Signal<Box | null>;
  /** Values whose box intersects the rectangle. */
  selected: Signal<readonly T[]>;
};

/**
 * Rubber-band (box) selection over a canvas. Pure derivation off the pointer
 * gesture — **no effects**. `items` boxes are in host-local coordinates; the
 * rectangle is projected into the same space via the host's bounding rect.
 */
export function marquee<T>(
  items: Signal<readonly MarqueeItem<T>[]>,
  opts: MarqueeOptions = {},
): MarqueeRef<T> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      selecting: computed(() => false),
      rect: computed(() => null),
      selected: computed(() => []),
    };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const drag = pointerDrag({
    target: host,
    activationThreshold: opts.activationThreshold ?? 4,
    buttons: opts.buttons ?? [0],
  });

  const selecting = computed(() => drag.unthrottled().active);

  const rect = computed<Box | null>(() => {
    const d = drag.unthrottled();
    if (!d.active) return null;
    const origin = host.getBoundingClientRect();
    const a = { x: d.start.x - origin.left, y: d.start.y - origin.top };
    const b = { x: d.current.x - origin.left, y: d.current.y - origin.top };
    return normalizeRect(a, b);
  });

  const selected = computed<readonly T[]>(() => {
    const r = rect();
    if (!r) return [];
    return items()
      .filter((it) => intersects(it.box, r))
      .map((it) => it.value);
  });

  return { selecting, rect, selected };
}
