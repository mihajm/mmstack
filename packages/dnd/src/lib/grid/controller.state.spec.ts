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
const container = (width = 300) =>
  ({
    getBoundingClientRect: () => ({ top: 0, left: 0, width, height: 300 }),
  }) as unknown as HTMLElement;

function setup(opts: Partial<PlacementGridOptions<Widget, string>> = {}) {
  const source = signal<Widget[]>([
    w_('a', 0, 0),
    w_('b', 2, 0),
    w_('c', 0, 2, 4, 2),
  ]);
  const grid = placementGrid(source, { key, cols: 6, ...opts });
  const state = (id: string) => grid.itemState(() => at(source(), id)!);
  return { source, grid, state };
}

describe('placementGrid: itemState', () => {
  it('itemKey is the item key; at rest nothing is active, dragX/dragY are 0 and nothing glides', () => {
    const { grid, source, state } = setup();
    expect(grid.itemState(() => source()[1]).itemKey()).toBe('b');
    const sa = state('a');
    expect(sa.isActive()).toBe(false);
    expect(sa.dragX()).toBe(0);
    expect(sa.dragY()).toBe(0);
    expect(state('b').transitionCss()).toBe('none');
  });

  it('during a move the dragged item is active and its neighbours follow the preview', () => {
    const { grid, state } = setup();
    const sa = state('a');
    const sb = state('b');
    grid.begin('a', SNAP);
    grid.move({ x: 125, y: 25 });
    expect(sa.isActive()).toBe(true);
    expect(sb.isActive()).toBe(false);
    expect([sb.cellX(), sb.cellY()]).toEqual([2, 2]);
  });

  it('during a resize the cell rect signals show the previewed spans', () => {
    const { grid, state } = setup();
    const sa = state('a');
    const sb = state('b');
    grid.begin('a', { ...SNAP, kind: 'resize', direction: 'se' });
    grid.move({ x: 125, y: 75 });
    expect([sa.cellX(), sa.cellY(), sa.spanW(), sa.spanH()]).toEqual([
      0, 0, 4, 3,
    ]);
    expect([sb.cellX(), sb.cellY(), sb.spanW(), sb.spanH()]).toEqual([
      2, 3, 2, 2,
    ]);
    expect(grid.projectedCell()).toBeNull();
  });

  it('siblings glide with the configured animation only while a drag runs', () => {
    const { grid, state } = setup();
    const sb = state('b');
    grid.begin('a', SNAP);
    expect(sb.transitionCss()).toContain('transform');
    expect(sb.transitionCss()).toContain('200ms');
    expect(state('a').transitionCss()).toBe('none');
    grid.cancel();
    expect(sb.transitionCss()).toBe('none');

    const slow = setup({ animation: { duration: 90 } });
    const sb2 = slow.state('b');
    slow.grid.begin('a', SNAP);
    expect(sb2.transitionCss()).toContain('90ms');
  });

  it('dragX/dragY free-follow the pointer from the item cell, scroll included', () => {
    const { grid, state } = setup();
    const sa = state('a');
    grid.begin('a', SNAP);
    grid.move({ x: 60, y: 70 });
    expect(sa.dragX()).toBe(35);
    expect(sa.dragY()).toBe(45);
    grid.setScrollDelta(40, 0);
    expect(sa.dragX()).toBe(75);
    grid.setScrollDelta(0, 40);
    expect(sa.dragY()).toBe(85);
    grid.cancel();

    const sb = state('b');
    grid.begin('b', { ...SNAP, startX: 125 });
    grid.move({ x: 160, y: 25 });
    expect(sb.dragX()).toBe(135);
    grid.cancel();

    const sc = state('c');
    grid.begin('c', { ...SNAP, startY: 125 });
    grid.move({ x: 25, y: 150 });
    expect(sc.dragY()).toBe(125);
  });

  it('an element binds the state to its own occurrence of a repeated reference', () => {
    const obj = w_('a', 0, 0, 1, 1);
    const source = signal<Widget[]>([obj, w_('z', 2, 0), obj]);
    const grid = placementGrid(source, { key, cols: 6, compact: 'none' });
    const el0 = document.createElement('div');
    const el2 = document.createElement('div');
    grid.register('a', el0, obj);
    grid.register('a', el2, obj);
    const s0 = grid.itemState(() => obj, el0);
    const s2 = grid.itemState(() => obj, el2);
    grid.begin(grid.keyForElement(el2)!, SNAP);
    expect(s2.isActive()).toBe(true);
    expect(s0.isActive()).toBe(false);
  });

  it('a registered element makes its state active for that handle', () => {
    const { grid, source } = setup();
    const el = document.createElement('div');
    grid.register('a', el, source()[0]);
    const s = grid.itemState(() => source()[0], el);
    grid.begin('a', SNAP);
    expect(s.isActive()).toBe(true);
  });
});

describe('placementGrid: registration and lookups', () => {
  it('unregister drops the element binding; indexOf finds the live position', () => {
    const { grid, source } = setup();
    const el = document.createElement('div');
    grid.register('a', el, source()[0]);
    expect(grid.keyForElement(el)).toBe('a');
    grid.unregister('a', el);
    expect(grid.keyForElement(el)).toBeUndefined();
    expect(grid.indexOf('b')).toBe(1);
    expect(grid.indexOf('nope')).toBe(-1);
  });

  it('begin with an unknown handle starts nothing', () => {
    const { grid } = setup();
    grid.begin('zzz', SNAP);
    expect(grid.activeKey()).toBeNull();
  });

  it('the first projection starts from the grab point, so an immediate release writes nothing', () => {
    const { source, grid } = setup();
    const before = source();
    grid.begin('b', { ...SNAP, startX: 125, startY: 25 });
    expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
    grid.end();
    expect(source()).toBe(before);
  });

  it('a release with every cell refused writes nothing and ends the drag', () => {
    const { source, grid } = setup({ canPlace: () => false });
    const before = source();
    grid.begin('a', SNAP);
    grid.move({ x: 225, y: 25 });
    expect(() => grid.end()).not.toThrow();
    expect(source()).toBe(before);
    expect(grid.activeKey()).toBeNull();
  });
});

describe('placementGrid: keyboard commits under compact none', () => {
  it('moveBy and resizeBy refuse an unknown handle', () => {
    const { source, grid } = setup();
    const before = source();
    expect(grid.moveBy('nope', 1, 0)).toBe(false);
    expect(grid.resizeBy('nope', 1, 0)).toBe(false);
    expect(source()).toBe(before);
  });

  it('moveBy clamps into the columns and never above row 0', () => {
    const { source, grid } = setup({ compact: 'none' });
    expect(grid.moveBy('a', 10, 0)).toBe(true);
    expect(at(source(), 'a')).toMatchObject({ x: 4, y: 0 });
  });

  it('a step down reports the move with no displaced items', () => {
    const onPlace = vi.fn();
    const { source, grid } = setup({ compact: 'none', onPlace });
    const c0 = at(source(), 'c');
    expect(grid.moveBy('c', 0, 1)).toBe(true);
    expect(at(source(), 'c')).toMatchObject({ x: 0, y: 3 });
    expect(onPlace).toHaveBeenCalledWith({
      item: c0,
      x: 0,
      y: 3,
      items: source(),
      displaced: [],
    });
    const plain = setup({ compact: 'none' });
    expect(plain.grid.moveBy('c', 0, 1)).toBe(true);
  });

  it('resizeBy clamps the width to the columns right of the item', () => {
    const { source, grid } = setup({ compact: 'none' });
    expect(grid.resizeBy('c', 5, 0)).toBe(true);
    expect(at(source(), 'c')?.w).toBe(6);
  });

  it('a clamped no-op resize writes nothing and fires nothing', () => {
    const onResize = vi.fn();
    const { source, grid } = setup({ compact: 'none', onResize });
    expect(grid.resizeBy('a', -5, 0)).toBe(true);
    const after = source();
    expect(grid.resizeBy('a', -1, 0)).toBe(false);
    expect(source()).toBe(after);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('a grow reports the resize with no displaced items', () => {
    const onResize = vi.fn();
    const { source, grid } = setup({ compact: 'none', onResize });
    const c0 = at(source(), 'c');
    expect(grid.resizeBy('c', 1, 0)).toBe(true);
    expect(at(source(), 'c')?.w).toBe(5);
    expect(onResize).toHaveBeenCalledWith({
      item: c0,
      w: 5,
      h: 2,
      items: source(),
      displaced: [],
    });
    const plain = setup({ compact: 'none' });
    expect(plain.grid.resizeBy('c', 1, 0)).toBe(true);
  });
});

describe('placementGrid: pointer resizes under compact none', () => {
  it('a grow into free space commits once with the new height', () => {
    const onResize = vi.fn();
    const { source, grid } = setup({ compact: 'none', onResize });
    grid.begin('c', {
      ...SNAP,
      kind: 'resize',
      direction: 's',
      startX: 100,
      startY: 175,
    });
    grid.move({ x: 100, y: 225 });
    grid.end();
    expect(at(source(), 'c')?.h).toBe(3);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0][0]).toMatchObject({ h: 3 });
  });

  it('a cell a peer took mid-resize makes the release a no-op', () => {
    const onResize = vi.fn();
    const { source, grid } = setup({ compact: 'none', onResize });
    grid.begin('c', {
      ...SNAP,
      kind: 'resize',
      direction: 's',
      startX: 100,
      startY: 175,
    });
    grid.move({ x: 100, y: 225 });
    grid.previewLayout();
    source.update((arr) => [...arr, w_('d', 0, 4, 1, 1)]);
    const live = source();
    grid.end();
    expect(source()).toBe(live);
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('placementGrid: DOM-edge gestures measure the container', () => {
  it('beginGesture measures cell and gap from the container width', () => {
    const { grid } = setup({ gap: 10 });
    grid.setContainer(container(350));
    grid.beginGesture('a', { x: 25, y: 25 });
    grid.move({ x: 145, y: 25 });
    expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
  });

  it('beginGesture starts a move: a release far outside writes nothing', () => {
    const { source, grid } = setup();
    grid.setContainer(container());
    const before = source();
    grid.beginGesture('a', { x: 25, y: 25 });
    grid.move({ x: 25, y: 900 });
    expect(grid.dropOutside()).toBe(true);
    grid.end();
    expect(source()).toBe(before);
  });

  it('beginResizeGesture starts a resize in the given direction', () => {
    const onResize = vi.fn();
    const { source, grid } = setup({ compact: 'none', onResize });
    grid.setContainer(container());
    grid.beginResizeGesture('b', 'e', { x: 200, y: 25 });
    grid.move({ x: 250, y: 75 });
    expect(grid.activeKey()).toBe('b');
    expect(grid.projectedCell()).toBeNull();
    expect(at(grid.previewLayout(), 'b')).toMatchObject({ w: 3, h: 2 });
    grid.end();
    expect(at(source(), 'b')).toMatchObject({ w: 3, h: 2 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('beginResizeGesture on a gapped grid rounds by cell plus gap', () => {
    const { grid } = setup({ gap: 10 });
    grid.setContainer(container(350));
    grid.beginResizeGesture('a', 'e', { x: 110, y: 25 });
    grid.move({ x: 150, y: 25 });
    expect(at(grid.previewLayout(), 'a')?.w).toBe(3);
  });
});
