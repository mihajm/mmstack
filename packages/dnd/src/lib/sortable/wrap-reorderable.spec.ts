import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { sortableGroup } from './group';
import { Reorderable, ReorderableItem, reorderable } from './reorderable';

type Tile = { id: number; label: string };

function pe(type: string, x = 0, y = 0, id = 1): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    button: 0,
    pointerType: 'mouse',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return e;
}

/**
 * Lays a container's items out as a 3-column wrap grid of 40×40 tiles:
 *   idx 0 (0..40, 0..40)   idx 1 (40..80)   idx 2 (80..120)
 *   idx 3 (0..40, 40..80)  ...
 * Centers: (20,20) (60,20) (100,20) / (20,60) (60,60) (100,60).
 */
function mockWrapRects(cols = 3, size = 40) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-container')) {
        return {
          top: 0,
          left: 0,
          right: cols * size,
          bottom: 200,
          width: cols * size,
          height: 200,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      const parent = this.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(this) : 0;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      return {
        top: row * size,
        bottom: row * size + size,
        left: col * size,
        right: col * size + size,
        width: size,
        height: size,
        x: col * size,
        y: row * size,
        toJSON: () => ({}),
      } as DOMRect;
    });
}

@Component({
  selector: 'mm-wrap-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list" data-container>
      @for (t of list.items(); track t.id) {
        <li [mmReorderableItem]="t">{{ t.label }}</li>
      }
    </ul>
  `,
})
class WrapHost {
  readonly data = signal<Tile[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
    { id: 4, label: 'D' },
    { id: 5, label: 'E' },
    { id: 6, label: 'F' },
  ]);
  readonly reorders: Array<{ from: number; to: number }> = [];
  readonly list = reorderable(this.data, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'wrap',
    onReorder: ({ from, to }) => this.reorders.push({ from, to }),
  });
}

describe('reorderable — axis: wrap (pointer engine)', () => {
  function setup() {
    const rectSpy = mockWrapRects();
    const fixture = TestBed.createComponent(WrapHost);
    fixture.detectChanges();
    TestBed.tick(); // flush the deferred (afterNextRender) pointer setup
    fixture.detectChanges();

    const host = fixture.componentInstance;
    const items = Array.from(
      fixture.nativeElement.querySelectorAll('li'),
    ) as HTMLElement[];
    return { fixture, host, items, rectSpy };
  }

  it('reorders across a row boundary in reading order', () => {
    const { host, items, rectSpy } = setup();
    try {
      // drag A (center 20,20) onto E's slot (center 60,60) — next row, middle
      items[0].dispatchEvent(pe('pointerdown', 20, 20));
      items[0].dispatchEvent(pe('pointermove', 60, 60));
      TestBed.tick();
      expect(host.list.activeKey()).toBe(1);
      expect(host.list.insertIndex()).toBe(4);

      items[0].dispatchEvent(pe('pointerup', 60, 60));
      TestBed.tick();
      expect(host.data().map((t) => t.label)).toEqual([
        'B',
        'C',
        'D',
        'E',
        'A',
        'F',
      ]);
      expect(host.reorders).toEqual([{ from: 0, to: 4 }]);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('displaces siblings by 2D slot vectors while dragging', () => {
    const { host, items, rectSpy } = setup();
    try {
      items[0].dispatchEvent(pe('pointerdown', 20, 20));
      items[0].dispatchEvent(pe('pointermove', 60, 60)); // insert = 4
      TestBed.tick();

      const state = (i: number) =>
        host.list.itemState(() => host.data()[i]);
      // B (idx 1, center 60,20) closes into A's slot (20,20): (-40, 0)
      expect(state(1).transformX()).toBe(-40);
      expect(state(1).transformY()).toBe(0);
      // D (idx 3, center 20,60) wraps UP to C's slot (100,20): (+80, -40)
      expect(state(3).transformX()).toBe(80);
      expect(state(3).transformY()).toBe(-40);
      // F (idx 5) is outside the band: untouched
      expect(state(5).transformX()).toBe(0);
      expect(state(5).transformY()).toBe(0);
      // the source follows the pointer freely (2D translate in transformCss)
      expect(state(0).transformCss()).toBe('translate(40px, 40px)');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();
      expect(host.data().map((t) => t.label)).toEqual([
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
      ]);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('keyboard: ArrowRight steps, ArrowDown moves a whole row', () => {
    const { host, items, rectSpy } = setup();
    try {
      items[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      TestBed.tick();
      expect(host.data().map((t) => t.label)).toEqual([
        'B',
        'A',
        'C',
        'D',
        'E',
        'F',
      ]);

      // A's element travels with it (track id) — it now renders at idx 1
      // (center 60,20); ArrowDown → nearest in the row below = idx 4
      items[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      TestBed.tick();
      expect(host.data().map((t) => t.label)).toEqual([
        'B',
        'C',
        'D',
        'E',
        'A',
        'F',
      ]);
    } finally {
      rectSpy.mockRestore();
    }
  });
});

@Component({
  selector: 'mm-mixed-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="grid" data-container="grid">
      @for (t of grid.items(); track t.id) {
        <li [mmReorderableItem]="t">{{ t.label }}</li>
      }
    </ul>
    <ul [mmReorderable]="list" data-container="list">
      @for (t of list.items(); track t.id) {
        <li [mmReorderableItem]="t">{{ t.label }}</li>
      }
    </ul>
  `,
})
class MixedHost {
  readonly group = sortableGroup<Tile>();
  readonly gridData = signal<Tile[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
    { id: 4, label: 'D' },
  ]);
  readonly listData = signal<Tile[]>([
    { id: 10, label: 'X' },
    { id: 11, label: 'Y' },
  ]);
  readonly grid = reorderable(this.gridData, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'wrap',
    group: this.group,
  });
  readonly list = reorderable(this.listData, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'y',
    group: this.group,
    // arrivals render compact here — the hover gap opens THIS much, not the
    // incoming item's own footprint
    insertSize: 15,
  });
}

describe('reorderable — list ↔ wrap grid in one group', () => {
  /**
   * Layout: wrap grid occupies x 0..120 (3 cols of 40×40, 2 rows max);
   * the linear list occupies x 200..300, rows of 40 from y 0.
   */
  function mockMixedRects() {
    return vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const kind = this.getAttribute('data-container');
        if (kind === 'grid') {
          return {
            top: 0, left: 0, right: 120, bottom: 120,
            width: 120, height: 120, x: 0, y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (kind === 'list') {
          return {
            top: 0, left: 200, right: 300, bottom: 200,
            width: 100, height: 200, x: 200, y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        const parent = this.parentElement;
        const idx = parent ? Array.from(parent.children).indexOf(this) : 0;
        if (parent?.getAttribute('data-container') === 'list') {
          return {
            top: idx * 40, bottom: idx * 40 + 40, left: 200, right: 300,
            width: 100, height: 40, x: 200, y: idx * 40,
            toJSON: () => ({}),
          } as DOMRect;
        }
        const col = idx % 3;
        const row = Math.floor(idx / 3);
        return {
          top: row * 40, bottom: row * 40 + 40,
          left: col * 40, right: col * 40 + 40,
          width: 40, height: 40, x: col * 40, y: row * 40,
          toJSON: () => ({}),
        } as DOMRect;
      });
  }

  function setup() {
    const rectSpy = mockMixedRects();
    const fixture = TestBed.createComponent(MixedHost);
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    const host = fixture.componentInstance;
    const gridItems = Array.from(
      fixture.nativeElement.querySelectorAll('[data-container="grid"] li'),
    ) as HTMLElement[];
    const listItems = Array.from(
      fixture.nativeElement.querySelectorAll('[data-container="list"] li'),
    ) as HTMLElement[];
    return { fixture, host, gridItems, listItems, rectSpy };
  }

  it('drags a grid tile into the linear list at the pointed index', () => {
    const { host, gridItems, rectSpy } = setup();
    try {
      gridItems[0].dispatchEvent(pe('pointerdown', 20, 20));
      gridItems[0].dispatchEvent(pe('pointermove', 250, 50)); // past X's center (20)
      TestBed.tick();
      gridItems[0].dispatchEvent(pe('pointerup', 250, 50));
      TestBed.tick();

      expect(host.gridData().map((t) => t.label)).toEqual(['B', 'C', 'D']);
      expect(host.listData().map((t) => t.label)).toEqual(['X', 'A', 'Y']);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('drags a list row into the wrap grid at the nearest slot (virtual append included)', () => {
    const { host, listItems, rectSpy } = setup();
    try {
      // X (center 250,20) → grid slot near (60,60): reading-order index 4
      listItems[0].dispatchEvent(pe('pointerdown', 250, 20));
      listItems[0].dispatchEvent(pe('pointermove', 60, 60));
      TestBed.tick();
      listItems[0].dispatchEvent(pe('pointerup', 60, 60));
      TestBed.tick();

      expect(host.listData().map((t) => t.label)).toEqual(['Y']);
      expect(host.gridData().map((t) => t.label)).toEqual([
        'A',
        'B',
        'C',
        'D',
        'X',
      ]);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('a linear target opens its OWN insertSize gap for an incoming grid tile', () => {
    const { host, gridItems, rectSpy } = setup();
    try {
      // drag tile A over the list, past X's center → insert 1: Y opens a gap
      gridItems[0].dispatchEvent(pe('pointerdown', 20, 20));
      gridItems[0].dispatchEvent(pe('pointermove', 250, 50));
      TestBed.tick();

      const yState = host.list.itemState(() => host.listData()[1]);
      const xState = host.list.itemState(() => host.listData()[0]);
      expect(yState.transform()).toBe(15); // insertSize, NOT the tile's 40px pitch
      expect(xState.transform()).toBe(0);
      expect(host.list.reservedSpace()).toBe(15);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('a REFUSED cross-drop keeps the item in the source list (no data loss)', () => {
    const { host, listItems, rectSpy } = setup();
    try {
      // a grid-like member that accepts hover but refuses every drop
      host.group.register({
        bounds: () => ({ top: 300, left: 0, width: 120, height: 100 }),
        refreshBounds: () => undefined,
        measure: () => ({ centers: [], axis: 'y' as const }),
        insertAt: () => false,
        insertAtPoint: () => false,
      });
      const before = host.listData();

      listItems[0].dispatchEvent(pe('pointerdown', 250, 20));
      listItems[0].dispatchEvent(pe('pointermove', 60, 350)); // over the refuser
      TestBed.tick();
      listItems[0].dispatchEvent(pe('pointerup', 60, 350));
      TestBed.tick();

      expect(host.listData()).toEqual(before); // X stayed home
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('disposing the hovered TARGET clears the group state (no commit into a dead list)', () => {
    const { host, gridItems, rectSpy } = setup();
    try {
      gridItems[0].dispatchEvent(pe('pointerdown', 20, 20));
      gridItems[0].dispatchEvent(pe('pointermove', 250, 50)); // over the list
      TestBed.tick();

      host.list.dispose(); // conditional render tears the target down mid-drag
      gridItems[0].dispatchEvent(pe('pointerup', 250, 50));
      TestBed.tick();

      // the drop degrades to a same-list reorder: nothing lands in the dead
      // list and nothing is lost or duplicated
      expect(host.listData().map((t) => t.label)).toEqual(['X', 'Y']);
      expect(new Set(host.gridData().map((t) => t.label))).toEqual(
        new Set(['A', 'B', 'C', 'D']),
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('a wrap target opens a 2D slot gap for the incoming foreign item', () => {
    const { host, listItems, rectSpy } = setup();
    try {
      // X hovers the grid's FIRST slot (20,20) → insert 0: every tile shifts one slot
      listItems[0].dispatchEvent(pe('pointerdown', 250, 20));
      listItems[0].dispatchEvent(pe('pointermove', 21, 21));
      TestBed.tick();

      const state = (i: number) =>
        host.grid.itemState(() => host.gridData()[i]);
      // A (0,0 → slot 1): (+40, 0); C (slot 2 → 3): wraps down (-80, +40)
      expect(state(0).transformX()).toBe(40);
      expect(state(0).transformY()).toBe(0);
      expect(state(2).transformX()).toBe(-80);
      expect(state(2).transformY()).toBe(40);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();
      expect(host.gridData().map((t) => t.label)).toEqual(['A', 'B', 'C', 'D']);
    } finally {
      rectSpy.mockRestore();
    }
  });
});
