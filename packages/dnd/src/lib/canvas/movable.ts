import { isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  booleanAttribute,
  computed,
  DestroyRef,
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
import { pointerDrag, type PointerDragState } from '@mmstack/primitives';

import { resolveElement, resolveSignal } from '../internal/resolve';
import type { DragHandleLike, Resolvable } from '../internal/types';
import type { Point } from '../sortable/geometry';
import {
  clamp,
  clampPoint,
  gridStep,
  type Box,
  type GridSpec,
} from './geometry';
import type { Guide } from './snap';
import { resolveMove } from './transform';

export type MovableOptions = {
  /** Restrict drag initiation to a handle (defaults to the host element). */
  handle?: Resolvable<DragHandleLike | undefined>;
  /** Snap the position to a grid (held Ctrl bypasses snapping). */
  grid?: Resolvable<GridSpec | undefined>;
  /** Clamp within these bounds (uses `size` for containment when provided). */
  bounds?: Resolvable<Box | undefined>;
  disabled?: Resolvable<boolean>;
  /** Pixels before a drag starts (vs a click). @default 3 */
  activationThreshold?: number;
  /**
   * Supplies the base position captured at gesture start (defaults to the bound
   * signal's current value). Use when the *rendered* position differs from the
   * source signal — e.g. derived-position rendering, where the drag should
   * begin at the rendered spot. Lets reflow work with **no user effect**.
   */
  from?: () => Point;
  /** Element size — enables alignment guides and full bounds containment. */
  size?: Resolvable<{ width: number; height: number } | undefined>;
  /** Shift locks movement to the dominant axis (Figma-style). @default true */
  lockAxisOnShift?: boolean;
  /** Other position signals to move together (e.g. the rest of a selection). */
  group?: () => readonly WritableSignal<Point>[];
  /**
   * Sibling boxes to snap edges/centers against (alignment guides; needs
   * `size`). Read ONCE at gesture start — a mid-drag layout change (e.g. a
   * group move writing sibling positions) can't feed back into the collision.
   */
  snapTargets?: Resolvable<readonly Box[] | undefined>;
  /** Alignment snap distance. @default 6 */
  snapThreshold?: number;
  /** Also snap to the `bounds` edges. */
  snapToCanvas?: boolean;
  /** Auto-scroll this container while dragging near its edges. */
  scroll?: Resolvable<HTMLElement | ElementRef<HTMLElement> | undefined>;
  /** Distance from the edge that triggers auto-scroll. @default 32 */
  scrollMargin?: number;
  /** Auto-scroll px/frame. @default 12 */
  scrollSpeed?: number;
  /** Arrow-key nudging when the host is focused (Ctrl/Cmd = large step). */
  keyboard?: boolean | { step?: number; largeStep?: number };
  onMoveStart?: (e: { position: Point }) => void;
  onMove?: (e: { position: Point; delta: Point }) => void;
  onMoveEnd?: (e: { position: Point }) => void;
};

export type MovableRef = {
  moving: Signal<boolean>;
  position: Signal<Point>;
  /** Active alignment guides (snaplines) during a drag — render these. */
  guides: Signal<readonly Guide[]>;
};

function containPoint(
  p: Point,
  size: { width: number; height: number } | undefined,
  bounds: Box,
): Point {
  if (!size) return clampPoint(p, bounds);
  return {
    x: clamp(p.x, bounds.x, bounds.x + bounds.width - size.width),
    y: clamp(p.y, bounds.y, bounds.y + bounds.height - size.height),
  };
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The à-la-carte free-position drag: makes the host element draggable on a
 * canvas via Pointer Events, writing the next position into a signal YOU own
 * (axis-locked on Shift, snapped to grid and/or sibling edges, clamped to
 * bounds; group move, edge auto-scroll and keyboard nudging included). For a
 * whole surface with selection/marquee/resize chrome, reach for {@link canvas}
 * instead — this is the single-element building block. Injection context only.
 */
export function movable(
  position: WritableSignal<Point>,
  opts: MovableOptions = {},
): MovableRef {
  const guides = signal<readonly Guide[]>([]);

  if (isPlatformServer(inject(PLATFORM_ID))) {
    return {
      moving: computed(() => false),
      position: position.asReadonly(),
      guides: guides.asReadonly(),
    };
  }

  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const destroyRef = inject(DestroyRef);
  const handleSig = opts.handle ? resolveSignal(opts.handle) : undefined;
  const grid = opts.grid ? resolveSignal(opts.grid) : undefined;
  const bounds = opts.bounds ? resolveSignal(opts.bounds) : undefined;
  const disabled = opts.disabled ? resolveSignal(opts.disabled) : undefined;
  const sizeSig = opts.size ? resolveSignal(opts.size) : undefined;
  const snapTargets = opts.snapTargets
    ? resolveSignal(opts.snapTargets)
    : undefined;
  const scrollSig = opts.scroll ? resolveSignal(opts.scroll) : undefined;
  const lockAxisOnShift = opts.lockAxisOnShift ?? true;
  const snapThreshold = opts.snapThreshold ?? 6;
  const scrollMargin = opts.scrollMargin ?? 32;
  const scrollSpeed = opts.scrollSpeed ?? 12;

  const target = handleSig
    ? computed(() => resolveElement(handleSig()) ?? null)
    : host;

  const drag = pointerDrag({
    target,
    activationThreshold: opts.activationThreshold ?? 3,
  });

  const moving = computed(
    () => drag.unthrottled().active && !(disabled?.() ?? false),
  );

  const scrollEl = (): HTMLElement | null => {
    const v = scrollSig?.();
    if (!v) return null;
    return v instanceof ElementRef ? v.nativeElement : v;
  };

  let base: Point | null = null;
  let baseScroll: Point | null = null;
  let baseTargets: readonly Box[] | undefined;
  let groupBases: Map<WritableSignal<Point>, Point> | null = null;
  let pressIgnored = false; // disabled at press → the whole gesture stays inert
  let raf = 0;

  const computeNext = (d: PointerDragState): Point => {
    if (!base) return untracked(position);
    let dx = d.delta.x;
    let dy = d.delta.y;
    // Options are read UNTRACKED: this effect must depend only on the gesture.
    const sc = untracked(scrollEl);
    if (sc && baseScroll) {
      dx += sc.scrollLeft - baseScroll.x;
      dy += sc.scrollTop - baseScroll.y;
    }

    const size = untracked(() => sizeSig?.()) ?? { width: 0, height: 0 };
    const resolved = resolveMove(
      { x: base.x, y: base.y, width: size.width, height: size.height },
      { x: dx, y: dy },
      {
        grid: untracked(() => grid?.()),
        bounds: untracked(() => bounds?.()),
        // drag-start snapshot: a group move writing sibling positions that
        // `snapTargets` derives from can't loop back into this frame
        targets: size.width || size.height ? baseTargets : undefined,
        threshold: snapThreshold,
        snapToCanvas: opts.snapToCanvas,
        lockAxis: lockAxisOnShift && d.modifiers.shift,
        bypassSnap: d.modifiers.ctrl,
      },
    );
    guides.set(resolved.guides);
    return { x: resolved.box.x, y: resolved.box.y };
  };

  const apply = (d: PointerDragState): void => {
    if (!base) return;
    const next = computeNext(d);
    const applied = { x: next.x - base.x, y: next.y - base.y };
    position.set(next);

    if (groupBases) {
      const b = untracked(() => bounds?.());
      for (const [sig, mb] of groupBases) {
        let mp: Point = { x: mb.x + applied.x, y: mb.y + applied.y };
        if (b) mp = containPoint(mp, undefined, b);
        sig.set(mp);
      }
    }
    opts.onMove?.({ position: next, delta: d.delta });
    maybeAutoScroll(d);
  };

  const maybeAutoScroll = (d: PointerDragState): void => {
    const sc = scrollEl();
    if (!sc || !d.active) return;
    const r = sc.getBoundingClientRect();
    const nearEdge =
      d.current.x < r.left + scrollMargin ||
      d.current.x > r.right - scrollMargin ||
      d.current.y < r.top + scrollMargin ||
      d.current.y > r.bottom - scrollMargin;
    if (nearEdge && raf === 0) raf = requestAnimationFrame(tickScroll);
  };

  const tickScroll = (): void => {
    raf = 0;
    const sc = scrollEl();
    if (base === null || !sc) return;
    const d = drag.unthrottled();
    if (!d.active) return;
    const r = sc.getBoundingClientRect();
    let vx = 0;
    let vy = 0;
    if (d.current.x < r.left + scrollMargin) vx = -scrollSpeed;
    else if (d.current.x > r.right - scrollMargin) vx = scrollSpeed;
    if (d.current.y < r.top + scrollMargin) vy = -scrollSpeed;
    else if (d.current.y > r.bottom - scrollMargin) vy = scrollSpeed;
    if (vx || vy) {
      sc.scrollLeft += vx;
      sc.scrollTop += vy;
      apply(d); // recompute against the new scroll offset
      raf = requestAnimationFrame(tickScroll);
    }
  };

  const stopScroll = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // EDGE: translate the pointer gesture into position writes (unthrottled view
  // so the element follows the cursor every frame). Reads `position` untracked.
  effect(() => {
    const d = drag.unthrottled();
    const isDisabled = untracked(() => disabled?.() ?? false);

    if (d.pointerId !== null && base === null && !pressIgnored) {
      if (isDisabled) {
        pressIgnored = true;
        return;
      }
      base = opts.from ? untracked(opts.from) : untracked(position);
      const sc = untracked(scrollEl);
      baseScroll = sc ? { x: sc.scrollLeft, y: sc.scrollTop } : null;
      baseTargets = untracked(() => snapTargets?.());
      groupBases = opts.group
        ? new Map(untracked(opts.group).map((s) => [s, untracked(s)]))
        : null;
      opts.onMoveStart?.({ position: base });
    }

    if (d.active && base && !isDisabled) apply(d);

    if (d.pointerId === null) pressIgnored = false;
    if (d.pointerId === null && base !== null) {
      base = null;
      baseScroll = null;
      baseTargets = undefined;
      groupBases = null;
      stopScroll();
      guides.set([]);
      opts.onMoveEnd?.({ position: untracked(position) });
    }
  });

  destroyRef.onDestroy(stopScroll);

  // Keyboard nudging when the host is focused.
  if (opts.keyboard) {
    const kb = typeof opts.keyboard === 'object' ? opts.keyboard : {};
    const controller = new AbortController();
    host.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (untracked(() => disabled?.() ?? false)) return;
        const dir = ARROWS[e.key];
        if (!dir) return;
        e.preventDefault();
        const step = kb.step ?? gridStep(untracked(() => grid?.()));
        const large = kb.largeStep ?? step * 10;
        const amount = e.ctrlKey || e.metaKey ? large : step;
        const move = { x: dir[0] * amount, y: dir[1] * amount };
        const b = untracked(() => bounds?.());
        const size = untracked(() => sizeSig?.());

        const cur = untracked(position);
        let next: Point = { x: cur.x + move.x, y: cur.y + move.y };
        if (b) next = containPoint(next, size, b);
        position.set(next);

        // nudge the rest of the selection by the same delta (group keyboard move)
        if (opts.group) {
          const applied = { x: next.x - cur.x, y: next.y - cur.y };
          for (const sig of untracked(opts.group)) {
            const mc = untracked(sig);
            let mp: Point = { x: mc.x + applied.x, y: mc.y + applied.y };
            if (b) mp = containPoint(mp, undefined, b);
            sig.set(mp);
          }
        }

        opts.onMove?.({ position: next, delta: move });
      },
      { signal: controller.signal },
    );
    destroyRef.onDestroy(() => controller.abort());
  }

  return {
    moving,
    position: position.asReadonly(),
    guides: guides.asReadonly(),
  };
}

/**
 * Thin directive wrapper. Bind your own `WritableSignal<Point>`:
 * `<div [mmMovable]="pos" [grid]="{ size: 8 }" [snapTargets]="siblings()">`.
 */
@Directive({
  selector: '[mmMovable]',
  exportAs: 'mmMovable',
})
export class Movable {
  readonly position = input.required<WritableSignal<Point>>({
    alias: 'mmMovable',
  });
  readonly grid = input<GridSpec | undefined>(undefined);
  readonly bounds = input<Box | undefined>(undefined);
  readonly size = input<{ width: number; height: number } | undefined>(
    undefined,
  );
  readonly snapTargets = input<readonly Box[] | undefined>(undefined);
  readonly snapToCanvas = input(false, { transform: booleanAttribute });
  readonly group = input<readonly WritableSignal<Point>[] | undefined>(
    undefined,
  );
  readonly scroll = input<HTMLElement | ElementRef<HTMLElement> | undefined>(
    undefined,
  );
  readonly keyboard = input(false, { transform: booleanAttribute });
  readonly moveDisabled = input(false, { transform: booleanAttribute });

  private readonly injector = inject(Injector);
  private readonly _ref = signal<MovableRef | undefined>(undefined);

  readonly moving = computed(() => this._ref()?.moving() ?? false);
  readonly guides = computed<readonly Guide[]>(
    () => this._ref()?.guides() ?? [],
  );

  constructor() {
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          movable(this.position(), {
            grid: this.grid,
            bounds: this.bounds,
            size: this.size,
            snapTargets: this.snapTargets,
            snapToCanvas: this.snapToCanvas(),
            group: () => this.group() ?? [],
            scroll: this.scroll,
            keyboard: this.keyboard(),
            disabled: this.moveDisabled,
          }),
        ),
      );
    });
  }
}
