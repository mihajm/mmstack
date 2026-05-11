import { computed, ElementRef, isSignal, type Signal } from '@angular/core';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type {
  DragHandleLike,
  DragMeta,
  DropTargetInfo,
  Edge,
  Resolvable,
} from './types';

export function resolveSignal<T>(value: Resolvable<T>): Signal<T> {
  if (isSignal(value)) return value;
  if (typeof value === 'function') return computed(value as () => T);
  return computed(() => value);
}

export function resolveElement(
  value: DragHandleLike | undefined,
): HTMLElement | undefined {
  if (!value) return undefined;
  if (value instanceof ElementRef) return value.nativeElement;
  if (
    typeof value === 'object' &&
    'elementRef' in value &&
    value.elementRef instanceof ElementRef
  ) {
    return value.elementRef.nativeElement;
  }
  return value as HTMLElement;
}

export const DRAG_DATA_KEY = Symbol('@mmstack/dnd:drag-data');
export const DROP_TARGET_DATA_KEY = Symbol('@mmstack/dnd:drop-target-data');

export function boxDragData<T>(data: T): Record<string | symbol, unknown> {
  return { [DRAG_DATA_KEY]: data };
}

export function unboxDragData<T>(
  data: Record<string | symbol, unknown>,
): T | undefined {
  return data[DRAG_DATA_KEY] as T | undefined;
}

export function boxDropTargetData<T>(
  data: T,
): Record<string | symbol, unknown> {
  return { [DROP_TARGET_DATA_KEY]: data };
}

export function unboxDropTargetData<T>(
  data: Record<string | symbol, unknown>,
): T | undefined {
  return data[DROP_TARGET_DATA_KEY] as T | undefined;
}

export function mapDropTargets(
  records: readonly {
    element: Element;
    data: Record<string | symbol, unknown>;
  }[],
): DropTargetInfo[] {
  return records.map((r) => ({
    element: r.element,
    data: unboxDropTargetData(r.data) ?? r.data,
  }));
}

export function extractEdgeFromInnermost(
  records: readonly {
    data: Record<string | symbol, unknown>;
  }[],
): Edge | null {
  if (!records.length) return null;
  return extractClosestEdge(records[0].data);
}

export function extractDragMeta<TMeta extends DragMeta = DragMeta>(
  data: Record<string | symbol, unknown>,
): TMeta {
  const meta: Record<symbol, unknown> = {};
  for (const sym of Object.getOwnPropertySymbols(data)) {
    if (sym === DRAG_DATA_KEY) continue;
    meta[sym] = data[sym];
  }
  return meta as TMeta;
}
