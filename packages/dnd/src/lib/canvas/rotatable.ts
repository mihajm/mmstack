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

import { resolveSignal } from '../internal/resolve';
import type { Resolvable } from '../internal/types';
import type { Point } from '../sortable/geometry';
import { angleOf, resolveRotate } from './transform';

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

/**
 * The à-la-carte rotate: drag the host **rotate handle** around a pivot,
 * writing degrees into a signal YOU own. Shift (or `snapAlways`) snaps to
 * `snap` increments. Apply via `transform: rotate(...)` (origin defaults to
 * the element center). Injection context only.
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
  let pressIgnored = false;
  let baseAngle = 0;
  let startPointer = 0;

  effect(() => {
    const d = drag.unthrottled();
    const isDisabled = untracked(() => disabled?.() ?? false);

    if (d.pointerId !== null && center === null && !pressIgnored) {
      if (isDisabled) {
        pressIgnored = true;
        return;
      }
      center = untracked(() => centerSig());
      baseAngle = untracked(angle);
      startPointer = angleOf(d.start, center);
      opts.onRotateStart?.({ angle: baseAngle });
    }

    if (d.active && center && !isDisabled) {
      const next = resolveRotate(baseAngle, startPointer, d.current, center, {
        snap: opts.snap,
        snapActive: opts.snapAlways || d.modifiers.shift,
      });
      angle.set(next);
      opts.onRotate?.({ angle: next });
    }

    if (d.pointerId === null) pressIgnored = false;
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
