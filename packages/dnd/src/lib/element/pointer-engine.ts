import { Injectable, inject, signal, type Signal } from '@angular/core';

import { DndSession, type DragKind, type DropTargetHit } from '../session';

/**
 * What a pointer-mode drop target registers with the engine. Mirrors the native
 * `dropTarget` hooks but is driven by hit-testing instead of native `dragenter`.
 * `accepts` receives the BOXED source record (same as native), so it can reuse
 * the same unbox+typeguard logic.
 */
export type PointerDragSource = {
  el: HTMLElement;
  /** BOXED payload (so the unified session's `sourceData` stays shape-consistent with native). */
  data: Record<string | symbol, unknown>;
  kind: DragKind;
};

export type PointerDropEntry = {
  accepts: (sourceData: Record<string | symbol, unknown>) => boolean;
  /** This target's data (boxed self data + any edge token), surfaced on the hit. */
  getData?: () => Record<string | symbol, unknown>;
  /** Reactive gate; mirrors native `canDrop`. */
  canDrop?: (sourceData: Record<string | symbol, unknown>) => boolean;
  /** Fired when an accepted source first enters this target. */
  onDragEnter?: (source: PointerDragSource) => void;
  /** Fired when the source leaves (or the drag ends/cancels while over it). */
  onDragLeave?: (source: PointerDragSource) => void;
  /** Fired on drop while this target is in the stack; gets the full stack for `location`. */
  onDrop?: (
    source: PointerDragSource,
    targets: readonly DropTargetHit[],
  ) => void;
};

/**
 * Resolve the innermost-first accepted drop-target stack at a point. Pure: the
 * caller supplies the z-stack (so it's testable without a real layout), which in
 * production is `document.elementsFromPoint(x, y)` — already topmost-first, i.e.
 * innermost-first for nested targets, matching pragmatic's `dropTargets`.
 */
export function resolveHits(
  stack: readonly Element[],
  entries: ReadonlyMap<Element, PointerDropEntry>,
  source: PointerDragSource,
): DropTargetHit[] {
  const hits: DropTargetHit[] = [];
  for (const el of stack) {
    const entry = entries.get(el);
    if (!entry) continue;
    if (!entry.accepts(source.data)) continue;
    if (entry.canDrop && !entry.canDrop(source.data)) continue;
    hits.push({ element: el, data: entry.getData ? entry.getData() : {} });
  }
  return hits;
}

/**
 * The pointer-mode counterpart to {@link DndSession}'s native monitor: a registry
 * of pointer drop targets plus the drive loop that hit-tests on each move and
 * pushes the result into the SAME unified `session` signal (tagged
 * `engine: 'pointer'`). One engine per session scope (root by default; re-provided
 * alongside `provideDndSession()` for a scoped surface).
 */
@Injectable({ providedIn: 'root' })
export class DndPointerEngine {
  private readonly dnd = inject(DndSession);
  private readonly entries = new Map<Element, PointerDropEntry>();
  private readonly _dragging = signal(false);
  private source: PointerDragSource | null = null;
  /** Registered targets currently under the pointer (innermost-first), for enter/leave diffing. */
  private over: Element[] = [];

  /** Whether a pointer-engine drag is currently in flight. */
  readonly dragging: Signal<boolean> = this._dragging.asReadonly();

  /** Register a pointer drop target; returns a disposer. */
  registerDropTarget(el: Element, entry: PointerDropEntry): () => void {
    this.entries.set(el, entry);
    return () => {
      if (this.entries.get(el) === entry) this.entries.delete(el);
    };
  }

  /** @internal element z-stack at a point — overridable in tests. */
  protected elementsAt(x: number, y: number): readonly Element[] {
    return typeof globalThis.document === 'undefined' ||
      typeof globalThis.document.elementsFromPoint !== 'function'
      ? []
      : globalThis.document.elementsFromPoint(x, y);
  }

  /** Begin a pointer drag: seed the session + fire enter for the initial targets. */
  begin(source: PointerDragSource, x: number, y: number): void {
    this.source = source;
    this._dragging.set(true);
    this.update(x, y);
  }

  /** Feed a move: re-hit-test, diff enter/leave, update the session. */
  move(_source: PointerDragSource, x: number, y: number): void {
    if (!this.source) return; // move before begin → no-op
    this.update(x, y);
  }

  private update(x: number, y: number): void {
    const source = this.source as PointerDragSource;
    const hits = resolveHits(this.elementsAt(x, y), this.entries, source);
    const next = hits.map((h) => h.element);
    for (const el of this.over)
      if (!next.includes(el)) this.entries.get(el)?.onDragLeave?.(source);
    for (const el of next)
      if (!this.over.includes(el)) this.entries.get(el)?.onDragEnter?.(source);
    this.over = next;
    this.dnd.session.set({
      sourceEl: source.el,
      sourceData: source.data,
      targets: hits,
      pointer: { x, y },
      kind: source.kind,
      engine: 'pointer',
    });
  }

  /** End the drag: fire drop on the current targets, return them, then clear. */
  end(): readonly DropTargetHit[] {
    const targets = this.dnd.session()?.targets ?? [];
    const source = this.source;
    if (source)
      for (const t of targets)
        this.entries.get(t.element)?.onDrop?.(source, targets);
    this.reset();
    return targets;
  }

  /** Abort without resolving a drop (fires leave for anything still over). */
  cancel(): void {
    const source = this.source;
    if (source)
      for (const el of this.over) this.entries.get(el)?.onDragLeave?.(source);
    this.reset();
  }

  private reset(): void {
    this.dnd.session.set(null);
    this._dragging.set(false);
    this.source = null;
    this.over = [];
  }
}
