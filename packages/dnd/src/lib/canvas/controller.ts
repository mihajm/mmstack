import {
  computed,
  inject,
  Injector,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';

import { withDefaults } from '../provide';
import type { Point } from '../sortable/geometry';
import type { Arbitration } from './arbiter';
import { injectCanvasDefaults } from './defaults';
import {
  gridStep,
  intersects,
  unionBox,
  type Box,
  type CanvasFrame,
  type GridSpec,
} from './geometry';
import type { SelectionRef } from './selection';
import { selection as createSelection } from './selection';
import {
  canvasSession,
  IDENTITY_TRANSFORM,
  type CanvasGesture,
  type CanvasSession,
  type CanvasSpaceTransform,
} from './session';
import { angleOf, normalizeAngle } from './transform';

/** The pan/zoom placement of canvas space — a `PanZoomRef` satisfies this. */
export type CanvasSpace = {
  readonly transform: Signal<CanvasSpaceTransform>;
};

export type CanvasCommitMode = 'move' | 'resize' | 'rotate' | 'keyboard';

export type CanvasCommitEvent<T, K> = {
  /** New frames per touched item key — already applied to the source. */
  readonly patches: ReadonlyMap<K, CanvasFrame>;
  readonly mode: CanvasCommitMode;
  /** The reparent target the move ended over (`null` = root), when containers are on. */
  readonly container: K | null;
  readonly items: readonly T[];
};

export type CanvasReparentEvent<T, K> = {
  /**
   * New frames REBASED into the target container's space (delta plus the
   * origin shift from each item's start container). NOT applied — the
   * consumer restructures its tree and writes frames in ONE update.
   */
  readonly patches: ReadonlyMap<K, CanvasFrame>;
  /** The container to move the items into (`null` = root). */
  readonly container: K | null;
  readonly items: readonly T[];
};

export type CanvasOptions<T, K> = {
  /** Stable identity for an item. */
  readonly key: (item: T) => K;
  /** Read an item's frame (position/size/rotation) — pure. */
  readonly frame: (item: T) => CanvasFrame;
  /** Write a frame back immutably — pure. */
  readonly patch: (item: T, frame: CanvasFrame) => T;
  /** Snap positions to a grid (Ctrl bypasses). */
  readonly grid?: GridSpec | (() => GridSpec | undefined);
  /** Clamp the moved selection's union box within these canvas-space bounds. */
  readonly bounds?: Box | (() => Box | undefined);
  /** Sibling snaplines. `true` (default) snaps against every non-participant. */
  readonly snap?: boolean | { threshold?: number; toCanvas?: boolean };
  /** Resize handles. `true` (default) enables with no min/max. */
  readonly resize?:
    | boolean
    | {
        min?: { width?: number; height?: number };
        max?: { width?: number; height?: number };
      };
  /** Rotate handle. Off by default; `snap` degrees engage on Shift. */
  readonly rotate?: boolean | { snap?: number };
  /** Share an external selection, or let the canvas own one (default). */
  readonly selection?: SelectionRef<K>;
  /** Rubber-band selection from empty surface presses. @default true */
  readonly marquee?: boolean;
  /** The pan/zoom space (a `panZoom()` ref) — gestures project through it live. */
  readonly space?: CanvasSpace;
  /** Arrow-key nudging (Shift = ×10) and Cmd/Ctrl+arrows resize. @default true */
  readonly keyboard?: boolean | { step?: number; largeStep?: number };
  /** Lock a move to the dominant axis while Shift is held. @default true */
  readonly lockAxisOnShift?: boolean;
  /** Opt-in edge auto-scroll of the surface's scroll parent. */
  readonly autoScroll?:
    | { edge?: number; speed?: number; edgeProportion?: number; maxSpeedAt?: number }
    | false;
  /** Px the pointer must travel before a drag activates. @default 3 */
  readonly activationThreshold?: number;
  /**
   * Remote peers' in-flight frames (mesh presence), in the same space as your
   * `frame` lens — rendered instead of the source frame while present. Pair
   * with `lockedKeys` for peer-held items: a LOCAL drag of an overlaid item
   * still commits from the source frame, so the drop would jump.
   */
  readonly remoteOverlays?: Signal<ReadonlyMap<K, CanvasFrame>>;
  /** Keys that reject local gestures (peer-held items, consumer rules). */
  readonly lockedKeys?: Signal<ReadonlySet<K>>;
  /** Per-item gate for a given gesture kind. */
  readonly canTransform?: (item: T, mode: CanvasCommitMode) => boolean;
  /**
   * CMMN-style containment: some items are containers; a move resolves the
   * innermost accepting container under the pointer and reports it. With
   * `containerOf`, dropping over a DIFFERENT container becomes a reparent
   * (see {@link CanvasOptions.onReparent}).
   */
  readonly containers?: {
    isContainer(item: T): boolean;
    /** The item's current container key (`null` = root) — enables reparenting. */
    containerOf?: (item: T) => K | null;
    /** May `item` be dropped into `container`? Cycle guards live here. */
    canContain?: (container: T, item: T) => boolean;
  };
  readonly injector?: Injector;
  /** After a commit is applied to the source (one write per gesture). */
  readonly onCommit?: (event: CanvasCommitEvent<T, K>) => void;
  /** A move ended over a different container — the consumer applies it. */
  readonly onReparent?: (event: CanvasReparentEvent<T, K>) => void;
  /** Screen-reader message after a keyboard transform, `false` to disable. */
  readonly announceTransform?:
    | false
    | ((event: { item: T; frame: CanvasFrame; count: number }) => string);
};

export type CanvasItemState<K = unknown> = {
  readonly itemKey: Signal<K>;
  /** Part of the active local gesture. */
  readonly participating: Signal<boolean>;
  readonly selected: Signal<boolean>;
  /** Rendered box, css px — remote overlay wins over the source frame. */
  readonly leftPx: Signal<number>;
  readonly topPx: Signal<number>;
  readonly widthPx: Signal<number>;
  readonly heightPx: Signal<number>;
  /** Live translate+rotate — transform-only while moving (compositor path). */
  readonly transformCss: Signal<string>;
};

export type CanvasController<T, K = unknown> = {
  readonly items: Signal<readonly T[]>;
  readonly key: (item: T) => K;
  readonly selection: SelectionRef<K>;
  /** The pure derivation core — chrome renders from this (guides, marquee...). */
  readonly session: CanvasSession<K>;
  /**
   * Participants' live frames mid-gesture (canvas space), or `null` when
   * idle — the mesh-presence feed (throttle it into your presence channel).
   */
  readonly liveFrames: Signal<ReadonlyMap<K, CanvasFrame> | null>;
  readonly keyboard: { step?: number; largeStep?: number } | null;
  readonly autoScroll: {
    edge: number;
    speed: number;
    edgeProportion?: number;
    maxSpeedAt?: number;
  } | null;
  readonly activationThreshold: number;
  readonly marquee: boolean;
  itemState(item: () => T): CanvasItemState<K>;
  /** Selection semantics for a plain (non-drag) press. */
  press(key: K, shift: boolean): void;
  /** An empty-surface click clears the selection. */
  clearPress(): void;
  /** Keyboard: nudge the selection by grid steps (Shift = ×10 handled by caller). */
  nudge(dx: number, dy: number, large: boolean): boolean;
  /** Keyboard: resize the (single) selected item by grid steps. */
  nudgeResize(dw: number, dh: number, large: boolean): boolean;
  /** @internal DOM edge: begin from an arbitrated press. */
  beginFromPress(
    arb: Arbitration,
    start: { x: number; y: number },
    shift: boolean,
  ): boolean;
  /** @internal feed a pointer move (viewport coords + live modifiers). */
  move(
    point: { x: number; y: number },
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean },
  ): void;
  /** @internal end the gesture, committing exactly once. */
  end(): void;
  cancel(): void;
  dispose(): void;
  /** @internal item DOM registration. */
  register(key: K, el: HTMLElement): void;
  unregister(key: K, el: HTMLElement): void;
  keyForElement(el: HTMLElement): K | undefined;
  setSurface(el: HTMLElement | null): void;
  /** @internal auto-scroll compensation, viewport px. */
  setScrollDelta(x: number, y: number): void;
  /** @internal the connect layer installs the a11y announce sink (needs an injector). */
  setAnnounce(fn: ((message: string) => void) | null): void;
};

const DEFAULT_AUTOSCROLL = { edge: 48, speed: 16 } as const;

function resolveGetter<V>(
  v: V | (() => V | undefined) | undefined,
): () => V | undefined {
  if (v === undefined) return () => undefined;
  return typeof v === 'function' ? (v as () => V | undefined) : () => v;
}

/**
 * The free-form canvas controller: Figma-grade move/resize/rotate/marquee over
 * a consumer-owned items signal. Mid-gesture state is a transient overlay
 * derived from a drag-start snapshot ({@link canvasSession}); the source is
 * written EXACTLY once, at drop, with untouched items reference-identical —
 * which is what makes a store-backed source emit clean per-property ops.
 */
export function canvas<T, K>(
  source: WritableSignal<readonly T[]>,
  opts: CanvasOptions<T, K>,
): CanvasController<T, K> {
  const options = withDefaults(
    opts,
    opts.injector ? injectCanvasDefaults(opts.injector) : null,
  );
  const { key, frame, patch } = options;
  const grid = resolveGetter(options.grid);
  const bounds = resolveGetter(options.bounds);
  const snapOn = options.snap !== false;
  const snapThreshold =
    (typeof options.snap === 'object' ? options.snap.threshold : undefined) ??
    6;
  const snapToCanvas =
    (typeof options.snap === 'object' ? options.snap.toCanvas : undefined) ??
    false;
  const resizeOn = options.resize !== false;
  const resizeCfg = typeof options.resize === 'object' ? options.resize : {};
  const rotateOn = options.rotate === true || typeof options.rotate === 'object';
  const rotateSnap =
    typeof options.rotate === 'object' ? options.rotate.snap : undefined;
  const marquee = options.marquee ?? true;
  const lockAxisOnShift = options.lockAxisOnShift ?? true;
  const keyboard =
    options.keyboard === false
      ? null
      : typeof options.keyboard === 'object'
        ? options.keyboard
        : {};
  const activationThreshold = options.activationThreshold ?? 3;
  const autoScroll = options.autoScroll
    ? {
        edge: options.autoScroll.edge ?? DEFAULT_AUTOSCROLL.edge,
        speed: options.autoScroll.speed ?? DEFAULT_AUTOSCROLL.speed,
        edgeProportion: options.autoScroll.edgeProportion,
        maxSpeedAt: options.autoScroll.maxSpeedAt,
      }
    : null;
  const announceTransform =
    options.announceTransform === false ? null : options.announceTransform;
  const sel = options.selection ?? createSelection<K>();

  const byKey = new Map<K, HTMLElement>();
  const byEl = new Map<HTMLElement, K>();
  let surface: HTMLElement | null = null;

  const gesture = signal<CanvasGesture<K> | null>(null);
  const pointerX = signal(0);
  const pointerY = signal(0);
  const modShift = signal(false);
  const modCtrl = signal(false);
  const modAlt = signal(false);
  const scrollDeltaX = signal(0);
  const scrollDeltaY = signal(0);
  const spaceTransform =
    options.space?.transform ?? computed(() => IDENTITY_TRANSFORM);

  let allBoxes: ReadonlyMap<K, Box> | null = null;
  let startContainers: ReadonlyMap<K, K | null> | null = null;
  let containerBoxes: ReadonlyMap<K, Box> | null = null;
  let resizeBase: Box | null = null;

  const session = canvasSession<K>({
    gesture,
    pointerX,
    pointerY,
    modShift,
    modCtrl,
    modAlt,
    scrollDeltaX,
    scrollDeltaY,
    space: spaceTransform,
    config: {
      grid,
      bounds,
      snap: () => snapOn,
      snapThreshold: () => snapThreshold,
      snapToCanvas: () => snapToCanvas,
      lockAxisOnShift: () => lockAxisOnShift,
      resizeMin: () => resizeCfg.min,
      resizeMax: () => resizeCfg.max,
      rotateSnap: () => rotateSnap,
    },
  });

  const indexMap = computed(() => {
    const map = new Map<K, T>();
    for (const it of source()) map.set(key(it), it);
    return map;
  });

  /** viewport → canvas, against the LIVE transform (imperative, untracked). */
  const toCanvas = (p: { x: number; y: number }): Point => {
    const t = untracked(spaceTransform);
    const o = surface?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: (p.x - o.left - t.x) / t.scale,
      y: (p.y - o.top - t.y) / t.scale,
    };
  };

  /** An element's box in canvas space (measured; gesture-start only). */
  const measureBox = (el: HTMLElement): Box => {
    const r = el.getBoundingClientRect();
    const t = untracked(spaceTransform);
    const o = surface?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: (r.left - o.left - t.x) / t.scale,
      y: (r.top - o.top - t.y) / t.scale,
      width: r.width / t.scale,
      height: r.height / t.scale,
    };
  };

  const isLocked = (k: K) => options.lockedKeys?.().has(k) ?? false;
  const gate = (item: T, mode: CanvasCommitMode) =>
    options.canTransform ? options.canTransform(item, mode) !== false : true;

  const beginFromPress = (
    arb: Arbitration,
    start: { x: number; y: number },
    shift: boolean,
  ): boolean => {
    if (untracked(gesture)) return false;
    const items = untracked(source);
    const map = untracked(indexMap);
    const startCanvas = toCanvas(start);
    const o = surface?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const surfaceOrigin = { x: o.left, y: o.top };

    const measureAll = () => {
      const boxes = new Map<K, Box>();
      for (const it of items) {
        const el = byKey.get(key(it));
        if (el) boxes.set(key(it), measureBox(el));
      }
      return boxes;
    };

    if (arb.mode === 'marquee') {
      if (!marquee) return false;
      allBoxes = measureAll();
      gesture.set({
        kind: 'marquee',
        keys: [],
        baseFrames: new Map(),
        union: { x: 0, y: 0, width: 0, height: 0 },
        snapTargets: [],
        containers: [],
        start: startCanvas,
        surfaceOrigin,
      });
      seed(start);
      return true;
    }

    if (arb.mode === 'move') {
      const k = byEl.get(arb.itemEl);
      if (k === undefined || isLocked(k)) return false;
      const pressed = map.get(k);
      if (!pressed || !gate(pressed, 'move')) return false;

      // Figma press semantics: dragging an unselected item selects it (Shift adds)
      if (!sel.has(k)) {
        if (shift) sel.add(k);
        else sel.set([k]);
      }
      const keys = untracked(sel.ids).filter((id) => {
        const it = map.get(id);
        return it && !isLocked(id) && gate(it, 'move');
      });
      if (!keys.length) return false;

      const boxes = measureAll();
      const baseFrames = new Map<K, CanvasFrame>();
      const participantBoxes: Box[] = [];
      for (const id of keys) {
        const b = boxes.get(id);
        const it = map.get(id);
        if (!b || !it) return false;
        baseFrames.set(id, { ...b, rotation: frame(it).rotation });
        participantBoxes.push(b);
      }
      const union = unionBox(participantBoxes);
      if (!union) return false;

      const participantSet = new Set(keys);
      const snapTargets: Box[] = [];
      const containerList: { key: K; box: Box }[] = [];
      const containerBoxMap = new Map<K, Box>();
      for (const it of items) {
        const id = key(it);
        if (participantSet.has(id)) continue;
        const b = boxes.get(id);
        if (!b) continue;
        snapTargets.push(b);
        if (options.containers?.isContainer(it)) {
          // cycle guard: canContain gets (container, pressed) — untracked consumer read
          const accepts = options.containers.canContain
            ? keys.every((pk) => {
                const pi = map.get(pk);
                return (
                  pi !== undefined &&
                  untracked(() =>
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    options.containers!.canContain!(it, pi),
                  ) !== false
                );
              })
            : true;
          if (accepts) {
            containerList.push({ key: id, box: b });
            containerBoxMap.set(id, b);
          }
        }
      }
      if (options.containers?.containerOf) {
        const starts = new Map<K, K | null>();
        for (const id of keys) {
          const it = map.get(id);
          starts.set(id, it ? options.containers.containerOf(it) : null);
        }
        startContainers = starts;
        for (const it of items) {
          const id = key(it);
          if (options.containers.isContainer(it) && !containerBoxMap.has(id)) {
            const b = boxes.get(id);
            if (b) containerBoxMap.set(id, b);
          }
        }
      }
      containerBoxes = containerBoxMap;
      allBoxes = boxes;

      gesture.set({
        kind: 'move',
        keys,
        baseFrames,
        union,
        snapTargets,
        containers: containerList,
        start: startCanvas,
        surfaceOrigin,
      });
      seed(start);
      return true;
    }

    // resize / rotate act on a SINGLE selected item (group transforms deferred)
    const ids = untracked(sel.ids);
    if (ids.length !== 1) return false;
    const k = ids[0];
    if (isLocked(k)) return false;
    const item = map.get(k);
    const el = byKey.get(k);
    if (!item || !el) return false;
    const box = measureBox(el);

    if (arb.mode === 'resize') {
      if (!resizeOn || !gate(item, 'resize')) return false;
      resizeBase = box;
      gesture.set({
        kind: 'resize',
        direction: arb.direction,
        keys: [k],
        baseFrames: new Map([[k, { ...box, rotation: frame(item).rotation }]]),
        union: box,
        snapTargets: measureSnapTargets(k),
        containers: [],
        start: startCanvas,
        surfaceOrigin,
      });
      seed(start);
      return true;
    }

    if (!rotateOn || !gate(item, 'rotate')) return false;
    const pivot = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
    gesture.set({
      kind: 'rotate',
      keys: [k],
      baseFrames: new Map([[k, { ...box, rotation: frame(item).rotation }]]),
      union: box,
      snapTargets: [],
      containers: [],
      start: startCanvas,
      surfaceOrigin,
      pivot,
      baseAngle: frame(item).rotation ?? 0,
      startPointerAngle: angleOf(startCanvas, pivot),
    });
    seed(start);
    return true;

    function measureSnapTargets(except: K): Box[] {
      const out: Box[] = [];
      for (const it of items) {
        const id = key(it);
        if (id === except) continue;
        const el2 = byKey.get(id);
        if (el2) out.push(measureBox(el2));
      }
      return out;
    }
  };

  const seed = (start: { x: number; y: number }) => {
    pointerX.set(start.x);
    pointerY.set(start.y);
    scrollDeltaX.set(0);
    scrollDeltaY.set(0);
  };

  const move = (
    p: { x: number; y: number },
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean },
  ) => {
    pointerX.set(p.x);
    pointerY.set(p.y);
    if (modifiers) {
      modShift.set(modifiers.shift);
      modCtrl.set(modifiers.ctrl);
      modAlt.set(modifiers.alt);
    }
    if (untracked(gesture)?.kind === 'marquee' && allBoxes) {
      const rect = untracked(session.marqueeRect);
      if (!rect) return;
      const hits: K[] = [];
      for (const [k, b] of allBoxes) {
        if (intersects(b, rect)) hits.push(k);
      }
      const current = untracked(sel.ids);
      if (
        hits.length !== current.length ||
        hits.some((h, i) => h !== current[i])
      ) {
        sel.set(hits);
      }
    }
  };

  const resetGestureState = () => {
    gesture.set(null);
    modShift.set(false);
    modCtrl.set(false);
    modAlt.set(false);
    scrollDeltaX.set(0);
    scrollDeltaY.set(0);
    allBoxes = null;
    startContainers = null;
    containerBoxes = null;
    resizeBase = null;
  };

  /** Apply per-key frame updates in ONE source write, preserving identity. */
  const applyPatches = (patches: ReadonlyMap<K, CanvasFrame>) => {
    if (!patches.size) return;
    source.update((arr) =>
      arr.map((it) => {
        const next = patches.get(key(it));
        return next ? patch(it, next) : it;
      }),
    );
  };

  const end = () => {
    const g = untracked(gesture);
    if (!g) return;
    const map = untracked(indexMap);

    if (g.kind === 'move') {
      const dx = untracked(session.overlayDeltaX);
      const dy = untracked(session.overlayDeltaY);
      const container = untracked(session.hoverContainer);
      // a zero-delta drop can still be a reparent (grid snap rounding the
      // origin back while the pointer crossed a container boundary)
      const crossed =
        startContainers !== null &&
        g.keys.some((k) => startContainers?.get(k) !== container);
      if (dx || dy || crossed) {
        const patches = new Map<K, CanvasFrame>();
        for (const k of g.keys) {
          const it = map.get(k);
          if (!it) continue;
          const f = frame(it);
          patches.set(k, { ...f, x: f.x + dx, y: f.y + dy });
        }
        // a drop over a DIFFERENT container reparents: rebase and hand over, no auto-write
        if (crossed && options.onReparent) {
          const targetBox =
            container !== null ? containerBoxes?.get(container) : undefined;
          const rebased = new Map<K, CanvasFrame>();
          for (const k of g.keys) {
            const it = map.get(k);
            if (!it) continue;
            const f = frame(it);
            const from = startContainers?.get(k) ?? null;
            const fromBox =
              from !== null ? containerBoxes?.get(from) : undefined;
            const shiftX = (fromBox?.x ?? 0) - (targetBox?.x ?? 0);
            const shiftY = (fromBox?.y ?? 0) - (targetBox?.y ?? 0);
            rebased.set(k, {
              ...f,
              x: f.x + dx + shiftX,
              y: f.y + dy + shiftY,
            });
          }
          options.onReparent({
            patches: rebased,
            container,
            items: untracked(source),
          });
        } else {
          applyPatches(patches);
          options.onCommit?.({
            patches,
            mode: 'move',
            container,
            items: untracked(source),
          });
        }
      }
      return resetGestureState();
    }

    if (g.kind === 'resize' && resizeBase) {
      const box = untracked(session.resizeBox);
      const k = g.keys[0];
      const it = k !== undefined ? map.get(k) : undefined;
      if (box && it) {
        const f = frame(it);
        const next: CanvasFrame = {
          ...f,
          x: f.x + (box.x - resizeBase.x),
          y: f.y + (box.y - resizeBase.y),
          width: f.width + (box.width - resizeBase.width),
          height: f.height + (box.height - resizeBase.height),
        };
        if (
          next.x !== f.x ||
          next.y !== f.y ||
          next.width !== f.width ||
          next.height !== f.height
        ) {
          const patches = new Map<K, CanvasFrame>([[k, next]]);
          applyPatches(patches);
          options.onCommit?.({
            patches,
            mode: 'resize',
            container: null,
            items: untracked(source),
          });
        }
      }
      return resetGestureState();
    }

    if (g.kind === 'rotate') {
      const angle = untracked(session.angle);
      const k = g.keys[0];
      const it = k !== undefined ? map.get(k) : undefined;
      if (angle !== null && it) {
        const f = frame(it);
        // the session angle is normalized — a zero-sweep release on a
        // non-normalized lens rotation must stay a no-op
        if (normalizeAngle(f.rotation ?? 0) !== angle) {
          const patches = new Map<K, CanvasFrame>([[k, { ...f, rotation: angle }]]);
          applyPatches(patches);
          options.onCommit?.({
            patches,
            mode: 'rotate',
            container: null,
            items: untracked(source),
          });
        }
      }
      return resetGestureState();
    }

    resetGestureState();
  };

  /**
   * Published in LENS space (the same space `remoteOverlays` values are
   * rendered in), so a peer feeding these back through `remoteOverlays`
   * round-trips exactly — including rotated items, whose measured boxes are
   * AABBs and would lie about origin/size.
   */
  const liveFrames = computed<ReadonlyMap<K, CanvasFrame> | null>(() => {
    const g = gesture();
    if (!g || g.kind === 'marquee') return null;
    const map = indexMap();
    const out = new Map<K, CanvasFrame>();
    if (g.kind === 'move') {
      const dx = session.overlayDeltaX();
      const dy = session.overlayDeltaY();
      for (const k of g.keys) {
        const it = map.get(k);
        if (!it) continue;
        const f = frame(it);
        out.set(k, { ...f, x: f.x + dx, y: f.y + dy });
      }
      return out;
    }
    if (g.kind === 'resize') {
      const box = session.resizeBox();
      const k = g.keys[0];
      const it = k !== undefined ? map.get(k) : undefined;
      const base = k !== undefined ? g.baseFrames.get(k) : undefined;
      if (box && it && base && k !== undefined) {
        const f = frame(it);
        out.set(k, {
          ...f,
          x: f.x + (box.x - base.x),
          y: f.y + (box.y - base.y),
          width: f.width + (box.width - base.width),
          height: f.height + (box.height - base.height),
        });
      }
      return out;
    }
    const angle = session.angle();
    const k = g.keys[0];
    const it = k !== undefined ? map.get(k) : undefined;
    if (angle !== null && it && k !== undefined) {
      out.set(k, { ...frame(it), rotation: angle });
    }
    return out;
  });

  const nudgeCommit = (
    patches: Map<K, CanvasFrame>,
    mode: CanvasCommitMode,
  ): boolean => {
    if (!patches.size) return false;
    applyPatches(patches);
    options.onCommit?.({
      patches,
      mode,
      container: null,
      items: untracked(source),
    });
    return true;
  };

  const step = (large: boolean) => {
    const base = keyboard?.step ?? gridStep(grid());
    return large ? (keyboard?.largeStep ?? base * 10) : base;
  };

  let announceRef: ((message: string) => void) | null = null;

  const itemState = (item: () => T): CanvasItemState<K> => {
    const itemKey = computed(() => key(item()));
    const participating = computed(() => {
      const g = gesture();
      if (!g || g.kind === 'marquee') return false;
      const k = itemKey();
      for (const gk of g.keys) if (gk === k) return true;
      return false;
    });
    const remote = computed(
      () => options.remoteOverlays?.().get(itemKey()) ?? null,
    );
    const baseFrame = computed(() => remote() ?? frame(item()));

    const resizing = computed(
      () => participating() && session.kind() === 'resize',
    );

    return {
      itemKey,
      participating,
      selected: computed(() => sel.has(itemKey())),
      leftPx: computed(() => {
        const f = baseFrame();
        if (!resizing()) return f.x;
        const g = gesture();
        const box = session.resizeBox();
        const base = g?.baseFrames.get(itemKey());
        return box && base ? f.x + (box.x - base.x) : f.x;
      }),
      topPx: computed(() => {
        const f = baseFrame();
        if (!resizing()) return f.y;
        const g = gesture();
        const box = session.resizeBox();
        const base = g?.baseFrames.get(itemKey());
        return box && base ? f.y + (box.y - base.y) : f.y;
      }),
      widthPx: computed(() => {
        const f = baseFrame();
        if (!resizing()) return f.width;
        const g = gesture();
        const box = session.resizeBox();
        const base = g?.baseFrames.get(itemKey());
        // deltas, not the resolved box: the measured base is a rotated item's
        // AABB, and the commit maps deltas onto the lens frame the same way
        return box && base ? f.width + (box.width - base.width) : f.width;
      }),
      heightPx: computed(() => {
        const f = baseFrame();
        if (!resizing()) return f.height;
        const g = gesture();
        const box = session.resizeBox();
        const base = g?.baseFrames.get(itemKey());
        return box && base ? f.height + (box.height - base.height) : f.height;
      }),
      transformCss: computed(() => {
        const rotation =
          participating() && session.kind() === 'rotate'
            ? (session.angle() ?? baseFrame().rotation ?? 0)
            : (baseFrame().rotation ?? 0);
        const rotate = rotation ? ` rotate(${rotation}deg)` : '';
        if (participating() && session.kind() === 'move') {
          const dx = session.overlayDeltaX();
          const dy = session.overlayDeltaY();
          if (dx || dy) return `translate(${dx}px, ${dy}px)${rotate}`;
        }
        return rotate.trim();
      }),
    };
  };

  const self: CanvasController<T, K> = {
    items: source,
    key,
    selection: sel,
    session,
    liveFrames,
    keyboard,
    autoScroll,
    activationThreshold,
    marquee,
    itemState,
    press: (k, shift) => {
      if (isLocked(k)) return;
      if (shift) sel.toggle(k);
      else sel.set([k]);
    },
    clearPress: () => sel.clear(),
    nudge: (dx, dy, large) => {
      if (!keyboard) return false;
      const s = step(large);
      const map = untracked(indexMap);
      const patches = new Map<K, CanvasFrame>();
      let last: { item: T; frame: CanvasFrame } | null = null;
      for (const k of untracked(sel.ids)) {
        if (isLocked(k)) continue;
        const it = map.get(k);
        if (!it || !gate(it, 'keyboard')) continue;
        const f = frame(it);
        const next = { ...f, x: f.x + dx * s, y: f.y + dy * s };
        patches.set(k, next);
        last = { item: it, frame: next };
      }
      const ok = nudgeCommit(patches, 'keyboard');
      if (ok && last && announceTransform) {
        announceRef?.(
          announceTransform({ ...last, count: patches.size }),
        );
      }
      return ok;
    },
    nudgeResize: (dw, dh, large) => {
      if (!keyboard || !resizeOn) return false;
      const ids = untracked(sel.ids);
      if (ids.length !== 1) return false;
      const k = ids[0];
      if (isLocked(k)) return false;
      const it = untracked(indexMap).get(k);
      if (!it || !gate(it, 'keyboard')) return false;
      const s = step(large);
      const f = frame(it);
      const clampDim = (v: number, min: number | undefined, max: number | undefined) =>
        Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? 1, v));
      const next = {
        ...f,
        width: clampDim(f.width + dw * s, resizeCfg.min?.width, resizeCfg.max?.width),
        height: clampDim(f.height + dh * s, resizeCfg.min?.height, resizeCfg.max?.height),
      };
      if (next.width === f.width && next.height === f.height) return false;
      const patches = new Map<K, CanvasFrame>([[k, next]]);
      const ok = nudgeCommit(patches, 'keyboard');
      if (ok && announceTransform) {
        announceRef?.(announceTransform({ item: it, frame: next, count: 1 }));
      }
      return ok;
    },
    beginFromPress,
    move,
    end,
    cancel: resetGestureState,
    dispose: () => {
      if (untracked(gesture)) resetGestureState();
    },
    register: (k, el) => {
      byKey.set(k, el);
      byEl.set(el, k);
    },
    unregister: (k, el) => {
      if (byKey.get(k) === el) byKey.delete(k);
      if (byEl.get(el) === k) byEl.delete(el);
    },
    keyForElement: (el) => byEl.get(el),
    setSurface: (el) => {
      surface = el;
    },
    setScrollDelta: (x, y) => {
      scrollDeltaX.set(x);
      scrollDeltaY.set(y);
    },
    setAnnounce: (fn) => {
      announceRef = fn;
    },
  };

  return self;
}

/**
 * DI-aware {@link canvas}: captures the current `Injector` so
 * `provideCanvasDefaults` / announcements resolve.
 */
export function injectCanvas<T, K>(
  source: WritableSignal<readonly T[]>,
  opts: CanvasOptions<T, K>,
): CanvasController<T, K> {
  const injector = opts.injector ?? inject(Injector);
  return canvas(source, { ...opts, injector });
}
