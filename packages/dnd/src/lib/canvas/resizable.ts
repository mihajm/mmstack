import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { pointerDrag } from '@mmstack/primitives';

import { resolveSignal } from '../internal/resolve';
import type { Resolvable } from '../internal/types';
import type { Box, GridSpec } from './geometry';
import type { Guide } from './snap';
import { resolveResize, type ResizeDirection } from './transform';

export type ResizeHandleOptions = {
  grid?: Resolvable<GridSpec | undefined>;
  min?: { width?: number; height?: number };
  max?: { width?: number; height?: number };
  bounds?: Resolvable<Box | undefined>;
  disabled?: Resolvable<boolean>;
  activationThreshold?: number;
  /**
   * Snap resized edges to sibling boxes (alignment guides; Ctrl bypasses).
   * Read ONCE at gesture start so mid-resize layout can't feed back.
   */
  snapTargets?: Resolvable<readonly Box[] | undefined>;
  /** Alignment snap distance. @default 6 */
  snapThreshold?: number;
  /** Also snap edges to the `bounds`. */
  snapToCanvas?: boolean;
  onResizeStart?: (e: { box: Box }) => void;
  onResize?: (e: { box: Box }) => void;
  onResizeEnd?: (e: { box: Box }) => void;
};

export type ResizeHandleRef = {
  resizing: Signal<boolean>;
  box: Signal<Box>;
  /** Active alignment guides (snaplines) during a resize. */
  guides: Signal<readonly Guide[]>;
};

/**
 * The à-la-carte resize: drag the host **handle** element to resize a box
 * signal YOU own. One handle = one gesture host; render up to eight handles,
 * each with its own `resizeHandle(box, direction)`. Shift holds the aspect
 * ratio, Alt resizes from the center, Ctrl bypasses snapping. For selection-
 * chrome handles that act on the selected item, use {@link canvas} instead.
 * Injection context only.
 */
export function resizeHandle(
  box: WritableSignal<Box>,
  direction: ResizeDirection,
  opts: ResizeHandleOptions = {},
): ResizeHandleRef {
  const guides = signal<readonly Guide[]>([]);

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      resizing: computed(() => false),
      box: box.asReadonly(),
      guides: guides.asReadonly(),
    };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const grid = opts.grid ? resolveSignal(opts.grid) : undefined;
  const bounds = opts.bounds ? resolveSignal(opts.bounds) : undefined;
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
  const snapTargets = opts.snapTargets
    ? resolveSignal(opts.snapTargets)
    : undefined;
  const snapThreshold = opts.snapThreshold ?? 6;

  const drag = pointerDrag({
    target: host,
    activationThreshold: opts.activationThreshold ?? 2,
  });

  const resizing = computed(
    () => drag.unthrottled().active && !(disabled?.() ?? false),
  );

  let base: Box | null = null;
  let baseTargets: readonly Box[] | undefined;
  let pressIgnored = false;

  // Options read UNTRACKED — this effect depends only on the gesture.
  effect(() => {
    const d = drag.unthrottled();
    const isDisabled = untracked(() => disabled?.() ?? false);

    if (d.pointerId !== null && base === null && !pressIgnored) {
      if (isDisabled) {
        pressIgnored = true;
        return;
      }
      base = untracked(box);
      baseTargets = untracked(() => snapTargets?.());
      opts.onResizeStart?.({ box: base });
    }

    if (d.active && base && !isDisabled) {
      const resolved = resolveResize(base, direction, d.delta, {
        grid: untracked(() => grid?.()),
        min: opts.min,
        max: opts.max,
        bounds: untracked(() => bounds?.()),
        targets: baseTargets,
        threshold: snapThreshold,
        snapToCanvas: opts.snapToCanvas,
        aspect: d.modifiers.shift
          ? base.height > 0
            ? base.width / base.height
            : undefined
          : undefined,
        fromCenter: d.modifiers.alt,
        bypassSnap: d.modifiers.ctrl,
      });
      guides.set(resolved.guides);
      box.set(resolved.box);
      opts.onResize?.({ box: resolved.box });
    }

    if (d.pointerId === null) pressIgnored = false;
    if (d.pointerId === null && base !== null) {
      base = null;
      baseTargets = undefined;
      guides.set([]);
      opts.onResizeEnd?.({ box: untracked(box) });
    }
  });

  return { resizing, box: box.asReadonly(), guides: guides.asReadonly() };
}

/**
 * Thin directive wrapper for a single handle element:
 * `<div class="handle se" [mmResizeHandle]="box" direction="se">`.
 */
@Directive({
  selector: '[mmResizeHandle]',
  exportAs: 'mmResizeHandle',
})
export class ResizeHandle {
  readonly box = input.required<WritableSignal<Box>>({
    alias: 'mmResizeHandle',
  });
  readonly direction = input.required<ResizeDirection>();
  readonly grid = input<GridSpec | undefined>(undefined);
  readonly min = input<{ width?: number; height?: number } | undefined>(
    undefined,
  );
  readonly max = input<{ width?: number; height?: number } | undefined>(
    undefined,
  );
  readonly bounds = input<Box | undefined>(undefined);
  readonly snapTargets = input<readonly Box[] | undefined>(undefined);
  readonly snapToCanvas = input(false, { transform: booleanAttribute });

  private readonly injector = inject(Injector);
  private readonly _ref = signal<ResizeHandleRef | undefined>(undefined);

  readonly resizing = computed(() => this._ref()?.resizing() ?? false);
  readonly guides = computed<readonly Guide[]>(
    () => this._ref()?.guides() ?? [],
  );

  constructor() {
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          resizeHandle(this.box(), this.direction(), {
            grid: this.grid,
            min: this.min(),
            max: this.max(),
            bounds: this.bounds,
            snapTargets: this.snapTargets,
            snapToCanvas: this.snapToCanvas(),
          }),
        ),
      );
    });
  }
}
