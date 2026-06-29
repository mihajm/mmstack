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

import type { DragHandleLike, Resolvable } from '@mmstack/dnd';
import { resolveElement, resolveSignal } from '@mmstack/dnd';
import { snapToTargets, type Guide } from './alignment';
import {
  clamp,
  clampPoint,
  snapToGrid,
  type Box,
  type GridSpec,
  type Point,
} from './geometry';

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
   * source signal — e.g. grid reflow, where the cell renders from a derived
   * `cellPx` but the drag should begin there. Lets reflow work with **no user
   * effect** (just `onMove`).
   */
  from?: () => Point;
  /** Element size — enables alignment guides and full bounds containment. */
  size?: Resolvable<{ width: number; height: number } | undefined>;
  /** Shift locks movement to the dominant axis (Figma-style). @default true */
  lockAxisOnShift?: boolean;
  /** Other position signals to move together (e.g. the rest of a selection). */
  group?: () => readonly WritableSignal<Point>[];
  /** Sibling boxes to snap edges/centers against (alignment guides; needs `size`). */
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

function gridStep(g: GridSpec | undefined): number {
  if (!g) return 1;
  return typeof g.size === 'number' ? g.size : g.size.x;
}

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
 * Makes the host element freely draggable on a canvas via Pointer Events. You
 * own `position`; the gesture writes the next position (axis-locked on Shift,
 * snapped to grid and/or to sibling edges, clamped to bounds). Supports group
 * move, edge auto-scroll, and keyboard nudging — a Figma/Squarespace-grade move.
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
  let groupBases: Map<WritableSignal<Point>, Point> | null = null;
  let raf = 0;

  const computeNext = (d: PointerDragState): Point => {
    if (!base) return untracked(position);
    let dx = d.delta.x;
    let dy = d.delta.y;
    if (lockAxisOnShift && d.modifiers.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    // Options are read UNTRACKED: this effect must depend only on the gesture.
    // (Group move writes sibling positions, which `snapTargets` also reads —
    // tracking them here would make the effect mutate a dependency = infinite loop.)
    const sc = untracked(scrollEl);
    if (sc && baseScroll) {
      dx += sc.scrollLeft - baseScroll.x;
      dy += sc.scrollTop - baseScroll.y;
    }

    let next: Point = { x: base.x + dx, y: base.y + dy };

    const g = untracked(() => grid?.());
    if (g && !d.modifiers.ctrl) next = snapToGrid(next, g);

    const size = untracked(() => sizeSig?.());
    const targets = untracked(() => snapTargets?.());
    const b = untracked(() => bounds?.());
    if (size && targets?.length && !d.modifiers.ctrl) {
      const res = snapToTargets(
        { x: next.x, y: next.y, width: size.width, height: size.height },
        targets,
        snapThreshold,
        opts.snapToCanvas ? b : undefined,
      );
      next = { x: res.box.x, y: res.box.y };
      guides.set(res.guides);
    } else {
      guides.set([]);
    }

    if (b) next = containPoint(next, size, b);
    return next;
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

    if (d.pointerId !== null && base === null && !isDisabled) {
      base = opts.from ? untracked(opts.from) : untracked(position);
      const sc = untracked(scrollEl);
      baseScroll = sc ? { x: sc.scrollLeft, y: sc.scrollTop } : null;
      groupBases = opts.group
        ? new Map(untracked(opts.group).map((s) => [s, untracked(s)]))
        : null;
      opts.onMoveStart?.({ position: base });
    }

    if (d.active && base && !isDisabled) apply(d);

    if (d.pointerId === null && base !== null) {
      base = null;
      baseScroll = null;
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
