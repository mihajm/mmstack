import { signal } from '@angular/core';

import {
  getGroupInternals,
  sortableGroup,
  type SortableGroup,
  type SortableGroupMember,
} from '../sortable/group';
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
const ids = (arr: readonly Widget[]) => arr.map((i) => i.id);
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
const BOUNDS = { top: 0, left: 0, width: 300, height: 300 };
const containerAt = (b: {
  top: number;
  left: number;
  width: number;
  height: number;
}) => ({ getBoundingClientRect: () => b }) as unknown as HTMLElement;

function setup(opts: Partial<PlacementGridOptions<Widget, string>> = {}) {
  const source = signal<Widget[]>([
    w_('a', 0, 0),
    w_('b', 2, 0),
    w_('c', 0, 2, 4, 2),
  ]);
  const grid = placementGrid(source, { key, cols: 6, ...opts });
  grid.setContainer(containerAt(BOUNDS));
  grid.refreshBounds();
  return { source, grid };
}

/** A keyed list member at left 1000: rows 20px tall, centers at 10, 30, 50… */
function keyedList(group: SortableGroup<Widget>, initial: Widget[]) {
  const list = signal<Widget[]>(initial);
  const member: SortableGroupMember<Widget> = {
    bounds: () => ({ left: 1000, top: 0, width: 100, height: 400 }),
    refreshBounds: () => undefined,
    measure: () => ({
      centers: list().map((_, i) => i * 20 + 10),
      axis: 'y',
      keys: list().map(key),
    }),
    insertAt: (item, index) => {
      list.update((arr) => [...arr.slice(0, index), item, ...arr.slice(index)]);
      return true;
    },
    slotOfAnchor: (anchor) => {
      const keys = list().map(key);
      if ('after' in anchor) {
        const i = keys.indexOf(anchor.after as string);
        return i < 0 ? -1 : i + 1;
      }
      if ('before' in anchor) return keys.indexOf(anchor.before as string);
      return 0;
    },
  };
  group.register(member);
  return { list, member };
}

type Stub = SortableGroupMember<Widget> & { received: Widget[] };
function listStub(
  group: SortableGroup<Widget>,
  extra: Partial<SortableGroupMember<Widget>> = {},
): Stub {
  const received: Widget[] = [];
  const stub: Stub = {
    received,
    bounds: () => ({ top: 0, left: 400, width: 100, height: 300 }),
    refreshBounds: () => undefined,
    measure: () => ({ centers: [50, 150], axis: 'y' }),
    insertAt: (item) => {
      received.push(item);
      return true;
    },
    ...extra,
  };
  group.register(stub);
  return stub;
}

describe('placementGrid: cross-container measures are per drag', () => {
  it('a second drag into a list measures the list as it is now, not as it was on the first drag', () => {
    const group = sortableGroup<Widget>();
    const source = signal<Widget[]>([w_('w1', 0, 0), w_('w2', 2, 0)]);
    const grid = placementGrid(source, { key, cols: 6, group });
    const { list } = keyedList(group, [w_('a', 0, 0), w_('b', 0, 0)]);

    grid.begin('w1', SNAP);
    grid.move({ x: 1050, y: 20 }); // between a (10) and b (30)
    grid.end();
    expect(ids(list())).toEqual(['a', 'w1', 'b']);

    grid.begin('w2', { ...SNAP, startX: 125 });
    grid.move({ x: 1050, y: 40 }); // between w1 (30) and b (50)
    grid.end();
    expect(ids(list())).toEqual(['a', 'w1', 'w2', 'b']);
    expect(source()).toEqual([]);
  });
});

describe('placementGrid: arrivals (insertAtPoint, insertAt)', () => {
  const empty = (opts: Partial<PlacementGridOptions<Widget, string>> = {}) => {
    const source = signal<Widget[]>([]);
    const grid = placementGrid(source, {
      key,
      cols: 6,
      compact: 'none',
      ...opts,
    });
    return { source, grid };
  };

  it('the pointed cell on a gapped grid steps by cell plus gap', () => {
    const { source, grid } = setup({ compact: 'none', gap: 10 });
    grid.setContainer(containerAt({ ...BOUNDS, width: 350 }));
    grid.refreshBounds();
    expect(grid.insertAtPoint!(w_('x', 0, 0, 1, 1), 250, 70)).toBe(true);
    expect(at(source(), 'x')).toMatchObject({ x: 4, y: 1 });
  });

  it('a 3x3 arrival is centred on the pointed cell', () => {
    const { source, grid } = empty();
    grid.setContainer(containerAt(BOUNDS));
    expect(grid.insertAtPoint!(w_('x', 0, 0, 3, 3), 175, 125)).toBe(true);
    expect(at(source(), 'x')).toMatchObject({ x: 2, y: 1 });
  });

  it('an offset container maps the pointer from its own origin', () => {
    const { source, grid } = empty();
    grid.setContainer(containerAt({ ...BOUNDS, left: 100, top: 40 }));
    expect(grid.insertAtPoint!(w_('x', 0, 0), 235, 140)).toBe(true);
    expect(at(source(), 'x')).toMatchObject({ x: 2, y: 2 });
  });

  it('an arrival is clamped to the right edge and keeps its row', () => {
    const right = empty();
    right.grid.setContainer(containerAt(BOUNDS));
    right.grid.insertAtPoint!(w_('x', 0, 0), 295, 30);
    expect(at(right.source(), 'x')).toMatchObject({ x: 4, y: 0 });
    const low = empty();
    low.grid.setContainer(containerAt(BOUNDS));
    low.grid.insertAtPoint!(w_('x', 0, 0), 25, 230);
    expect(at(low.source(), 'x')).toMatchObject({ x: 0, y: 4 });
  });

  it('a zero-width or unmeasured grid refuses arrivals and pointer drags', () => {
    const zero = setup();
    zero.grid.setContainer(containerAt({ ...BOUNDS, width: 0 }));
    zero.grid.refreshBounds();
    const before = zero.source();
    expect(zero.grid.insertAtPoint!(w_('x', 0, 0), 10, 10)).toBe(false);
    expect(zero.source()).toBe(before);
    zero.grid.beginGesture('a', { x: 0, y: 0 });
    expect(zero.grid.activeKey()).toBeNull();

    const source = signal<Widget[]>([w_('a', 0, 0)]);
    const bare = placementGrid(source, { key, cols: 6 });
    expect(bare.insertAtPoint!(w_('x', 0, 0), 10, 10)).toBe(false);
    expect(source()).toHaveLength(1);
    expect(() => bare.beginGesture('a', { x: 0, y: 0 })).not.toThrow();
    expect(() =>
      bare.beginResizeGesture('a', 'se', { x: 0, y: 0 }),
    ).not.toThrow();
    expect(bare.activeKey()).toBeNull();
  });

  it('vertical arrivals push the occupant down; compact-none arrivals stay where dropped', () => {
    const arrived = vi.fn();
    const v = setup({ onItemArrived: arrived });
    expect(v.grid.insertAtPoint!(w_('x', 0, 0), 125, 25)).toBe(true);
    expect(at(v.source(), 'x')).toMatchObject({ x: 2, y: 0 });
    expect(at(v.source(), 'b')?.y).toBe(2);

    const n = setup({ compact: 'none' });
    expect(n.grid.insertAtPoint!(w_('x', 0, 0), 225, 125)).toBe(true);
    expect(at(n.source(), 'x')).toMatchObject({ x: 4, y: 2 });
  });

  it('a lower-row arrival pushes the items below and reports its cell', () => {
    const arrived = vi.fn();
    const { source, grid } = setup({ onItemArrived: arrived });
    const a0 = at(source(), 'a');
    grid.insertAtPoint!(w_('x', 0, 0), 25, 125);
    expect(at(source(), 'x')).toMatchObject({ x: 0, y: 2 });
    expect(at(source(), 'c')?.y).toBe(4);
    expect(at(source(), 'a')).toBe(a0);
    expect(arrived).toHaveBeenCalledWith({
      item: { ...w_('x', 0, 0), x: 0, y: 2 },
      x: 0,
      y: 2,
    });
  });

  it('first fit scans every row down to the free band below', () => {
    const source = signal<Widget[]>([w_('X', 0, 0, 6, 3), w_('Y', 0, 3, 4, 1)]);
    const grid = placementGrid(source, { key, cols: 6 });
    expect(grid.insertAt(w_('n', 0, 0), 0)).toBe(true);
    expect(at(source(), 'n')).toMatchObject({ x: 4, y: 3 });
  });

  it('first fit skips the cells canPlace refuses', () => {
    const { source, grid } = setup({ canPlace: (_i, x) => x !== 4 });
    expect(grid.insertAt(w_('x', 0, 0), 0)).toBe(true);
    expect(at(source(), 'x')).toMatchObject({ x: 0, y: 4 });
  });

  it('canReceive is the consumer predicate', () => {
    const { grid } = setup({ canReceive: (i) => i.id !== 'x' });
    expect(grid.canReceive!(w_('x', 0, 0))).toBe(false);
    expect(grid.canReceive!(w_('y', 0, 0))).toBe(true);
  });

  it('the grid is a hit target at its bounds and opens no list gap', () => {
    const group = sortableGroup<Widget>();
    const { grid } = setup({ group });
    grid.refreshBounds();
    expect(grid.bounds()).toEqual(BOUNDS);
    expect(group.targetAt(100, 100)).toBe(grid);
    expect(grid.measure()).toEqual({ centers: [], axis: 'y' });
  });
});

describe('placementGrid: dragging out to another member', () => {
  const inGroup = (
    opts: Partial<PlacementGridOptions<Widget, string>> = {},
  ) => {
    const group = sortableGroup<Widget>();
    const api = getGroupInternals(group);
    const { source, grid } = setup({ group, ...opts });
    return { group, api, source, grid };
  };

  it('crossTarget is true only while the drag is over another member', () => {
    const { group, grid } = inGroup();
    listStub(group);
    expect(grid.crossTarget()).toBe(false);
    grid.begin('a', SNAP);
    expect(grid.crossTarget()).toBe(false);
    grid.move({ x: 450, y: 160 });
    expect(grid.crossTarget()).toBe(true);
    grid.move({ x: 25, y: 25 });
    expect(grid.crossTarget()).toBe(false);
    grid.end();
    expect(grid.crossTarget()).toBe(false);

    const solo = setup();
    expect(solo.grid.crossTarget()).toBe(false);
    solo.grid.begin('a', SNAP);
    expect(solo.grid.crossTarget()).toBe(false);
  });

  it('back over the grid, the release moves the item inside the grid', () => {
    const { group, source, grid } = inGroup();
    const stub = listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    grid.move({ x: 225, y: 25 });
    grid.end();
    expect(stub.received).toEqual([]);
    expect(at(source(), 'a')).toMatchObject({ x: 4, y: 0 });
  });

  it('a plain drop inside a grouped grid commits locally', () => {
    const { group, source, grid } = inGroup();
    listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 225, y: 25 });
    expect(() => grid.end()).not.toThrow();
    expect(at(source(), 'a')).toMatchObject({ x: 4, y: 0 });
    expect(grid.activeKey()).toBeNull();
  });

  it('a pointer past every member leaves the group untouched', () => {
    const { group, api, grid } = inGroup();
    listStub(group);
    grid.begin('a', SNAP);
    expect(() => grid.move({ x: 2000, y: 2000 })).not.toThrow();
    expect(api.activeSource()).toBeNull();
  });

  it('a move after cancel does not drive the group', () => {
    const { group, api, grid } = inGroup();
    listStub(group);
    grid.begin('a', SNAP);
    grid.cancel();
    grid.move({ x: 450, y: 160 });
    expect(api.activeSource()).toBeNull();
  });

  it('cancel clears the hover it published, and only its own', () => {
    const { group, api, grid } = inGroup();
    const stub = listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    expect(api.activeSource()).toBe(grid);
    grid.cancel();
    expect(api.activeSource()).toBeNull();

    api.setActive({
      source: stub,
      target: grid,
      sourceIndex: 0,
      insertIndex: 0,
      footprint: 40,
      item: w_('x', 0, 0),
      x: 235,
      y: 30,
    });
    grid.cancel();
    expect(grid.incomingCell()).not.toBeNull();
  });

  it('a resize grip dragged over a list never transfers', () => {
    const { group, api, source, grid } = inGroup();
    const stub = listStub(group);
    grid.begin('a', {
      ...SNAP,
      kind: 'resize',
      direction: 'se',
      startX: 100,
      startY: 100,
    });
    grid.move({ x: 450, y: 160 });
    expect(api.activeTarget()).toBeNull();
    grid.end();
    expect(stub.received).toEqual([]);
    expect(source().some((i) => i.id === 'a')).toBe(true);
  });

  it("another member's canReceive decides whether it is a target", () => {
    const refusing = inGroup();
    const no = listStub(refusing.group, { canReceive: () => false });
    refusing.grid.begin('a', SNAP);
    refusing.grid.move({ x: 450, y: 160 });
    expect(refusing.api.activeTarget()).not.toBe(no);
    refusing.grid.end();
    expect(no.received).toEqual([]);
    expect(refusing.source().some((i) => i.id === 'a')).toBe(true);

    const accepting = inGroup();
    const yes = listStub(accepting.group, { canReceive: (i) => i.id === 'a' });
    accepting.grid.begin('a', SNAP);
    accepting.grid.move({ x: 450, y: 160 });
    expect(accepting.api.activeTarget()).toBe(yes);
    expect(accepting.api.activeItem()).toEqual(w_('a', 0, 0));
  });

  it("the grid's own canReceive never keeps its drag from coming home", () => {
    const { group, source, grid } = inGroup({ canReceive: () => false });
    const stub = listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    grid.move({ x: 225, y: 25 });
    grid.end();
    expect(stub.received).toEqual([]);
    expect(at(source(), 'a')).toMatchObject({ x: 4, y: 0 });
  });

  it('the footprint a list opens is the item size along that list axis', () => {
    const wide = signal<Widget[]>([w_('t', 0, 0, 3, 1)]);
    const g1 = sortableGroup<Widget>();
    const horizontal = listStub(g1, {
      measure: () => ({ centers: [450], axis: 'x' }),
    });
    void horizontal;
    const grid1 = placementGrid(wide, { key, cols: 6, group: g1 });
    grid1.begin('t', SNAP);
    grid1.move({ x: 450, y: 20 });
    expect(getGroupInternals(g1).activeFootprint()).toBe(150);

    const g2 = sortableGroup<Widget>();
    listStub(g2);
    const tall = placementGrid(
      signal<Widget[]>([w_('t', 0, 0, 3, 1), w_('q', 3, 0)]),
      {
        key,
        cols: 6,
        group: g2,
      },
    );
    tall.begin('t', SNAP);
    tall.move({ x: 450, y: 160 });
    expect(getGroupInternals(g2).activeFootprint()).toBe(50);
    tall.cancel();
    tall.begin('q', { ...SNAP, startX: 175 });
    tall.move({ x: 450, y: 160 });
    expect(getGroupInternals(g2).activeFootprint()).toBe(100);
  });
});

describe('placementGrid: the release over another member', () => {
  it('a drop at the top of a list inserts at slot 0 and reports the item that left', () => {
    const group = sortableGroup<Widget>();
    const left = vi.fn();
    const { source, grid } = setup({ group, onItemLeft: left });
    const stub = listStub(group);
    const a0 = at(source(), 'a');
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 10 });
    grid.end();
    expect(stub.received.map((i) => i.id)).toEqual(['a']);
    expect(source().some((i) => i.id === 'a')).toBe(false);
    expect(left).toHaveBeenCalledTimes(1);
    expect(left).toHaveBeenCalledWith({ item: a0 });
  });

  it('a hover anchored before the first row lands first', () => {
    const group = sortableGroup<Widget>();
    const source = signal<Widget[]>([w_('w', 0, 0)]);
    const grid = placementGrid(source, { key, cols: 6, group });
    const { list } = keyedList(group, [w_('a', 0, 0), w_('b', 0, 0)]);
    grid.begin('w', SNAP);
    grid.move({ x: 1050, y: 5 });
    grid.end();
    expect(ids(list())).toEqual(['w', 'a', 'b']);
    expect(source()).toEqual([]);
  });

  it('a target that names no neighbours takes the raw insert index', () => {
    const group = sortableGroup<Widget>();
    const { source, grid } = setup({ group });
    const inserts: number[] = [];
    listStub(group, {
      measure: () => ({ centers: [50, 150], axis: 'y' }),
      slotOfAnchor: (anchor) => {
        if (!anchor) throw new Error('no anchor');
        return 0;
      },
      insertAt: (_item, index) => {
        inserts.push(index);
        return true;
      },
    });
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    grid.end();
    expect(inserts).toEqual([2]);
    expect(source().some((i) => i.id === 'a')).toBe(false);
  });

  it('grid to grid: the target takes the item at the pointed cell and the source lets it go', () => {
    const group = sortableGroup<Widget>();
    const left = vi.fn();
    const one = signal<Widget[]>([w_('a', 0, 0)]);
    const two = signal<Widget[]>([]);
    const g1 = placementGrid(one, { key, cols: 6, group, onItemLeft: left });
    const g2 = placementGrid(two, { key, cols: 6, group });
    g1.setContainer(containerAt({ top: 0, left: 0, width: 300, height: 300 }));
    g2.setContainer(
      containerAt({ top: 0, left: 400, width: 300, height: 300 }),
    );
    g1.begin('a', SNAP);
    g1.move({ x: 425, y: 25 });
    g1.end();
    expect(ids(two())).toEqual(['a']);
    expect(one()).toEqual([]);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it('the drag refreshes every member box when it begins', () => {
    const group = sortableGroup<Widget>();
    const one = signal<Widget[]>([w_('a', 0, 0)]);
    const two = signal<Widget[]>([]);
    const g1 = placementGrid(one, { key, cols: 6, group });
    const g2 = placementGrid(two, { key, cols: 6, group });
    g1.setContainer(containerAt(BOUNDS));
    g2.setContainer(containerAt({ ...BOUNDS, left: 400 }));
    expect(g2.bounds()).toBeNull();
    g1.begin('a', SNAP);
    g1.move({ x: 425, y: 25 });
    g1.end();
    expect(ids(two())).toEqual(['a']);
  });
});

describe('placementGrid: dispose', () => {
  it('mid cross-drag it ends the drag, frees the group and leaves it', () => {
    const group = sortableGroup<Widget>();
    const api = getGroupInternals(group);
    const { grid } = setup({ group });
    listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    expect(api.activeSource()).toBe(grid);
    grid.dispose();
    expect(grid.activeKey()).toBeNull();
    expect(api.activeSource()).toBeNull();
    expect(group.members()).not.toContain(grid);
  });

  it('as the hovered target it clears the hover; an unrelated hover is left alone', () => {
    const group = sortableGroup<Widget>();
    const api = getGroupInternals(group);
    const { grid } = setup({ group });
    const listA = listStub(group);
    const listB = listStub(group);
    const hover = (target: SortableGroupMember<Widget>) =>
      api.setActive({
        source: listA,
        target,
        sourceIndex: 0,
        insertIndex: 0,
        footprint: 40,
        item: w_('x', 0, 0),
        x: 235,
        y: 30,
      });
    hover(listB);
    grid.dispose();
    expect(api.activeTarget()).toBe(listB);

    const other = setup({ group });
    hover(other.grid);
    other.grid.dispose();
    expect(api.activeTarget()).toBeNull();
  });
});

describe('placementGrid: an incoming foreign hover', () => {
  const hovered = () => {
    const group = sortableGroup<Widget>();
    const api = getGroupInternals(group);
    const { grid } = setup({ group });
    const stub = listStub(group);
    const hover = (
      x: number,
      y: number,
      item: Widget | 'none' = w_('x', 0, 0),
      target: SortableGroupMember<Widget> = grid,
    ) =>
      api.setActive({
        source: stub,
        target,
        sourceIndex: 0,
        insertIndex: 0,
        footprint: 40,
        item: item === 'none' ? undefined : item,
        x,
        y,
      });
    return { group, api, grid, stub, hover };
  };

  it('a drag hovering another member previews nothing here', () => {
    const { group, grid, hover } = hovered();
    const other = listStub(group);
    hover(235, 30, w_('x', 0, 0), other);
    expect(grid.incomingCell()).toBeNull();
    expect(grid.rows()).toBe(4);
  });

  it('a hover without an item previews nothing and keeps the rows', () => {
    const { grid, hover } = hovered();
    hover(235, 30, 'none');
    expect(grid.incomingCell()).toBeNull();
    expect(grid.rows()).toBe(4);
  });

  it('the preview follows a vertical move of the hover', () => {
    const { grid, hover } = hovered();
    hover(235, 30);
    expect(grid.incomingCell()?.y).toBe(0);
    hover(235, 130);
    expect(grid.incomingCell()?.y).toBe(2);
  });

  it('a hover below the last row grows the grid to hold it', () => {
    const { grid, hover } = hovered();
    hover(25, 225);
    expect(grid.incomingCell()).toMatchObject({
      x: 0,
      y: 4,
      w: 2,
      h: 2,
      key: 'x',
    });
    expect(grid.rows()).toBe(6);
  });
});

describe('placementGrid: the hovered member stays the target over empty space', () => {
  it('a release past every member after hovering a list transfers into that list', () => {
    const group = sortableGroup<Widget>();
    const { source, grid } = setup({ group });
    const stub = listStub(group);
    grid.begin('a', SNAP);
    grid.move({ x: 450, y: 160 });
    grid.move({ x: 2000, y: 2000 });
    expect(grid.dropOutside()).toBe(true);
    expect(grid.crossTarget()).toBe(true);
    grid.end();
    expect(stub.received.map((i) => i.id)).toEqual(['a']);
    expect(source().some((i) => i.id === 'a')).toBe(false);
  });

  it('a release outside that never hovered a member cancels', () => {
    const group = sortableGroup<Widget>();
    const { source, grid } = setup({ group });
    const stub = listStub(group);
    const before = source();
    grid.begin('a', SNAP);
    grid.move({ x: 2000, y: 2000 });
    expect(grid.crossTarget()).toBe(false);
    grid.end();
    expect(stub.received).toEqual([]);
    expect(source()).toBe(before);
  });
});
