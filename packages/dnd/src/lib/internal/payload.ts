import type { HitboxPlugin } from '../provide';
import type { DragMeta, DropTargetInfo, Edge } from './types';

/**
 * @internal Private symbol that user payloads are "boxed" under before being
 * handed to pragmatic, so our data never collides with a consumer's own keys (or
 * with the closest-edge token a hitbox plugin attaches). A drag source's data and
 * a drop target's self data live on separate pragmatic records, so one key serves
 * both.
 */
const DATA_KEY = Symbol('@mmstack/dnd:data');

/** Boxes `data` under the private symbol before handing it to pragmatic (handy in tests). */
export function boxData<T>(data: T): Record<string | symbol, unknown> {
  return { [DATA_KEY]: data };
}

/** Recovers boxed `data` (inverse of {@link boxData}). */
export function unboxData<T>(
  data: Record<string | symbol, unknown>,
): T | undefined {
  return data[DATA_KEY] as T | undefined;
}

/** @internal Maps pragmatic's drop-target stack into unboxed {@link DropTargetInfo}. */
export function mapDropTargets(
  records: readonly {
    element: Element;
    data: Record<string | symbol, unknown>;
  }[],
): DropTargetInfo[] {
  return records.map((r) => ({
    element: r.element,
    data: unboxData(r.data),
  }));
}

/** @internal Reads the closest-edge token off the innermost target's data, if a hitbox is present. */
export function extractEdge(
  records: readonly { data: Record<string | symbol, unknown> }[],
  hitbox: HitboxPlugin | null,
): Edge | null {
  return records.length && hitbox
    ? hitbox.extractClosestEdge(records[0].data)
    : null;
}

/** @internal Pulls the symbol-keyed metadata back out, excluding our own boxed data. */
export function extractDragMeta<TMeta extends DragMeta = DragMeta>(
  data: Record<string | symbol, unknown>,
): TMeta {
  const meta: Record<symbol, unknown> = {};
  for (const sym of Object.getOwnPropertySymbols(data)) {
    if (sym === DATA_KEY) continue;
    meta[sym] = data[sym];
  }
  return meta as TMeta;
}
