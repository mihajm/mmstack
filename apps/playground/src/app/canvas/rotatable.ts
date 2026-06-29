import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
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

import type { Resolvable } from '@mmstack/dnd';
import { resolveSignal } from '@mmstack/dnd';
import type { Point } from './geometry';

export type RotatableOptions = {
  /** Rotation pivot in client coordinates (e.g. the rotated element's center). */
  center: Resolvable<Point>;
  /** Snap increment in degrees. Applied while Shift is held, or always with `snapAlways`. */
  snap?: number;
  snapAlways?: boolean;
  disabled?: Resolvable<boolean>;
  activationThreshold?: number;
  onRotateStart?: (e: { angle: number }) => void;
  onRotate?: (e: { angle: number }) => void;
  onRotateEnd?: (e: { angle: number }) => void;
};

export type RotatableRef = {
  rotating: Signal<boolean>;
  /** Current angle in degrees, normalized to [0, 360). */
  angle: Signal<number>;
};

const DEG = 180 / Math.PI;

function angleOf(p: Point, center: Point): number {
  return Math.atan2(p.y - center.y, p.x - center.x) * DEG;
}

function normalize(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Rotates `angle` (degrees) by dragging the host **rotate handle** around a
 * pivot. Shift (or `snapAlways`) snaps to `snap` increments. You own `angle`;
 * apply it via `transform: rotate(...)` (origin defaults to the element center).
 */
export function rotatable(
  angle: WritableSignal<number>,
  opts: RotatableOptions,
): RotatableRef {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    return { rotating: computed(() => false), angle: angle.asReadonly() };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const centerSig = resolveSignal(opts.center);
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;

  const drag = pointerDrag({
    target: host,
    activationThreshold: opts.activationThreshold ?? 2,
  });

  const rotating = computed(
    () => drag.unthrottled().active && !(disabled?.() ?? false),
  );

  let center: Point | null = null;
  let baseAngle = 0;
  let startPointer = 0;

  effect(() => {
    const d = drag.unthrottled();
    const isDisabled = untracked(() => disabled?.() ?? false);

    if (d.pointerId !== null && center === null && !isDisabled) {
      center = untracked(() => centerSig());
      baseAngle = untracked(angle);
      startPointer = angleOf(d.start, center);
      opts.onRotateStart?.({ angle: baseAngle });
    }

    if (d.active && center && !isDisabled) {
      let next = baseAngle + (angleOf(d.current, center) - startPointer);
      if (opts.snap && (opts.snapAlways || d.modifiers.shift)) {
        next = Math.round(next / opts.snap) * opts.snap;
      }
      next = normalize(next);
      angle.set(next);
      opts.onRotate?.({ angle: next });
    }

    if (d.pointerId === null && center !== null) {
      center = null;
      opts.onRotateEnd?.({ angle: untracked(angle) });
    }
  });

  return { rotating, angle: angle.asReadonly() };
}

/**
 * Thin directive wrapper for a rotate handle:
 * `<div [mmRotateHandle]="angle" [center]="centerFn" [snap]="15">`.
 */
@Directive({
  selector: '[mmRotateHandle]',
  exportAs: 'mmRotateHandle',
})
export class RotateHandle {
  readonly angle = input.required<WritableSignal<number>>({
    alias: 'mmRotateHandle',
  });
  readonly center = input.required<Resolvable<Point>>();
  readonly snap = input<number | undefined>(undefined);
  readonly snapAlways = input(false);
  readonly rotateDisabled = input(false);

  private readonly injector = inject(Injector);
  private readonly _ref = signal<RotatableRef | undefined>(undefined);

  readonly rotating = computed(() => this._ref()?.rotating() ?? false);

  constructor() {
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          rotatable(this.angle(), {
            center: this.center(),
            snap: this.snap(),
            snapAlways: this.snapAlways(),
            disabled: this.rotateDisabled,
          }),
        ),
      );
    });
  }
}
