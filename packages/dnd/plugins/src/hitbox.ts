import type { Edge } from '@mmstack/dnd';

const CLOSEST_EDGE = Symbol('@mmstack/dnd:closest-edge');

/**
 * A zero-dependency `hitbox` plugin: closest-edge detection for edge-aware drops
 * (`dropTarget({ edges })`). `attachClosestEdge` stamps the nearest allowed edge
 * (by perpendicular distance from the pointer to the target's rect) onto the drag
 * data; `extractClosestEdge` reads it back. A drop-in alternative to pragmatic's
 * `@atlaskit/pragmatic-drag-and-drop-hitbox` that needs no extra dependency.
 *
 * Register via `provideDnd({ plugins: { hitbox: closestEdge } })`.
 *
 * Note: the `reorderable` engine does NOT use this — it derives its insert from
 * item centers. This is only for standalone edge-aware `dropTarget`s.
 */
export const closestEdge = {
  attachClosestEdge(
    data: Record<string | symbol, unknown>,
    {
      element,
      input,
      allowedEdges,
    }: {
      element: Element;
      input: { clientX: number; clientY: number };
      allowedEdges: Edge[];
    },
  ): Record<string | symbol, unknown> {
    const r = element.getBoundingClientRect();
    let best: Edge | null = null;
    let min = Infinity;
    for (const edge of allowedEdges) {
      const d =
        edge === 'top'
          ? Math.abs(input.clientY - r.top)
          : edge === 'bottom'
            ? Math.abs(input.clientY - r.bottom)
            : edge === 'left'
              ? Math.abs(input.clientX - r.left)
              : Math.abs(input.clientX - r.right);
      if (d < min) {
        min = d;
        best = edge;
      }
    }
    return { ...data, [CLOSEST_EDGE]: best };
  },
  extractClosestEdge(data: Record<string | symbol, unknown>): Edge | null {
    return (data[CLOSEST_EDGE] as Edge | undefined) ?? null;
  },
};
