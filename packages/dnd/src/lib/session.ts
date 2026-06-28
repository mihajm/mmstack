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
import { toWritable } from './internal/writable';

export type DropTargetHit = {
  element: Element;
  /** Raw pragmatic data — carries any closest-edge token a hitbox plugin attached. */
  data: Record<string | symbol, unknown>;
};

export type DragKind = 'transfer' | 'move' | 'resize' | 'marquee';

export type DragSession = {
  readonly sourceEl: HTMLElement;
  readonly sourceData: Record<string | symbol, unknown>;
  /** Innermost-first, exactly as pragmatic delivers `location.current.dropTargets`. */
  readonly targets: readonly DropTargetHit[];
  readonly pointer: { x: number; y: number };
  readonly kind: DragKind;
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

/**
 * The source of truth for an in-flight drag. One `monitorForElements` subscription
 * pushes pragmatic's drag world into **three fine-grained signals**, so a reader
 * only recomputes when *its* slice changes:
 *
 * - `source` — set on drag start / cleared on drop (NOT per frame). `draggable`/
 *   `monitor` derive from this.
 * - `targets` — the innermost-first hovered stack with fresh closest-edge tokens;
 *   re-set on every `onDrag` frame so the edge stays current. To test hover
 *   membership without recomputing per frame, derive from `targetEls` (element
 *   identity, stable across frames via custom equality) instead.
 * - `pointer` — set on every `onDrag` frame; read it only if you need live coords.
 *
 * `providedIn: 'root'` for zero config; re-provide it in a component's `providers`
 * to scope an independent session to a canvas boundary.
 *
 * @internal Reach the session through the `injectDnd*` helpers below, not this class.
 */
@Injectable({ providedIn: 'root' })
export class DndSession {
  private readonly _source = signal<Source | null>(null);
  private readonly _targets = signal<readonly DropTargetHit[]>([]);
  private readonly _pointer = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /** Drag source — changes on start/drop only. */
  readonly source: Signal<Source | null> = this._source.asReadonly();
  /** Innermost-first drop-target stack (with fresh closest-edge tokens, refreshed on drag). */
  readonly targets: Signal<readonly DropTargetHit[]> =
    this._targets.asReadonly();
  /**
   * Innermost-first hovered ELEMENTS only. Stable across frames (custom equality),
   * so element-identity checks don't recompute on every `onDrag`. Edge tokens live
   * on `targets`; read those when you need the live closest edge.
   */
  readonly targetEls: Signal<readonly Element[]> = computed(
    () => this._targets().map((t) => t.element),
    { equal: (a, b) => a.length === b.length && a.every((el, i) => el === b[i]) },
  );
  /** Latest pointer — changes every `onDrag` frame. */
  readonly pointer: Signal<{ x: number; y: number }> =
    this._pointer.asReadonly();
  readonly active = computed(() => this._source() !== null);

  /** Combined view; recomputes when any slice changes. For tooling/tests/external drive. */
  readonly session = toWritable(
    computed<DragSession | null>(() => {
      const s = this._source();
      if (!s) return null;
      return {
        sourceEl: s.el,
        sourceData: s.data,
        targets: this._targets(),
        pointer: this._pointer(),
        kind: s.kind,
      };
    }),
    (session) => {
      if (!session) {
        this._source.set(null);
        this._targets.set([]);
        return;
      }
      this._source.set({
        el: session.sourceEl,
        data: session.sourceData,
        kind: session.kind,
      });
      this._targets.set(session.targets);
      this._pointer.set(session.pointer);
    },
  );

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;

    // Scoped sessions inject a host element + only track drags inside their subtree
    // (root has none → tracks everything), so a drag elsewhere can't bleed in.
    const rootEl = inject(ElementRef, { optional: true })?.nativeElement as
      | HTMLElement
      | undefined;
    const inScope = (el: HTMLElement): boolean =>
      !rootEl || rootEl.contains(el);

    const cleanup = monitorForElements({
      onDragStart: (a) => {
        if (!inScope(a.source.element)) return;
        this._source.set({
          el: a.source.element,
          data: a.source.data,
          kind: 'transfer',
        });
        this._targets.set(mapTargets(a));
        this._pointer.set(point(a));
      },
      onDropTargetChange: (a) => {
        if (!inScope(a.source.element)) return;
        this._targets.set(mapTargets(a));
        this._pointer.set(point(a));
      },
      onDrag: (a) => {
        if (!inScope(a.source.element)) return;
        this._pointer.set(point(a));
        this._targets.set(mapTargets(a));
      },
      onDrop: (a) => {
        if (!inScope(a.source.element)) return;
        this._source.set(null);
        this._targets.set([]);
      },
    });
    inject(DestroyRef).onDestroy(cleanup);
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
