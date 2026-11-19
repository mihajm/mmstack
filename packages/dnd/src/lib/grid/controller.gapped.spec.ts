import { effect, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

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
/** 50px cells, 10px gap (a 60px step), container at (100, 40); grabbed on a's first cell. */
const GAPPED: PlacementDragSnapshot = {
  ...SNAP,
  gap: 10,
  originX: 100,
  originY: 40,
  startX: 125,
  startY: 65,
};
/** a's bottom-right corner in the gapped grid: 2 cells + 1 gap from the origin. */
const gappedResize = (direction: 'e' | 's' | 'se'): PlacementDragSnapshot => ({
  ...GAPPED,
  kind: 'resize',
  direction,
  startX: 100 + 110,
  startY: 40 + 110,
});
const resizeSnap = (
  direction: 'e' | 's' | 'se',
  startX = 100,
  startY = 100,
): PlacementDragSnapshot => ({
  ...SNAP,
  kind: 'resize',
  direction,
  startX,
  startY,
});

function setup(opts: Partial<PlacementGridOptions<Widget, string>> = {}) {
  const source = signal<Widget[]>([
    w_('a', 0, 0),
    w_('b', 2, 0),
    w_('c', 0, 2, 4, 2),
  ]);
  const grid = placementGrid(source, { key, cols: 6, ...opts });
  return { source, grid };
}

describe('placementGrid: resolved options', () => {
  it('keyboard and activationThreshold default to true and 5, and take custom values', () => {
    expect(setup().grid.keyboard).toBe(true);
    expect(setup({ keyboard: false }).grid.keyboard).toBe(false);
    expect(setup().grid.activationThreshold).toBe(5);
    expect(setup({ activationThreshold: 12 }).grid.activationThreshold).toBe(
      12,
    );
  });

  it('announcePlace defaults to a 1-based column/row message, keeps a custom one, and false is off', () => {
    const { grid } = setup();
    const msg = grid.announcePlace!({
      item: w_('a', 0, 2),
      x: 0,
      y: 2,
      w: 2,
      h: 2,
    });
    expect(msg).toBe('Moved to column 1, row 3');
    const fn = () => 'custom';
    expect(setup({ announcePlace: fn }).grid.announcePlace).toBe(fn);
    expect(setup({ announcePlace: false }).grid.announcePlace).toBeNull();
  });

  it('animation defaults to 200ms with an easing, takes custom values, and false is off', () => {
    const def = setup().grid.animation;
    expect(def?.duration).toBe(200);
    expect(def?.easing).toBeTruthy();
    expect(
      setup({ animation: { duration: 50, easing: 'linear' } }).grid.animation,
    ).toEqual({
      duration: 50,
      easing: 'linear',
    });
    expect(setup({ animation: false }).grid.animation).toBeNull();
  });

  it('animation: false never glides a sibling during a drag', () => {
    const { source, grid } = setup({ animation: false });
    const sb = grid.itemState(() => source()[1]);
    grid.begin('a', SNAP);
    expect(sb.transitionCss()).toBe('none');
  });

  it('autoScroll fills edge 48 and speed 16, keeps custom values, and is off unless set', () => {
    expect(setup({ autoScroll: {} }).grid.autoScroll).toMatchObject({
      edge: 48,
      speed: 16,
    });
    expect(
      setup({ autoScroll: { edge: 20, speed: 5 } }).grid.autoScroll,
    ).toMatchObject({
      edge: 20,
      speed: 5,
    });
    expect(setup().grid.autoScroll).toBeNull();
  });
});

describe('placementGrid: projection on a gapped, offset grid', () => {
  it('a move steps by cell plus gap and measures from the container origin', () => {
    const { grid } = setup({ gap: 10 });
    grid.begin('a', GAPPED);
    grid.move({ x: 125 + 120, y: 65 + 120 });
    expect(grid.projectedCell()).toEqual({ x: 2, y: 2 });
    grid.move({ x: 125 + 100, y: 65 });
    expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
  });

  it('a resize rounds spans by cell plus gap', () => {
    const { grid } = setup({ gap: 10 });
    const a = () => at(grid.previewLayout(), 'a');
    grid.begin('a', gappedResize('se'));
    grid.move({ x: 210 + 20, y: 150 + 20 });
    expect(a()).toMatchObject({ w: 2, h: 2 });
    grid.move({ x: 210 + 40, y: 150 + 40 });
    expect(a()).toMatchObject({ w: 3, h: 3 });
  });

  it('the drag-start box spans every column and gap of the grid', () => {
    const { grid } = setup({ gap: 10 });
    grid.begin('a', {
      ...GAPPED,
      originX: 0,
      originY: 0,
      startX: 25,
      startY: 25,
    });
    grid.move({ x: 349, y: 25 });
    expect(grid.dropOutside()).toBe(false);
    grid.move({ x: 351, y: 25 });
    expect(grid.dropOutside()).toBe(true);
    // 4 rows plus the dragged item's 2-row band: 6 rows, 5 gaps
    grid.move({ x: 25, y: 349 });
    expect(grid.dropOutside()).toBe(false);
    grid.move({ x: 25, y: 351 });
    expect(grid.dropOutside()).toBe(true);
  });

  it('outside is judged from the container origin', () => {
    const { grid } = setup();
    grid.begin('a', {
      ...SNAP,
      originX: 100,
      originY: 40,
      startX: 125,
      startY: 65,
    });
    grid.move({ x: 390, y: 65 });
    expect(grid.dropOutside()).toBe(false);
    grid.move({ x: 420, y: 65 });
    expect(grid.dropOutside()).toBe(true);
  });

  it('horizontal and vertical scroll deltas move the projection and the hit test', () => {
    const { grid } = setup();
    grid.begin('a', SNAP);
    grid.move({ x: 25, y: 25 });
    grid.setScrollDelta(100, 0);
    expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
    grid.setScrollDelta(0, 100);
    expect(grid.projectedCell()).toEqual({ x: 0, y: 2 });
    grid.setScrollDelta(0, 0);
    grid.move({ x: 290, y: 25 });
    expect(grid.dropOutside()).toBe(false);
    grid.setScrollDelta(30, 0);
    expect(grid.dropOutside()).toBe(true);
  });

  it('a negative horizontal scroll pulls the projection back', () => {
    const { grid } = setup();
    grid.begin('a', SNAP);
    grid.move({ x: 225, y: 25 });
    grid.setScrollDelta(-100, 0);
    expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
  });
});

describe('placementGrid: derivations read idle first, then dragged', () => {
  let injector: Injector;
  beforeEach(() => {
    injector = TestBed.inject(Injector);
  });

  it('projectedCell read idle still follows a drag that starts on the pointer origin', () => {
    const { grid } = setup();
    expect(grid.projectedCell()).toBeNull();
    grid.begin('a', { ...SNAP, startX: 0, startY: 0 });
    expect(grid.projectedCell()).toEqual({ x: 0, y: 0 });
  });

  it('dropOutside read idle still flips during a drag; the outside release writes nothing', () => {
    const { source, grid } = setup();
    const before = source();
    expect(grid.dropOutside()).toBe(false);
    grid.begin('a', SNAP);
    grid.move({ x: 25, y: 2000 });
    expect(grid.dropOutside()).toBe(true);
    grid.end();
    expect(source()).toBe(before);
  });

  it('targetMask is null idle and for vertical grids; a compact-none mask read idle appears on begin', () => {
    const vertical = setup();
    expect(vertical.grid.targetMask()).toBeNull();
    vertical.grid.begin('a', SNAP);
    expect(vertical.grid.targetMask()).toBeNull();

    const none = setup({ compact: 'none' });
    expect(none.grid.targetMask()).toBeNull();
    none.grid.begin('a', SNAP);
    expect(none.grid.targetMask()).not.toBeNull();
  });

  it('a resize preview renotifies only when the spans change', () => {
    const { grid } = setup();
    grid.begin('a', resizeSnap('se'));
    let runs = 0;
    effect(
      () => {
        grid.previewLayout();
        runs++;
      },
      { injector },
    );
    TestBed.tick();
    runs = 0;
    grid.move({ x: 105, y: 108 });
    grid.move({ x: 110, y: 112 });
    TestBed.tick();
    expect(runs).toBe(0);
    grid.move({ x: 150, y: 100 });
    TestBed.tick();
    expect(runs).toBe(1);
  });

  it('a resize preview follows a change on one axis only', () => {
    const e = setup();
    e.grid.begin('a', resizeSnap('e'));
    e.grid.previewLayout();
    e.grid.move({ x: 200, y: 100 });
    expect(at(e.grid.previewLayout(), 'a')).toMatchObject({ w: 4, h: 2 });

    const s = setup();
    s.grid.begin('a', resizeSnap('s'));
    s.grid.previewLayout();
    s.grid.move({ x: 100, y: 200 });
    expect(at(s.grid.previewLayout(), 'a')).toMatchObject({ w: 2, h: 4 });
  });
});

describe('placementGrid: compact none previews', () => {
  it('a resize is clamped by the columns right of the item, not by its own column', () => {
    const { grid } = setup({ compact: 'none' });
    grid.begin('b', { ...resizeSnap('e'), startX: 200 });
    grid.move({ x: 9999, y: 100 });
    expect(at(grid.previewLayout(), 'b')?.w).toBe(4);
  });

  it("a resize into a neighbour keeps the item's spans", () => {
    const { grid } = setup({ compact: 'none' });
    grid.begin('a', resizeSnap('e'));
    grid.move({ x: 200, y: 100 });
    expect(at(grid.previewLayout(), 'a')?.w).toBe(2);
  });

  it('a rejected resize frame keeps the last valid spans for the release', () => {
    const source = signal<Widget[]>([
      w_('a', 0, 0),
      w_('b', 2, 0),
      w_('c', 0, 2, 4, 2),
      w_('d', 5, 0, 1, 1),
    ]);
    const onResize = vi.fn();
    const grid = placementGrid(source, {
      key,
      cols: 6,
      compact: 'none',
      onResize,
    });
    grid.begin('b', { ...resizeSnap('e'), startX: 200 });
    grid.move({ x: 250, y: 100 });
    expect(at(grid.previewLayout(), 'b')?.w).toBe(3);
    grid.move({ x: 300, y: 100 });
    expect(at(grid.previewLayout(), 'b')?.w).toBe(3);
    grid.end();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0][0]).toMatchObject({ w: 3 });
  });

  it('a first frame on an occupied cell previews the source and does not throw', () => {
    const move = setup({ compact: 'none' });
    move.grid.begin('a', SNAP);
    move.grid.move({ x: 125, y: 25 });
    expect(move.grid.projectedCell()).toBeNull();
    expect(move.grid.previewLayout()).toBe(move.source());

    const resize = setup({ compact: 'none' });
    resize.grid.begin('a', resizeSnap('e'));
    resize.grid.move({ x: 200, y: 100 });
    expect(resize.grid.previewLayout()).toBe(resize.source());
  });

  it('rows do not grow during a resize', () => {
    const { grid } = setup({ compact: 'none' });
    grid.begin('a', resizeSnap('e'));
    expect(grid.rows()).toBe(4);
  });

  it('a commit keeps the dropped row: no gravity', () => {
    const { source, grid } = setup({ compact: 'none' });
    grid.begin('a', SNAP);
    grid.move({ x: 225, y: 125 });
    grid.end();
    expect(at(source(), 'a')).toMatchObject({ x: 4, y: 2 });
  });

  it('a move never compacts the other items', () => {
    const b0 = w_('b', 0, 1, 1, 1);
    const source = signal<Widget[]>([w_('a', 0, 0, 1, 1), b0]);
    const grid = placementGrid(source, { key, cols: 6, compact: 'none' });
    grid.begin('a', SNAP);
    grid.move({ x: 125, y: 25 });
    expect(at(grid.previewLayout(), 'b')).toBe(b0);
    grid.end();
    expect(at(source(), 'a')).toMatchObject({ x: 2, y: 0 });
    expect(at(source(), 'b')).toBe(b0);
  });
});

describe('placementGrid: item states during a drag with a peer write', () => {
  it('outside the grid, items show their drag-start cells even after a peer prepend', () => {
    const { source, grid } = setup();
    const sb = grid.itemState(() => at(source(), 'b')!);
    grid.begin('a', SNAP);
    source.update((arr) => [w_('d', 5, 5, 1, 1), ...arr]);
    grid.move({ x: 25, y: 2000 });
    expect(grid.dropOutside()).toBe(true);
    expect(sb.cellX()).toBe(2);
  });

  it('inside the grid, the preview is keyed by the drag-start handles', () => {
    const { source, grid } = setup();
    const sb = grid.itemState(() => at(source(), 'b')!);
    grid.begin('a', SNAP);
    source.update((arr) => [w_('d', 5, 5, 1, 1), ...arr]);
    grid.move({ x: 225, y: 25 });
    expect(sb.cellX()).toBe(2);
    expect(sb.cellY()).toBe(0);
  });

  it('a neighbour follows the preview reflow', () => {
    const { source, grid } = setup();
    const sb = grid.itemState(() => at(source(), 'b')!);
    grid.begin('a', SNAP);
    grid.move({ x: 125, y: 25 });
    expect(sb.cellY()).toBe(2);
  });
});

describe('placementGrid: a refused first frame after a peer write', () => {
  it('previews the drag-start layout, not the live source', () => {
    const { source, grid } = setup({ compact: 'none' });
    const start = source();
    grid.begin('a', SNAP);
    source.update((arr) => [w_('d', 5, 5, 1, 1), ...arr]);
    grid.move({ x: 125, y: 25 });
    expect(grid.previewLayout()).toBe(start);
  });
});
