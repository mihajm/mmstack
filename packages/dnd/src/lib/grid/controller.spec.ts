import { effect, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  getGroupInternals,
  sortableGroup,
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

/** 6 cols of 50px cells, no gap; pointer starts on a's top-left cell center. */
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

function setup(opts: Partial<PlacementGridOptions<Widget, string>> = {}) {
  const source = signal<Widget[]>([
    w_('a', 0, 0),
    w_('b', 2, 0),
    w_('c', 0, 2, 4, 2),
  ]);
  const grid = placementGrid(source, { key, cols: 6, ...opts });
  return { source, grid };
}

function counter(injector: Injector, read: () => unknown) {
  let runs = 0;
  effect(
    () => {
      read();
      runs++;
    },
    { injector },
  );
  return {
    get runs() {
      return runs;
    },
    reset() {
      runs = 0;
    },
  };
}

describe('placementGrid', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('is inert when idle: preview IS the source, no projection', () => {
    const { source, grid } = setup();
    expect(grid.previewLayout()).toBe(source());
    expect(grid.projectedCell()).toBeNull();
    expect(grid.activeKey()).toBeNull();
    expect(grid.rows()).toBe(4);
  });

  describe('move drag (compact: vertical)', () => {
    it('projects the pointer to cells and previews the reflow, source untouched', () => {
      const { source, grid } = setup();
      const before = source();
      grid.begin('a', SNAP);
      grid.move({ x: 125, y: 25 }); // +100px = +2 cells → a at (2,0), b pushed
      expect(grid.projectedCell()).toEqual({ x: 2, y: 0 });
      const preview = grid.previewLayout();
      expect(preview.find((i) => i.id === 'a')).toMatchObject({ x: 2, y: 0 });
      expect(preview.find((i) => i.id === 'b')?.y).toBe(2);
      expect(source()).toBe(before); // NOT written mid-drag
    });

    it('projectedCell fires only on cell crossings (recomputation proof)', () => {
      const { grid } = setup();
      grid.begin('a', SNAP);
      const proj = counter(injector, () => grid.projectedCell());
      const preview = counter(injector, () => grid.previewLayout());
      TestBed.tick();
      proj.reset();
      preview.reset();

      grid.move({ x: 35, y: 30 }); // within the same cell
      grid.move({ x: 44, y: 40 });
      TestBed.tick();
      expect(proj.runs).toBe(0);
      expect(preview.runs).toBe(0);

      grid.move({ x: 80, y: 25 }); // crossed into cell x=1
      TestBed.tick();
      expect(proj.runs).toBe(1);
      expect(preview.runs).toBe(1);
    });

    it('untouched items keep reference identity through preview AND commit', () => {
      const { source, grid } = setup();
      const b0 = source().find((i) => i.id === 'b');
      const c0 = source().find((i) => i.id === 'c');
      grid.begin('a', SNAP);
      grid.move({ x: 225, y: 25 }); // a → the free corner (4,0): nobody yields
      expect(grid.previewLayout().find((i) => i.id === 'b')).toBe(b0);
      expect(grid.previewLayout().find((i) => i.id === 'c')).toBe(c0);

      grid.end();
      expect(source().find((i) => i.id === 'b')).toBe(b0);
      expect(source().find((i) => i.id === 'c')).toBe(c0);
    });

    it('commits the preview exactly once on end, with gravity released', () => {
      const { source, grid } = setup();
      let writes = 0;
      const orig = source.set.bind(source);
      vi.spyOn(source, 'set').mockImplementation((v) => {
        writes++;
        orig(v);
      });
      const places: Array<{ x: number; y: number }> = [];
      const { grid: g2, source: s2 } = setup({
        onPlace: (e) => places.push({ x: e.x, y: e.y }),
      });

      grid.begin('a', SNAP);
      grid.move({ x: 125, y: 25 });
      grid.move({ x: 128, y: 30 });
      grid.end();
      expect(writes).toBe(1);
      expect(source().find((i) => i.id === 'a')).toMatchObject({ x: 2, y: 0 });
      expect(grid.activeKey()).toBeNull();

      // dropping in mid-air: gravity pulls the item up on commit
      g2.begin('a', SNAP);
      g2.move({ x: 25, y: 400 }); // way below everything
      g2.end();
      const a = s2().find((i) => i.id === 'a');
      expect(a?.y).toBe(4); // settles on top of c, not floating at y 8
      expect(places).toEqual([{ x: 0, y: 4 }]);
    });

    it('cancel commits nothing and resets', () => {
      const { source, grid } = setup();
      const before = source();
      grid.begin('a', SNAP);
      grid.move({ x: 225, y: 125 });
      grid.cancel();
      expect(source()).toBe(before);
      expect(grid.activeKey()).toBeNull();
      expect(grid.projectedCell()).toBeNull();
    });

    it('clamps the projection into the column extent', () => {
      const { grid } = setup();
      grid.begin('a', SNAP);
      grid.move({ x: 9999, y: 25 });
      expect(grid.projectedCell()).toEqual({ x: 4, y: 0 }); // cols 6 - w 2
      grid.move({ x: -9999, y: -9999 });
      expect(grid.projectedCell()).toEqual({ x: 0, y: 0 });
    });
  });

  describe('compact: none (form-builder mode)', () => {
    it('holds the last VALID cell when hovering an occupied one (sticky)', () => {
      const { grid } = setup({ compact: 'none' });
      grid.begin('a', SNAP);
      grid.move({ x: 225, y: 25 }); // (4,0) free
      expect(grid.projectedCell()).toEqual({ x: 4, y: 0 });
      grid.move({ x: 125, y: 25 }); // (2,0) occupied by b → sticky
      expect(grid.projectedCell()).toEqual({ x: 4, y: 0 });
    });

    it('never moves neighbours; commit places only the dragged item', () => {
      const { source, grid } = setup({ compact: 'none' });
      const before = source().filter((i) => i.id !== 'a');
      grid.begin('a', SNAP);
      grid.move({ x: 225, y: 25 });
      grid.end();
      expect(source().find((i) => i.id === 'a')).toMatchObject({ x: 4, y: 0 });
      for (const b of before) {
        expect(source().find((i) => i.id === b.id)).toBe(b);
      }
    });

    it('grows by the dragged item height so every masked cell stays inside', () => {
      const { grid } = setup({ compact: 'none' });
      expect(grid.rows()).toBe(4);

      grid.begin('a', SNAP);
      expect(grid.rows()).toBe(6); // 4 occupied + the 2-row item's headroom
      const mask = grid.targetMask();
      expect(mask?.length).toBe(6 * 5); // origins stop one band below the rows

      // the projection clamps to that band too — no drop at silly depths
      grid.move({ x: 25, y: 9999 });
      expect(grid.projectedCell()).toEqual({ x: 0, y: 4 });

      grid.cancel();
      expect(grid.rows()).toBe(4); // shrinks back
    });

    it('exposes the validity mask for affordances, honouring canPlace', () => {
      const { grid } = setup({
        compact: 'none',
        canPlace: (_item, x) => x !== 4, // consumer rule: column 4 is off-limits
      });
      grid.begin('a', SNAP);
      const mask = grid.targetMask();
      expect(mask).not.toBeNull();
      // the projection seeds at the item's own (valid) cell
      expect(grid.projectedCell()).toEqual({ x: 0, y: 0 });
      // (4,0) is overlap-free but consumer canPlace rejects it → sticky
      grid.move({ x: 225, y: 25 });
      expect(grid.projectedCell()).toEqual({ x: 0, y: 0 });
      grid.move({ x: 25, y: 225 }); // (0,4) free and allowed
      expect(grid.projectedCell()).toEqual({ x: 0, y: 4 });
    });
  });

  describe('resize drag', () => {
    it('projects spans, previews the push, and commits once', () => {
      const { source, grid } = setup();
      grid.begin('a', { ...SNAP, kind: 'resize', direction: 'se' });
      grid.move({ x: 25 + 100, y: 25 + 50 }); // +2 cols, +1 row → 4×3
      const preview = grid.previewLayout();
      expect(preview.find((i) => i.id === 'a')).toMatchObject({ w: 4, h: 3 });
      expect(preview.find((i) => i.id === 'b')?.y).toBe(3); // pushed below
      grid.end();
      expect(source().find((i) => i.id === 'a')).toMatchObject({ w: 4, h: 3 });
    });

    it('e/s directions resize one axis only and spans clamp to ≥1 and the cols', () => {
      const { grid } = setup();
      grid.begin('a', { ...SNAP, kind: 'resize', direction: 'e' });
      grid.move({ x: 9999, y: 9999 });
      expect(grid.previewLayout().find((i) => i.id === 'a')).toMatchObject({
        w: 6,
        h: 2,
      });
      grid.cancel();

      grid.begin('a', { ...SNAP, kind: 'resize', direction: 's' });
      grid.move({ x: -9999, y: -9999 });
      expect(grid.previewLayout().find((i) => i.id === 'a')).toMatchObject({
        w: 2,
        h: 1,
      });
    });
  });

  describe('keyboard', () => {
    it('moveBy steps a cell with reflow; a gravity-reverted step is a no-op', () => {
      const { source, grid } = setup();
      expect(grid.moveBy('b', 1, 0)).toBe(true);
      expect(source().find((i) => i.id === 'b')).toMatchObject({ x: 3, y: 0 });

      // stepping down into empty air reverts under gravity → no-op
      const before = source();
      expect(grid.moveBy('b', 0, 1)).toBe(false);
      expect(source()).toBe(before);
    });

    it('moveBy honours the consumer canPlace under compact vertical', () => {
      const { source, grid } = setup({
        canPlace: (_item, x) => x !== 1,
      });
      const before = source();
      expect(grid.moveBy('a', 1, 0)).toBe(false); // (1,0) forbidden by canPlace
      expect(source()).toBe(before);
      expect(grid.moveBy('a', 2, 0)).toBe(true); // (2,0) allowed → reflows
    });

    it('resizeBy grows spans and pushes; rejects invalid in compact none', () => {
      const { source, grid } = setup();
      expect(grid.resizeBy('a', 0, 1)).toBe(true);
      expect(source().find((i) => i.id === 'a')?.h).toBe(3);
      expect(source().find((i) => i.id === 'c')?.y).toBe(3);

      const none = setup({ compact: 'none' });
      expect(none.grid.resizeBy('a', 1, 0)).toBe(false); // would hit b
      expect(none.source().find((i) => i.id === 'a')?.w).toBe(2);
    });
  });

  describe('group membership', () => {
    const bounds = { top: 0, left: 0, width: 300, height: 300 };

    it('insertAtPoint places an incoming item at the pointed cell (span-centered)', () => {
      const { source, grid } = setup();
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      grid.refreshBounds();

      const incoming = w_('x', 0, 0, 2, 2);
      // point at cell (4,0)'s center-ish: px 225, 25 → leading cell 4 minus (w-1)/2 = 4
      expect(grid.insertAtPoint?.(incoming, 235, 30)).toBe(true);
      expect(source().find((i) => i.id === 'x')).toMatchObject({ x: 4, y: 0 });
    });

    it('insertAt falls back to first-fit', () => {
      const { source, grid } = setup();
      grid.insertAt(w_('x', 0, 0, 2, 2), 0);
      expect(source().find((i) => i.id === 'x')).toMatchObject({ x: 4, y: 0 });
    });

    it('compact none rejects an occupied insertAtPoint so the source falls back', () => {
      const { source, grid } = setup({ compact: 'none' });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      grid.refreshBounds();
      expect(grid.insertAtPoint?.(w_('x', 0, 0, 2, 2), 125, 25)).toBe(false); // over b
      expect(source().some((i) => i.id === 'x')).toBe(false);
    });

    it('previews an incoming foreign hover as its projected drop rect', () => {
      const group = sortableGroup<Widget>();
      const listStub: SortableGroupMember<Widget> = {
        bounds: () => ({ top: 0, left: 400, width: 100, height: 300 }),
        refreshBounds: () => undefined,
        measure: () => ({ centers: [50], axis: 'y' }),
        insertAt: () => true,
      };
      group.register(listStub);
      const { grid } = setup({ group });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      grid.refreshBounds();

      expect(grid.incomingCell()).toBeNull();

      // a source (the stub) hovers the grid with a 2×2 item over the free corner
      const api = getGroupInternals(group);
      api.setActive({
        source: listStub,
        target: grid,
        sourceIndex: 0,
        insertIndex: 0,
        footprint: 40,
        item: w_('x', 0, 0, 2, 2),
        x: 235,
        y: 30,
      });
      expect(grid.incomingCell()).toMatchObject({ x: 4, y: 0, w: 2, h: 2 });

      // over an occupied cell (b at 2,0) the preview declines to lie
      api.setActive({
        source: listStub,
        target: grid,
        sourceIndex: 0,
        insertIndex: 0,
        footprint: 40,
        item: w_('x', 0, 0, 2, 2),
        x: 125,
        y: 25,
      });
      // vertical compaction accepts anywhere (push reflow), so still shown...
      expect(grid.incomingCell()).toMatchObject({ x: 2, y: 0 });
      api.clearActive();
      expect(grid.incomingCell()).toBeNull();
    });

    it('an incoming hover on a compact:none grid hides the preview over invalid cells', () => {
      const group = sortableGroup<Widget>();
      const listStub: SortableGroupMember<Widget> = {
        bounds: () => ({ top: 0, left: 400, width: 100, height: 300 }),
        refreshBounds: () => undefined,
        measure: () => ({ centers: [50], axis: 'y' }),
        insertAt: () => true,
      };
      group.register(listStub);
      const { grid } = setup({ group, compact: 'none' });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      grid.refreshBounds();

      const api = getGroupInternals(group);
      const hover = (x: number, y: number) =>
        api.setActive({
          source: listStub,
          target: grid,
          sourceIndex: 0,
          insertIndex: 0,
          footprint: 40,
          item: w_('x', 0, 0, 2, 2),
          x,
          y,
        });
      hover(125, 25); // over b → invalid, no preview
      expect(grid.incomingCell()).toBeNull();
      hover(235, 30); // free corner → shown
      expect(grid.incomingCell()).toMatchObject({ x: 4, y: 0 });
    });

    it('an EMPTY grid keeps one row of height so it stays a drop target', () => {
      const source = signal<Widget[]>([]);
      const grid = placementGrid(source, { key, cols: 6 });
      expect(grid.rows()).toBe(1);
      source.set([w_('a', 0, 0)]);
      expect(grid.rows()).toBe(2);
    });

    it('a REFUSED cross-drop is a no-op: the item stays in the source grid', () => {
      const group = sortableGroup<Widget>();
      const refusingList: SortableGroupMember<Widget> = {
        bounds: () => ({ top: 0, left: 400, width: 100, height: 300 }),
        refreshBounds: () => undefined,
        measure: () => ({ centers: [50, 150], axis: 'y' }),
        insertAt: () => false,
        insertAtPoint: () => false,
      };
      group.register(refusingList);

      const { source, grid } = setup({ group });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      const before = source();

      grid.begin('a', SNAP);
      grid.move({ x: 450, y: 160 }); // over the refusing member
      grid.end();

      expect(source().find((i) => i.id === 'a')).toBe(
        before.find((i) => i.id === 'a'),
      );
      expect(source()).toHaveLength(before.length);
      expect(grid.activeKey()).toBeNull();
    });

    it('receive honours the consumer canPlace under compact vertical too', () => {
      const { source, grid } = setup({
        canPlace: (item) => item.id !== 'x',
      });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);
      grid.refreshBounds();
      expect(grid.insertAtPoint?.(w_('x', 0, 0, 2, 2), 235, 30)).toBe(false);
      expect(source().some((i) => i.id === 'x')).toBe(false);
    });

    it('drags a grid item out into a group member (list stub) and compacts behind it', () => {
      const group = sortableGroup<Widget>();
      const received: Widget[] = [];
      const listStub: SortableGroupMember<Widget> = {
        bounds: () => ({ top: 0, left: 400, width: 100, height: 300 }),
        refreshBounds: () => undefined,
        measure: () => ({ centers: [50, 150], axis: 'y' }),
        insertAt: (item) => {
          received.push(item);
          return true;
        },
      };
      group.register(listStub);

      const { source, grid } = setup({ group });
      grid.setContainer({
        getBoundingClientRect: () => bounds,
      } as unknown as HTMLElement);

      grid.begin('a', SNAP);
      grid.move({ x: 450, y: 160 }); // over the stub list
      grid.end();

      expect(received.map((i) => i.id)).toEqual(['a']);
      expect(source().some((i) => i.id === 'a')).toBe(false);
      expect(source().find((i) => i.id === 'c')?.y).toBe(2); // compacted grid remains valid
    });
  });
});
