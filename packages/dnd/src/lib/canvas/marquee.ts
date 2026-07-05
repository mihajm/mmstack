import { isPlatformServer } from '@angular/common';
import {
  computed,
  ElementRef,
  inject,
  linkedSignal,
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
 * The à-la-carte rubber-band (box) selection over the host element. Pure
 * derivation off the pointer gesture — **no effects**. `items` boxes are in
 * host-local coordinates; the rectangle is projected into the same space via
 * the host's bounding rect. The {@link canvas} controller has its own marquee
 * with press arbitration; this is the standalone building block. Injection
 * context only.
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

  // the host origin, measured ONCE per gesture (keyed on the pointer id) —
  // no layout read per pointer frame
  const origin = linkedSignal<number | null, { left: number; top: number }>({
    source: () => drag.unthrottled().pointerId,
    computation: (id, prev) => {
      if (id === null) return { left: 0, top: 0 };
      if (prev && prev.source === id) return prev.value;
      const r = host.getBoundingClientRect();
      return { left: r.left, top: r.top };
    },
  });

  const rect = computed<Box | null>(() => {
    const d = drag.unthrottled();
    if (!d.active) return null;
    const o = origin();
    const a = { x: d.start.x - o.left, y: d.start.y - o.top };
    const b = { x: d.current.x - o.left, y: d.current.y - o.top };
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
