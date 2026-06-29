import type { Box } from './geometry';

/**
 * An active alignment guide (snapline). `axis: 'x'` is a vertical line at
 * `position` spanning `from`→`to` on the y axis; `axis: 'y'` is horizontal.
 */
export type Guide = {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
};

const EPS = 0.5;

function xEdges(b: Box): [number, number, number] {
  return [b.x, b.x + b.width / 2, b.x + b.width];
}
function yEdges(b: Box): [number, number, number] {
  return [b.y, b.y + b.height / 2, b.y + b.height];
}

/** Smallest within-threshold offset that aligns any moving edge to any target edge. */
function bestOffset(
  movingEdges: readonly number[],
  targetEdges: readonly (readonly number[])[],
  threshold: number,
): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const me of movingEdges) {
    for (const edges of targetEdges) {
      for (const te of edges) {
        const d = te - me;
        const a = Math.abs(d);
        if (a <= threshold && a < bestAbs) {
          bestAbs = a;
          best = d;
        }
      }
    }
  }
  return best;
}

/** Smallest within-threshold target edge for a single moving edge, or `null`. */
export function nearestEdge(
  value: number,
  candidates: readonly number[],
  threshold: number,
): number | null {
  let best: number | null = null;
  let bestAbs = Infinity;
  for (const c of candidates) {
    const a = Math.abs(c - value);
    if (a <= threshold && a < bestAbs) {
      bestAbs = a;
      best = c;
    }
  }
  return best;
}

function mergeGuides(guides: Guide[]): Guide[] {
  const byKey = new Map<string, Guide>();
  for (const g of guides) {
    const key = `${g.axis}:${Math.round(g.position)}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...g });
    else {
      prev.from = Math.min(prev.from, g.from);
      prev.to = Math.max(prev.to, g.to);
    }
  }
  return [...byKey.values()];
}

/**
 * Snaps `box` so its edges/centers align to nearby `targets` (and optional
 * `canvas` edges) within `threshold`, returning the adjusted box plus the active
 * guide lines to render. Pure — the Figma/Squarespace snapline behaviour.
 */
export function snapToTargets(
  box: Box,
  targets: readonly Box[],
  threshold = 6,
  canvas?: Box,
): { box: Box; guides: Guide[] } {
  const all = canvas ? [...targets, canvas] : targets;
  if (!all.length) return { box, guides: [] };

  const tx = all.map(xEdges);
  const ty = all.map(yEdges);

  const dx = bestOffset(xEdges(box), tx, threshold);
  const dy = bestOffset(yEdges(box), ty, threshold);
  const snapped: Box = { ...box, x: box.x + dx, y: box.y + dy };

  return { box: snapped, guides: collectGuides(snapped, all) };
}

/**
 * Guide lines for every edge/center of `box` that coincides with a target's, each
 * spanning both boxes. Shared by move (`snapToTargets`) and resize snapping.
 */
export function collectGuides(box: Box, targets: readonly Box[]): Guide[] {
  const guides: Guide[] = [];
  const mx = xEdges(box);
  const my = yEdges(box);
  for (const t of targets) {
    const txe = xEdges(t);
    const tye = yEdges(t);
    for (const me of mx) {
      for (const te of txe) {
        if (Math.abs(me - te) <= EPS) {
          guides.push({
            axis: 'x',
            position: te,
            from: Math.min(box.y, t.y),
            to: Math.max(box.y + box.height, t.y + t.height),
          });
        }
      }
    }
    for (const me of my) {
      for (const te of tye) {
        if (Math.abs(me - te) <= EPS) {
          guides.push({
            axis: 'y',
            position: te,
            from: Math.min(box.x, t.x),
            to: Math.max(box.x + box.width, t.x + t.width),
          });
        }
      }
    }
  }
  return mergeGuides(guides);
}
