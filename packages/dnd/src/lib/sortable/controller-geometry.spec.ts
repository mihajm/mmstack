import { signal } from '@angular/core';

import { getGroupInternals, sortableGroup, type SortableGroup } from './group';
import { reorderable } from './controller';
import type { ReorderableController, ReorderableOptions } from './types';

type Row = { id: string };
type Ctrl = ReorderableController<Row, string>;
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

type Layout = (index: number) => DOMRect;

/** Rows measure at their LIVE index through `layout`, like a re-rendered DOM. */
function mount(
  ctrl: Ctrl,
  data: () => readonly Row[],
  layout: Layout,
  bounds?: DOMRect,
  only?: (id: string) => boolean,
) {
  const els = new Map<string, HTMLElement>();
  const sync = () => {
    for (const r of data()) {
      if (els.has(r.id) || (only && !only(r.id))) continue;
      const el = document.createElement('div');
      const id = r.id;
      el.getBoundingClientRect = () =>
        layout(data().findIndex((x) => x.id === id));
      ctrl.register(id, el);
      els.set(id, el);
    }
  };
  sync();
  if (bounds) {
    const c = document.createElement('div');
    c.getBoundingClientRect = () => bounds;
    ctrl.setContainer(c);
  }
  return { els, sync };
}

/** A linear y list: rows `size` tall, `gaps[i]` px after row i (the last entry repeats). */
const linear =
  (size: number, gaps: number[] = [0], left = 0, width = 100): Layout =>
  (i) => {
    let top = 0;
    for (let k = 0; k < i; k++)
      top += size + gaps[Math.min(k, gaps.length - 1)];
    return box(left, top, width, size);
  };

/** A wrap grid: `cols` columns of w×h tiles with a uniform `gap`. */
const grid =
  (cols: number, w: number, h = w, gap = 0, left = 0): Layout =>
  (i) =>
    box(left + (i % cols) * (w + gap), Math.floor(i / cols) * (h + gap), w, h);

function list(
  start: string[],
  opts: Partial<ReorderableOptions<Row, string>> = {},
) {
  const data = signal(rows(...start));
  const onReorder = vi.fn();
  const ctrl = reorderable(data, {
    key: (r) => r.id,
    engine: 'pointer',
    onReorder,
    ...opts,
  } as ReorderableOptions<Row, string>) as Ctrl;
  const at = (id: string) =>
    ctrl.itemState(() => data().find((r) => r.id === id) as Row);
  return { data, ctrl, onReorder, at };
}

describe('linear footprint: the source slot plus its adjacent gap', () => {
  // a 0..20, b 30..50, c 54..74, d 80..100 (gaps 10, 4, 6)
  const gapped = () => {
    const l = list(['a', 'b', 'c', 'd']);
    mount(l.ctrl, l.data, linear(20, [10, 4, 6]));
    return l;
  };

  it('the first row: its size plus the gap after it', () => {
    const { ctrl, at } = gapped();
    ctrl.beginGesture('a', { x: 0, y: 10 });
    ctrl.move({ x: 0, y: 55 });
    expect(ctrl.insertIndex()).toBe(1);
    expect(at('b').transform()).toBe(-30);
  });

  it('a middle row: its size plus the gap after it', () => {
    const { ctrl, at } = gapped();
    ctrl.beginGesture('b', { x: 0, y: 40 });
    ctrl.move({ x: 0, y: 99 });
    expect(ctrl.insertIndex()).toBe(3);
    expect(at('c').transform()).toBe(-24);
    expect(at('d').transform()).toBe(-24);
  });

  it('the last row: its size plus the gap before it', () => {
    const { ctrl, at } = gapped();
    ctrl.beginGesture('d', { x: 0, y: 90 });
    ctrl.move({ x: 0, y: 2 });
    expect(ctrl.insertIndex()).toBe(0);
    expect(at('a').transform()).toBe(26);
    expect(at('a').transformCss()).toBe('translateY(26px)');
  });

  it('the last row of a gapless list: its own size', () => {
    const l = list(['a', 'b', 'c', 'd']);
    mount(l.ctrl, l.data, linear(20));
    l.ctrl.beginGesture('d', { x: 0, y: 70 });
    l.ctrl.move({ x: 0, y: 5 });
    expect(l.at('a').transform()).toBe(20);
  });

  it('a pointer that stays inside the source slot keeps the insert at the source', () => {
    const l = list(['a', 'b', 'c', 'd']);
    mount(l.ctrl, l.data, linear(20));
    l.ctrl.beginGesture('b', { x: 0, y: 30 });
    l.ctrl.move({ x: 0, y: 20 });
    expect(l.ctrl.insertIndex()).toBe(1);
  });
});

/** A grid and a y list in one group: grid at x 0.., list at x 400..500. */
function gridAndList(opts: {
  tiles: string[];
  cols: number;
  w: number;
  h?: number;
  gap?: number;
  listAxis?: 'x' | 'y';
}) {
  const group: SortableGroup<Row> = sortableGroup<Row>();
  const g = list(opts.tiles, { axis: 'wrap', group });
  mount(
    g.ctrl,
    g.data,
    grid(opts.cols, opts.w, opts.h, opts.gap),
    box(0, 0, 390, 390),
  );
  const axis = opts.listAxis ?? 'y';
  const l = list(['x', 'y', 'z'], { axis, group });
  const lay: Layout =
    axis === 'y' ? linear(40, [0], 400) : (i) => box(400 + i * 40, 400, 40, 40);
  mount(
    l.ctrl,
    l.data,
    lay,
    axis === 'y' ? box(400, 0, 100, 200) : box(400, 400, 200, 40),
  );
  return { group, g, l, gi: getGroupInternals(group) };
}

describe('wrap pitch: a target list opens the tile pitch, gaps included', () => {
  it('a y list opens the row pitch (tile height + gap)', () => {
    const { g, l } = gridAndList({
      tiles: ['A', 'B', 'C', 'D'],
      cols: 2,
      w: 60,
      h: 40,
      gap: 10,
    });
    g.ctrl.beginGesture('A', { x: 30, y: 20 });
    g.ctrl.move({ x: 450, y: 50 });
    expect(l.at('y').transform()).toBe(50);
    expect(l.at('x').transform()).toBe(0);
  });

  it('an x list opens the column pitch (tile width + gap)', () => {
    const { g, l } = gridAndList({
      tiles: ['A', 'B', 'C', 'D'],
      cols: 2,
      w: 60,
      h: 40,
      gap: 10,
      listAxis: 'x',
    });
    g.ctrl.beginGesture('A', { x: 30, y: 20 });
    g.ctrl.move({ x: 450, y: 420 });
    expect(l.at('y').transform()).toBe(70);
  });

  it('a single-row grid falls back to the tile height for the row pitch', () => {
    const { g, l } = gridAndList({ tiles: ['A', 'B', 'C'], cols: 3, w: 40 });
    g.ctrl.beginGesture('A', { x: 20, y: 20 });
    g.ctrl.move({ x: 450, y: 50 });
    expect(l.at('y').transform()).toBe(40);
  });

  it('an incoming row at slot 0 sends the last tile one column pitch on (the virtual append slot)', () => {
    const { g, l } = gridAndList({
      tiles: ['A', 'B', 'C', 'D'],
      cols: 3,
      w: 40,
      gap: 10,
    });
    l.ctrl.beginGesture('x', { x: 450, y: 20 });
    l.ctrl.move({ x: 21, y: 21 });
    expect(g.at('A').transformX()).toBe(50);
    expect(g.at('D').transformX()).toBe(50);
    expect(g.at('D').transformY()).toBe(0);
    expect(g.at('C').transformX()).toBe(-100);
    expect(g.at('C').transformY()).toBe(50);
  });

  it('a one-tile grid: a row dropped below the tile appends', () => {
    const { g, l, gi } = gridAndList({ tiles: ['A'], cols: 3, w: 40 });
    l.ctrl.beginGesture('x', { x: 450, y: 20 });
    l.ctrl.move({ x: 20, y: 58 });
    expect(gi.activeInsertIndex()).toBe(1);
    l.ctrl.end();
    expect(ids(g.data())).toEqual(['A', 'x']);
  });
});

/** A 3-column grid of 40px tiles: centers (20,20) (60,20) (100,20) / (20,60) (60,60) (100,60). */
function wrapList(
  tiles = ['A', 'B', 'C', 'D', 'E', 'F'],
  only?: (id: string) => boolean,
) {
  const l = list(tiles, { axis: 'wrap' });
  const dom = mount(l.ctrl, l.data, grid(3, 40), undefined, only);
  return { ...l, dom };
}

describe('wrap drag: begin, collision and follow', () => {
  it('a tile that is not rendered bails the drag start', () => {
    const { ctrl } = wrapList(undefined, (id) => id !== 'C');
    expect(() => ctrl.beginGesture('A', { x: 20, y: 20 })).not.toThrow();
    expect(ctrl.activeKey()).toBeNull();
  });

  it('drags a tile other than the first from its live index', () => {
    const { ctrl, onReorder } = wrapList();
    ctrl.beginGesture('B', { x: 60, y: 20 });
    expect(ctrl.activeKey()).toBe('B');
    ctrl.move({ x: 20, y: 60 });
    ctrl.end();
    expect(onReorder.mock.calls[0][0]).toMatchObject({ from: 1, to: 3 });
  });

  it('collides in 2D: main is y, cross is x', () => {
    const { ctrl, at } = wrapList();
    ctrl.beginGesture('A', { x: 20, y: 20 });
    ctrl.move({ x: 100, y: 20 });
    expect(ctrl.insertIndex()).toBe(2);
    expect(at('A').transformCss()).toBe('translate(80px, 0px)');
  });

  it('siblings render 2D slot vectors; idle tiles render nothing', () => {
    const { ctrl, at } = wrapList();
    expect(at('B').transformCss()).toBe('');
    expect(at('B').transformX()).toBe(0);
    ctrl.beginGesture('A', { x: 20, y: 20 });
    ctrl.move({ x: 60, y: 60 });
    expect(at('B').transformCss()).toBe('translate(-40px, 0px)');
    expect(at('D').transformCss()).toBe('translate(80px, -40px)');
    expect(at('B').transform()).toBe(0);
    expect(() => at('A').transformX()).not.toThrow();
  });

  it('a drag to slot 0 displaces the tiles before the source', () => {
    const { ctrl, at } = wrapList();
    ctrl.beginGesture('D', { x: 20, y: 60 });
    ctrl.move({ x: 20, y: 20 });
    expect(ctrl.insertIndex()).toBe(0);
    expect(at('A').transformX()).toBe(40);
  });
});

describe('mid-drag key changes: keep the live list, or abandon loudly', () => {
  const quiet = () =>
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('an edit in place right before release still commits (no re-measure needed)', () => {
    const warn = quiet();
    try {
      const l = list(['a', 'b', 'c', 'd']);
      mount(l.ctrl, l.data, linear(20));
      l.ctrl.beginGesture('b', { x: 0, y: 30 });
      l.ctrl.move({ x: 0, y: 95 });
      l.data.update((arr) => arr.map((r) => ({ ...r })));
      l.ctrl.end();
      expect(l.onReorder.mock.calls.map((c) => c[0])).toMatchObject([
        { from: 1, to: 3 },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a trailing removal re-measures: the drop lands in the shorter list', () => {
    const warn = quiet();
    try {
      const l = list(['a', 'b', 'c', 'd']);
      mount(l.ctrl, l.data, linear(20));
      l.ctrl.beginGesture('a', { x: 0, y: 10 });
      l.ctrl.move({ x: 0, y: 95 });
      expect(l.ctrl.insertIndex()).toBe(3);
      l.data.update((arr) => arr.filter((r) => r.id !== 'd'));
      l.ctrl.syncGeometry();
      expect(l.ctrl.insertIndex()).toBe(2);
      l.ctrl.end();
      expect(l.onReorder.mock.calls[0][0]).toMatchObject({ from: 0, to: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  it('dragging the first row while a peer appends keeps the drag alive', () => {
    const l = list(['a', 'b', 'c']);
    const dom = mount(l.ctrl, l.data, linear(20));
    l.ctrl.beginGesture('a', { x: 0, y: 10 });
    l.data.update((arr) => [...arr, { id: 'x' }]);
    dom.sync();
    l.ctrl.syncGeometry();
    expect(l.ctrl.activeKey()).toBe('a');
    l.ctrl.move({ x: 0, y: 55 });
    l.ctrl.end();
    expect(ids(l.data())).toEqual(['b', 'c', 'a', 'x']);
  });

  it('a prepend that has not rendered cancels the drag at the render pass, without throwing', () => {
    const warn = quiet();
    try {
      const l = list(['a', 'b', 'c']);
      mount(l.ctrl, l.data, linear(20));
      l.ctrl.beginGesture('b', { x: 0, y: 30 });
      l.data.update((arr) => [{ id: 'x' }, ...arr]);
      expect(() => l.ctrl.syncGeometry()).not.toThrow();
      expect(l.ctrl.activeKey()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('wrap: a prepend that has not rendered cancels too, without throwing', () => {
    const warn = quiet();
    try {
      const { ctrl, data } = wrapList();
      ctrl.beginGesture('B', { x: 60, y: 20 });
      data.update((arr) => [{ id: 'X' }, ...arr]);
      expect(() => ctrl.syncGeometry()).not.toThrow();
      expect(ctrl.activeKey()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('wrap: a rendered prepend re-measures in 2D and keeps the dragged tile under the pointer', () => {
    const { ctrl, data, dom, at, onReorder } = wrapList();
    ctrl.beginGesture('B', { x: 60, y: 20 });
    data.update((arr) => [{ id: 'X' }, ...arr]);
    dom.sync();
    ctrl.syncGeometry();
    expect(ctrl.activeKey()).toBe('B');
    // B now rests at idx 2 (100,20); the pointer never moved
    expect(at('B').transformCss()).toBe('translate(-40px, 0px)');
    ctrl.move({ x: 60, y: 60 });
    expect(ctrl.insertIndex()).toBe(4);
    ctrl.end();
    expect(onReorder.mock.calls[0][0]).toMatchObject({ from: 2, to: 4 });
    expect(ids(data())).toEqual(['X', 'A', 'C', 'D', 'B', 'E', 'F']);
  });
});

describe('a re-measure under auto-scroll reads layout in the drag-start frame', () => {
  it.each(['x', 'y'] as const)(
    'axis %s: the dragged row stays under the pointer',
    (axis) => {
      let scroll = 0;
      const l = list(['a', 'b', 'c', 'd'], { axis });
      const layout: Layout = (i) =>
        axis === 'x'
          ? box(i * 20 - scroll, 0, 20, 100)
          : box(0, i * 20 - scroll, 100, 20);
      const dom = mount(l.ctrl, l.data, layout);
      const p = (main: number) =>
        axis === 'x' ? { x: main, y: 0 } : { x: 0, y: main };
      l.ctrl.beginGesture('b', p(30));
      scroll = 20;
      l.ctrl.setScrollDelta(20);
      l.data.update((arr) => [{ id: 'x' }, ...arr]);
      dom.sync();
      l.ctrl.syncGeometry();
      l.ctrl.move(p(30));
      expect(l.at('b').transform()).toBe(0);
      expect(l.ctrl.insertIndex()).toBe(2);
    },
  );
});

describe('grouped wrap grids', () => {
  function grids() {
    const group = sortableGroup<Row>();
    const g1 = list(['A', 'B', 'C', 'D'], { axis: 'wrap', group });
    mount(g1.ctrl, g1.data, grid(3, 40), box(0, 0, 120, 120));
    const g2 = list(['P', 'Q'], { axis: 'wrap', group });
    mount(g2.ctrl, g2.data, grid(3, 40, 40, 0, 600), box(600, 0, 120, 120));
    const l = list(['x', 'y'], { group });
    mount(l.ctrl, l.data, linear(40, [0], 400), box(400, 0, 100, 200));
    return { g1, g2, l, gi: getGroupInternals(group) };
  }

  it('a same-list drag inside a grouped grid opens its own 2D gap', () => {
    const { g1 } = grids();
    g1.ctrl.beginGesture('A', { x: 20, y: 20 });
    g1.ctrl.move({ x: 60, y: 60 });
    expect(g1.at('B').transformX()).toBe(-40);
  });

  it('the source grid closes behind a departed tile; a bystander grid stays at rest', () => {
    const { g1, g2 } = grids();
    g1.ctrl.beginGesture('A', { x: 20, y: 20 });
    g1.ctrl.move({ x: 450, y: 50 });
    expect(g1.at('B').transformX()).toBe(-40);
    expect(g1.at('C').transformX()).toBe(-40);
    expect([g1.at('D').transformX(), g1.at('D').transformY()]).toEqual([
      80, -40,
    ]);
    expect([g2.at('Q').transformX(), g2.at('Q').transformY()]).toEqual([0, 0]);
    expect(g1.at('B').transform()).toBe(0);
  });

  it('a tile that arrived in the target after its hover measure stays put', () => {
    const { g1, l } = grids();
    l.ctrl.beginGesture('x', { x: 450, y: 20 });
    l.ctrl.move({ x: 21, y: 21 });
    g1.data.update((arr) => [...arr, { id: 'E' }]);
    expect(() => g1.at('E').transformX()).not.toThrow();
    expect(g1.at('E').transformX()).toBe(0);
  });

  it('a finished drag leaves no geometry behind: a later arrival reads the fresh layout', () => {
    let cols = 3;
    const group = sortableGroup<Row>();
    const g = list(['A', 'B', 'C', 'D'], { axis: 'wrap', group });
    mount(g.ctrl, g.data, (i) => grid(cols, 40)(i), box(0, 0, 120, 120));
    const l = list(['x'], { group });
    mount(l.ctrl, l.data, linear(40, [0], 400), box(400, 0, 100, 200));
    g.ctrl.beginGesture('A', { x: 20, y: 20 });
    g.ctrl.move({ x: 60, y: 20 });
    g.ctrl.cancel();
    cols = 2;
    l.ctrl.beginGesture('x', { x: 450, y: 20 });
    l.ctrl.move({ x: 21, y: 21 });
    // 2 columns: B (60,20) shifts to C's slot (20,60)
    expect([g.at('B').transformX(), g.at('B').transformY()]).toEqual([-40, 40]);
  });
});
