import { computed, type Signal } from '@angular/core';
import type { Point } from '../sortable/geometry';
import {
  boxContainsPoint,
  normalizeRect,
  type Box,
  type CanvasFrame,
  type GridSpec,
} from './geometry';
import type { Guide } from './snap';
import {
  resolveMove,
  resolveResize,
  resolveRotate,
  type ResizeDirection,
} from './transform';

/** The pan/zoom placement of canvas space inside the surface element. */
export type CanvasSpaceTransform = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
};

export const IDENTITY_TRANSFORM: CanvasSpaceTransform = {
  x: 0,
  y: 0,
  scale: 1,
};

/**
 * Everything a gesture needs, measured ONCE at pointerdown — the canvas
 * analogue of sortable's `DragGeometry`. Nothing in here is reactive; the
 * per-frame work is pure math against this snapshot, so mid-gesture layout
 * feedback loops (the old group-move ↔ snap-targets hazard) are impossible
 * by construction.
 */
export type CanvasGesture<K> = {
  readonly kind: 'move' | 'resize' | 'rotate' | 'marquee';
  /** Resize only: which handle. */
  readonly direction?: ResizeDirection;
  /** Participating item keys (the selection, or the pressed item). */
  readonly keys: readonly K[];
  /** Participants' frames at gesture start. */
  readonly baseFrames: ReadonlyMap<K, CanvasFrame>;
  /** Union box of the participants at gesture start (canvas space). */
  readonly union: Box;
  /** NON-participant boxes to snap against, measured once (canvas space). */
  readonly snapTargets: readonly Box[];
  /** Candidate drop containers (participants excluded), innermost-wins. */
  readonly containers: readonly { key: K; box: Box }[];
  /** Pointer at gesture start, canvas space. */
  readonly start: Point;
  /** The surface element's viewport origin at gesture start. */
  readonly surfaceOrigin: Point;
  /** Rotate only: pivot (canvas space), base angle, pointer angle at start. */
  readonly pivot?: Point;
  readonly baseAngle?: number;
  readonly startPointerAngle?: number;
};

export type CanvasSessionConfig = {
  readonly grid: () => GridSpec | undefined;
  readonly bounds: () => Box | undefined;
  /** Alignment snapping on/off (targets come from the gesture snapshot). */
  readonly snap: () => boolean;
  /** Snap distance in SCREEN px — divided by the space scale before use. */
  readonly snapThreshold: () => number;
  readonly snapToCanvas: () => boolean;
  readonly lockAxisOnShift: () => boolean;
  readonly resizeMin: () => { width?: number; height?: number } | undefined;
  readonly resizeMax: () => { width?: number; height?: number } | undefined;
  readonly rotateSnap: () => number | undefined;
};

export type CanvasSessionInput<K> = {
  /** The active gesture snapshot, or `null` when idle. */
  readonly gesture: Signal<CanvasGesture<K> | null>;
  /** Live pointer, viewport (client) coordinates. */
  readonly pointerX: Signal<number>;
  readonly pointerY: Signal<number>;
  /** Modifier scalars, decomposed so one flip renotifies only its readers. */
  readonly modShift: Signal<boolean>;
  readonly modCtrl: Signal<boolean>;
  readonly modAlt: Signal<boolean>;
  /** Auto-scroll compensation, VIEWPORT px (projected through the space scale here). */
  readonly scrollDeltaX: Signal<number>;
  readonly scrollDeltaY: Signal<number>;
  /** The pan/zoom transform (identity when the canvas isn't zoomable). */
  readonly space?: Signal<CanvasSpaceTransform>;
  readonly config: CanvasSessionConfig;
};

export type CanvasSession<K> = {
  readonly active: Signal<boolean>;
  readonly kind: Signal<CanvasGesture<K>['kind'] | null>;
  /** Live pointer in canvas space (tracks mid-gesture pan/zoom). */
  readonly canvasPointerX: Signal<number>;
  readonly canvasPointerY: Signal<number>;
  /**
   * The moved selection's resolved union origin delta — what every
   * participant adds to its base position. Scalar leaves: a frame that
   * resolves to the same snapped origin doesn't renotify.
   */
  readonly overlayDeltaX: Signal<number>;
  readonly overlayDeltaY: Signal<number>;
  /** Resize: the resolved union box, or `null` outside a resize. */
  readonly resizeBox: Signal<Box | null>;
  /** Rotate: the resolved angle, or `null` outside a rotate. */
  readonly angle: Signal<number | null>;
  /** Marquee: the live rubber-band rect (canvas space), or `null`. */
  readonly marqueeRect: Signal<Box | null>;
  /** Active snaplines (move + resize). Value-stable: renotifies on change only. */
  readonly guides: Signal<readonly Guide[]>;
  /**
   * Move: the innermost accepting container under the pointer, or `null`
   * (the root). An integer-ish scalar leaf — it renotifies on actual
   * reparent-target changes, not per pointer frame.
   */
  readonly hoverContainer: Signal<K | null>;
};

const NO_GUIDES: readonly Guide[] = [];

function guidesEqual(a: readonly Guide[], b: readonly Guide[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ga = a[i];
    const gb = b[i];
    if (
      ga.axis !== gb.axis ||
      ga.position !== gb.position ||
      ga.from !== gb.from ||
      ga.to !== gb.to
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The signals-first heart of the free-form canvas: turns the gesture scalars
 * plus the drag-start snapshot into the resolved overlay (move delta / resize
 * box / angle / marquee rect), the snaplines, and the reparent target — pure
 * derivation, no effects, no DOM.
 *
 * Idle is free: every derivation reads `gesture()` first and bails on `null`,
 * so pointer movement outside a gesture recomputes nothing. Guides are the
 * one place a custom equality is used — the alternative is renotifying the
 * chrome every pointer frame for a visually unchanged set of lines.
 */
export function canvasSession<K>(
  input: CanvasSessionInput<K>,
): CanvasSession<K> {
  const space = input.space ?? (() => IDENTITY_TRANSFORM);
  const cfg = input.config;

  const active = computed(() => input.gesture() !== null);
  const kind = computed(() => input.gesture()?.kind ?? null);

  const canvasPointerX = computed(() => {
    const g = input.gesture();
    if (!g) return 0;
    const t = space();
    // scroll delta is viewport px, so it divides through the scale too
    return (
      (input.pointerX() + input.scrollDeltaX() - g.surfaceOrigin.x - t.x) /
      t.scale
    );
  });
  const canvasPointerY = computed(() => {
    const g = input.gesture();
    if (!g) return 0;
    const t = space();
    return (
      (input.pointerY() + input.scrollDeltaY() - g.surfaceOrigin.y - t.y) /
      t.scale
    );
  });

  // ONE shared resolution per move frame; per-item work is a lookup off it.
  const moveResult = computed(() => {
    const g = input.gesture();
    if (!g || g.kind !== 'move') return null;
    return resolveMove(
      g.union,
      {
        x: canvasPointerX() - g.start.x,
        y: canvasPointerY() - g.start.y,
      },
      {
        grid: cfg.grid(),
        bounds: cfg.bounds(),
        targets: cfg.snap() ? g.snapTargets : undefined,
        threshold: cfg.snapThreshold() / space().scale,
        snapToCanvas: cfg.snapToCanvas(),
        lockAxis: cfg.lockAxisOnShift() && input.modShift(),
        bypassSnap: input.modCtrl(),
      },
    );
  });

  const overlayDeltaX = computed(() => {
    const g = input.gesture();
    if (!g) return 0;
    const m = moveResult();
    return m ? m.box.x - g.union.x : 0;
  });
  const overlayDeltaY = computed(() => {
    const g = input.gesture();
    if (!g) return 0;
    const m = moveResult();
    return m ? m.box.y - g.union.y : 0;
  });

  const resizeResult = computed(() => {
    const g = input.gesture();
    if (!g || g.kind !== 'resize' || !g.direction) return null;
    return resolveResize(
      g.union,
      g.direction,
      {
        x: canvasPointerX() - g.start.x,
        y: canvasPointerY() - g.start.y,
      },
      {
        grid: cfg.grid(),
        bounds: cfg.bounds(),
        min: cfg.resizeMin(),
        max: cfg.resizeMax(),
        targets: cfg.snap() ? g.snapTargets : undefined,
        threshold: cfg.snapThreshold() / space().scale,
        snapToCanvas: cfg.snapToCanvas(),
        aspect: input.modShift()
          ? g.union.height > 0
            ? g.union.width / g.union.height
            : undefined
          : undefined,
        fromCenter: input.modAlt(),
        bypassSnap: input.modCtrl(),
      },
    );
  });

  const resizeBox = computed(() => resizeResult()?.box ?? null);

  const angle = computed(() => {
    const g = input.gesture();
    if (
      !g ||
      g.kind !== 'rotate' ||
      !g.pivot ||
      g.baseAngle === undefined ||
      g.startPointerAngle === undefined
    ) {
      return null;
    }
    return resolveRotate(
      g.baseAngle,
      g.startPointerAngle,
      { x: canvasPointerX(), y: canvasPointerY() },
      g.pivot,
      { snap: cfg.rotateSnap(), snapActive: input.modShift() },
    );
  });

  const marqueeRect = computed(() => {
    const g = input.gesture();
    if (!g || g.kind !== 'marquee') return null;
    return normalizeRect(g.start, {
      x: canvasPointerX(),
      y: canvasPointerY(),
    });
  });

  const guides = computed(
    () => {
      const g = input.gesture();
      if (!g) return NO_GUIDES;
      if (g.kind === 'move') return moveResult()?.guides ?? NO_GUIDES;
      if (g.kind === 'resize') return resizeResult()?.guides ?? NO_GUIDES;
      return NO_GUIDES;
    },
    { equal: guidesEqual },
  );

  const hoverContainer = computed<K | null>(() => {
    const g = input.gesture();
    if (!g || g.kind !== 'move' || !g.containers.length) return null;
    const x = canvasPointerX();
    const y = canvasPointerY();
    // innermost wins: smallest containing box (ties → later registration)
    let best: K | null = null;
    let bestArea = Infinity;
    for (const c of g.containers) {
      if (!boxContainsPoint(c.box, x, y)) continue;
      const area = c.box.width * c.box.height;
      if (area <= bestArea) {
        bestArea = area;
        best = c.key;
      }
    }
    return best;
  });

  return {
    active,
    kind,
    canvasPointerX,
    canvasPointerY,
    overlayDeltaX,
    overlayDeltaY,
    resizeBox,
    angle,
    marqueeRect,
    guides,
    hoverContainer,
  };
}
