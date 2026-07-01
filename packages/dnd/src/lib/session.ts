import { isPlatformServer } from '@angular/common';
import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injectable,
  PLATFORM_ID,
  signal,
  type Provider,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

export type DropTargetHit = {
  element: Element;
  /** Raw pragmatic data — carries any closest-edge token a hitbox plugin attached. */
  data: Record<string | symbol, unknown>;
};

export type DragKind = 'transfer' | 'move' | 'resize' | 'marquee';

/**
 * Which drag mechanism produced this session: the native HTML5 DnD adapter
 * (`'native'`, the default — files/cross-window/native drag image) or the
 * pointer engine (`'pointer'` — in-page, continuous position, FLIP). Consumers
 * branch on this when a behaviour is engine-specific; most don't need to.
 */
export type DragEngine = 'native' | 'pointer';

export type DragSession = {
  readonly sourceEl: HTMLElement;
  readonly sourceData: Record<string | symbol, unknown>;
  /** Innermost-first, exactly as pragmatic delivers `location.current.dropTargets`. */
  readonly targets: readonly DropTargetHit[];
  readonly pointer: { x: number; y: number };
  readonly kind: DragKind;
  /** The engine driving this drag. @default 'native' */
  readonly engine: DragEngine;
};

/** Structural shape of pragmatic's monitor callback args — kept loose for version resilience. */
type MonitorArgs = {
  source: { element: HTMLElement; data: Record<string | symbol, unknown> };
  location: {
    current: {
      input: { clientX: number; clientY: number };
      dropTargets: readonly {
        element: Element;
        data: Record<string | symbol, unknown>;
      }[];
    };
  };
};

type Source = {
  el: HTMLElement;
  data: Record<string | symbol, unknown>;
  kind: DragKind;
};

const mapTargets = (a: MonitorArgs): DropTargetHit[] =>
  a.location.current.dropTargets.map((t) => ({
    element: t.element,
    data: t.data,
  }));

const point = (a: MonitorArgs): { x: number; y: number } => ({
  x: a.location.current.input.clientX,
  y: a.location.current.input.clientY,
});

const pointEqual = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean => a.x === b.x && a.y === b.y;

// Equal iff same elements+order+data (incl. symbol-keyed edge tokens): skips re-notify on unchanged onDrag frames.
const targetsEqual = (
  a: readonly DropTargetHit[],
  b: readonly DropTargetHit[],
): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].element !== b[i].element) return false;
    const da = a[i].data as Record<PropertyKey, unknown>;
    const db = b[i].data as Record<PropertyKey, unknown>;
    const ka = Reflect.ownKeys(da);
    if (ka.length !== Reflect.ownKeys(db).length) return false;
    for (const k of ka) if (da[k] !== db[k]) return false;
  }
  return true;
};

const sourceEqual = (a: Source | null, b: Source | null): boolean =>
  a === b ||
  (!!a && !!b && a.el === b.el && a.kind === b.kind && a.data === b.data);

const elsEqual = (a: readonly Element[], b: readonly Element[]): boolean =>
  a.length === b.length && a.every((el, i) => el === b[i]);

const ZERO: { x: number; y: number } = { x: 0, y: 0 };
const NO_TARGETS: readonly DropTargetHit[] = [];

/**
 * The source of truth for an in-flight drag. One `monitorForElements` subscription
 * pushes pragmatic's drag world into **three fine-grained signals**, so a reader
 * only recomputes when *its* slice changes:
 *
 * - `source` — set on drag start / cleared on drop (NOT per frame). `draggable`/
 *   `monitor` derive from this.
 * - `targets` — the innermost-first hovered stack with fresh closest-edge tokens.
 *   Fed every `onDrag` frame but equality-gated, so it only re-notifies when the
 *   stack (elements or data) actually changes. For pure element-membership checks
 *   prefer `targetEls`.
 * - `pointer` — the live pointer; fed every frame but equality-gated, so a
 *   held-still drag (e.g. during auto-scroll) doesn't churn its readers.
 *
 * `providedIn: 'root'` for zero config; re-provide it in a component's `providers`
 * to scope an independent session to a canvas boundary.
 *
 * @internal Reach the session through the `injectDnd*` helpers below, not this class.
 */
@Injectable({ providedIn: 'root' })
export class DndSession {
  /**
   * The single source of truth — the whole drag snapshot, or `null` when idle.
   * Writable so a custom (e.g. pointer-based) engine can drive it via `.set()`.
   * Every fine-grained reader below derives from this; nothing is synchronized
   * by hand. Fed every `onDrag` frame, so read the narrow signals (not this) when
   * you only care about one slice.
   */
  readonly session: WritableSignal<DragSession | null> =
    signal<DragSession | null>(null);

  /** Whether a drag is in flight — flips only true↔false (so it's cheap to read). */
  readonly active = computed(() => this.session() !== null);

  /**
   * Drag source. Equality-gated on `el`/`data`/`kind`, so although the snapshot
   * changes every frame this only notifies when the source itself changes
   * (effectively start/drop).
   */
  readonly source: Signal<Source | null> = computed(
    () => {
      const s = this.session();
      return s ? { el: s.sourceEl, data: s.sourceData, kind: s.kind } : null;
    },
    { equal: sourceEqual },
  );

  /** Live pointer; equality-gated so a held-still drag doesn't churn its readers. */
  readonly pointer: Signal<{ x: number; y: number }> = computed(
    () => this.session()?.pointer ?? ZERO,
    { equal: pointEqual },
  );

  /**
   * Innermost-first drop-target stack with fresh closest-edge tokens. Equality-
   * gated, so it only notifies when the stack (elements or data) actually changes.
   */
  readonly targets: Signal<readonly DropTargetHit[]> = computed(
    () => this.session()?.targets ?? NO_TARGETS,
    { equal: targetsEqual },
  );

  /**
   * Innermost-first hovered ELEMENTS only — derived from the gated `targets`, so
   * element-identity checks stay flat across frames. Edge tokens live on `targets`.
   */
  readonly targetEls: Signal<readonly Element[]> = computed(
    () => this.targets().map((t) => t.element),
    { equal: elsEqual },
  );

  private readonly server = isPlatformServer(inject(PLATFORM_ID));
  // Scoped sessions only track drags inside their host subtree; root has no el → tracks everything.
  private readonly rootEl = inject(ElementRef, { optional: true })?.nativeElement as
    | HTMLElement
    | undefined;
  private readonly destroyRef = inject(DestroyRef);
  private monitorAttached = false;

  /**
   * Attach the native (pragmatic) drag monitor that feeds this session — lazily,
   * so a POINTER-only app never creates it (the pointer engine drives the session
   * via `.set()`). Called by native `draggable`/`dropTarget`/`reorderable`.
   * Idempotent + inert on the server.
   */
  ensureNativeMonitor(): void {
    if (this.monitorAttached || this.server) return;
    this.monitorAttached = true;

    const inScope = (el: HTMLElement): boolean =>
      !this.rootEl || this.rootEl.contains(el);

    const cleanup = monitorForElements({
      onDragStart: (a) => {
        if (!inScope(a.source.element)) return;
        this.session.set({
          sourceEl: a.source.element,
          sourceData: a.source.data,
          targets: mapTargets(a),
          pointer: point(a),
          kind: 'transfer',
          engine: 'native',
        });
      },
      onDropTargetChange: (a) => {
        const s = this.session();
        // orphan frame (no active drag) → don't fabricate/leak state
        if (!s || !inScope(a.source.element)) return;
        this.session.set({ ...s, targets: mapTargets(a), pointer: point(a) });
      },
      onDrag: (a) => {
        const s = this.session();
        if (!s || !inScope(a.source.element)) return;
        this.session.set({ ...s, pointer: point(a), targets: mapTargets(a) });
      },
      onDrop: (a) => {
        if (!inScope(a.source.element)) return;
        this.session.set(null);
      },
    });
    this.destroyRef.onDestroy(cleanup);
  }
}

/**
 * The active drag as a writable signal: read it for a full snapshot, or `.set()` it to
 * drive the session from a custom (e.g. pointer-based) engine. Recomputes whenever any
 * part of the drag changes — prefer the narrower `injectDnd*` helpers when you only need
 * one slice.
 */
export function injectDndSession(): WritableSignal<DragSession | null> {
  return inject(DndSession).session;
}

/** Whether a drag is in flight. Flips only on drag start / drop, so it is cheap to read. */
export function injectDndActive(): Signal<boolean> {
  return inject(DndSession).active;
}

/** Innermost-first stack of drop targets under the pointer; changes only as the hovered targets change. */
export function injectDndTargets(): Signal<readonly DropTargetHit[]> {
  return inject(DndSession).targets;
}

/** Live pointer coordinates for the active drag; changes every frame, so read it only when you need live coords. */
export function injectDndPointer(): Signal<{ x: number; y: number }> {
  return inject(DndSession).pointer;
}

/**
 * Scope an isolated drag session to a component subtree. Add to a component's
 * `providers` so a nested surface (e.g. a canvas) tracks only drags within its
 * own host element instead of sharing the root session. The `injectDnd*` helpers
 * resolve to this scoped instance inside the subtree.
 */
export function provideDndSession(): Provider[] {
  return [DndSession];
}
