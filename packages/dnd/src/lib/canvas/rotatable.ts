import {
  afterNextRender,
  computed,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  runInInjectionContext,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  pointerDrag,
  isServer,
  type PointerDragState,
} from '@mmstack/primitives';

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
  /** Pixels before a rotation starts (vs a click). @default 2 */
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
  if (isServer()) {
    return { rotating: computed(() => false), angle: angle.asReadonly() };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const centerSig = resolveSignal(opts.center);
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;

  let center: Point | null = null;
  let baseAngle = 0;
  let startPointer = 0;
  // disabled at press → the whole gesture stays inert, `rotating` included
  const pressIgnored = signal(false);

  // onChange sees every transition, including a move and release in one
  // frame; it runs untracked, so options and callbacks never subscribe.
  const step = (d: PointerDragState): void => {
    const isDisabled = disabled?.() ?? false;

    if (d.pointerId !== null && center === null && !pressIgnored()) {
      if (isDisabled) {
        pressIgnored.set(true);
        return;
      }
      center = centerSig();
      baseAngle = angle();
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

    if (d.pointerId === null) pressIgnored.set(false);
    if (d.pointerId === null && center !== null) {
      center = null;
      opts.onRotateEnd?.({ angle: angle() });
    }
  };

  const drag = pointerDrag({
    target: host,
    activationThreshold: opts.activationThreshold ?? 2,
    onChange: step,
  });

  const rotating = computed(
    () =>
      drag.unthrottled().active && !pressIgnored() && !(disabled?.() ?? false),
  );

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
