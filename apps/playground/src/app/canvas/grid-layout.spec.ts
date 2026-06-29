import { signal } from '@angular/core';

import {
  compactGrid,
  gridCollides,
  gridLayout,
  moveGridItem,
  type GridItem,
} from './grid-layout';

const it_ = (id: string, x: number, y: number, w = 2, h = 2): GridItem => ({
  id,
  x,
  y,
  w,
  h,
});

describe('gridCollides', () => {
  it('detects overlap and ignores identity-equal / separated items', () => {
    expect(gridCollides(it_('a', 0, 0), it_('b', 1, 1))).toBe(true);
    expect(gridCollides(it_('a', 0, 0), it_('b', 2, 0))).toBe(false);
    expect(gridCollides(it_('a', 0, 0), it_('a', 0, 0))).toBe(false);
  });
});

describe('compactGrid', () => {
  it('pulls a floating item up to the top', () => {
    expect(compactGrid([it_('a', 0, 5)])[0].y).toBe(0);
  });

  it('stacks items without gaps', () => {
    const out = compactGrid([it_('a', 0, 0), it_('b', 0, 5)]);
    expect(out.find((i) => i.id === 'b')?.y).toBe(2);
  });

  it('keeps the fixed (dragged) item at its row', () => {
    const out = compactGrid([it_('a', 0, 3), it_('b', 0, 6)], 'a');
    expect(out.find((i) => i.id === 'a')?.y).toBe(3);
  });
});

describe('moveGridItem', () => {
  it('pushes colliding items down to make room', () => {
    const items = [it_('a', 0, 0), it_('b', 0, 2)];
    const out = moveGridItem(items, 'a', 0, 2, 4); // drop a onto b
    expect(out.find((i) => i.id === 'a')).toMatchObject({ x: 0, y: 2 });
    expect(out.find((i) => i.id === 'b')?.y).toBe(4);
  });

  it('clamps within the column count', () => {
    const out = moveGridItem([it_('a', 0, 0)], 'a', 99, 0, 4);
    expect(out[0].x).toBe(2); // cols 4 - w 2
  });

  it('cascades pushes through a stack', () => {
    const items = [it_('a', 0, 0), it_('b', 0, 2), it_('c', 0, 4)];
    const out = moveGridItem(items, 'a', 0, 2, 4);
    const by = (id: string) => out.find((i) => i.id === id)?.y;
    expect(by('a')).toBe(2);
    expect(by('b')).toBe(4);
    expect(by('c')).toBe(6);
  });

  it('returns items unchanged for an unknown id', () => {
    const items = [it_('a', 0, 0)];
    expect(moveGridItem(items, 'zzz', 1, 1, 4)).toEqual(items);
  });
});

describe('gridLayout', () => {
  it('reflows via move and tracks row count', () => {
    const items = signal<GridItem[]>([it_('a', 0, 0), it_('b', 0, 2)]);
    const grid = gridLayout(items, { cols: 4 });
    grid.move('a', 0, 2);
    expect(items().find((i) => i.id === 'b')?.y).toBe(4);
    expect(grid.rows()).toBe(6); // b at y4 + h2
  });

  it('compacts on add and remove', () => {
    const items = signal<GridItem[]>([it_('a', 0, 0)]);
    const grid = gridLayout(items, { cols: 4 });
    grid.add(it_('b', 0, 9));
    expect(items().find((i) => i.id === 'b')?.y).toBe(2);
    grid.remove('a');
    expect(items().find((i) => i.id === 'b')?.y).toBe(0);
  });
});
