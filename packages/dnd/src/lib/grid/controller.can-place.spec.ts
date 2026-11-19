import { signal } from '@angular/core';

import {
  placementGrid,
  type PlacementDragSnapshot,
  type PlacementGridOptions,
} from './controller';
import type { GridPlacement } from './layout';

type Widget = GridPlacement & { id: string };
const key = (w: Widget) => w.id;
const w_ = (id: string, x: number, y: number, w = 2, h = 2): Widget => ({
  id,
  x,
  y,
  w,
  h,
});
const at = (arr: readonly Widget[], id: string) => arr.find((i) => i.id === id);

const SNAP: PlacementDragSnapshot = {
  kind: 'move',
  originX: 0,
  originY: 0,
  cellW: 50,
  cellH: 50,
  gap: 0,
  startX: 25,
  startY: 25,
};
/** a's bottom-right corner, grabbed by a resize grip. */
const resizeA = (direction: 'e' | 's' | 'se'): PlacementDragSnapshot => ({
  ...SNAP,
  kind: 'resize',
  direction,
  startX: 100,
  startY: 100,
});

type Call = { id: string; x: number; y: number; w: number; h: number };
function setup(
  rule: (c: Call) => boolean,
  opts: Partial<PlacementGridOptions<Widget, string>> = {},
) {
  const source = signal<Widget[]>([
    w_('a', 0, 0),
    w_('b', 2, 0),
    w_('c', 0, 2, 4, 2),
  ]);
  const calls: Call[] = [];
  const onResize = vi.fn();
  const grid = placementGrid(source, {
    key,
    cols: 6,
    onResize,
    canPlace: (item, x, y) => {
      const c = { id: item.id, x, y, w: item.w, h: item.h };
      calls.push(c);
      return rule(c);
    },
    ...opts,
  });
  return { source, grid, calls, onResize };
}

describe('placementGrid: canPlace is consulted on resize, with the candidate spans', () => {
  for (const compact of ['vertical', 'none'] as const) {
    describe(`compact: ${compact}`, () => {
      it('a pointer resize asks canPlace with the item at its own cell and the candidate w/h', () => {
        const { grid, calls } = setup(() => true, { compact });
        grid.begin('c', { ...resizeA('s'), startY: 200 });
        grid.move({ x: 100, y: 250 });
        expect(grid.previewLayout().find((i) => i.id === 'c')?.h).toBe(3);
        expect(calls).toContainEqual({ id: 'c', x: 0, y: 2, w: 4, h: 3 });
      });

      it('a refused pointer resize keeps the last allowed spans and commits them', () => {
        const { source, grid, onResize } = setup((c) => c.h <= 3, { compact });
        grid.begin('c', { ...resizeA('s'), startY: 200 });
        grid.move({ x: 100, y: 250 }); // h 3: allowed
        grid.previewLayout();
        grid.move({ x: 100, y: 300 }); // h 4: refused
        expect(grid.previewLayout().find((i) => i.id === 'c')?.h).toBe(3);
        grid.end();
        expect(at(source(), 'c')?.h).toBe(3);
        expect(onResize).toHaveBeenCalledTimes(1);
      });

      it('a resize refused from the first frame commits nothing', () => {
        const { source, grid, onResize } = setup((c) => c.h <= 2, { compact });
        const before = source();
        grid.begin('c', { ...resizeA('s'), startY: 200 });
        grid.move({ x: 100, y: 250 });
        expect(grid.previewLayout()).toBe(before);
        grid.end();
        expect(source()).toBe(before);
        expect(onResize).not.toHaveBeenCalled();
      });

      it('the release re-asks canPlace: a rule that flips mid-drag makes the drop a no-op', () => {
        let allow = true;
        const { source, grid, onResize } = setup(() => allow, { compact });
        const before = source();
        grid.begin('c', { ...resizeA('s'), startY: 200 });
        grid.move({ x: 100, y: 250 });
        expect(grid.previewLayout().find((i) => i.id === 'c')?.h).toBe(3);
        allow = false;
        grid.end();
        expect(source()).toBe(before);
        expect(onResize).not.toHaveBeenCalled();
      });

      it('resizeBy asks canPlace with the candidate spans and honours a refusal', () => {
        const { source, grid, calls, onResize } = setup((c) => c.h <= 3, {
          compact,
        });
        expect(grid.resizeBy('c', 0, 1)).toBe(true);
        expect(calls).toContainEqual({ id: 'c', x: 0, y: 2, w: 4, h: 3 });
        const before = source();
        expect(grid.resizeBy('c', 0, 1)).toBe(false);
        expect(calls).toContainEqual({ id: 'c', x: 0, y: 2, w: 4, h: 4 });
        expect(source()).toBe(before);
        expect(onResize).toHaveBeenCalledTimes(1);
      });
    });
  }
});
