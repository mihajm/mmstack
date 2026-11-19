import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { Reorderable, ReorderableItem, reorderable } from './reorderable';
import type { ReorderableAxis, ReorderKeyboardApi } from './types';

type Tile = { id: number; label: string };
type Box = { top: number; left: number; width: number; height: number };

type HostOptions = {
  axis?: ReorderableAxis;
  keyboard?: boolean;
  onKeyboardKeydown?: (e: KeyboardEvent, api: ReorderKeyboardApi<Tile>) => void;
};

let hostOptions: HostOptions = {};
let hostLabels: string[] = [];

@Component({
  selector: 'mm-keyboard-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list" data-container>
      @for (t of list.items(); track t.id) {
        <li [mmReorderableItem]="t">{{ t.label }}</li>
      }
    </ul>
  `,
})
class KeyboardHost {
  readonly data = signal<Tile[]>(
    hostLabels.map((label, i) => ({ id: i + 1, label })),
  );
  readonly reorders: Array<{ from: number; to: number }> = [];
  readonly list = reorderable(this.data, {
    key: (t) => t.id,
    engine: 'pointer',
    jumpModifier: (e) => e.shiftKey,
    onReorder: ({ from, to }) => this.reorders.push({ from, to }),
    ...hostOptions,
  });
}

/** Lays the rows out by their DOM index; the container gets a fixed box. */
function mockLayout(box: (idx: number) => Box) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      const b = this.hasAttribute('data-container')
        ? { top: 0, left: 0, width: 400, height: 400 }
        : box(parent ? Array.from(parent.children).indexOf(this) : 0);
      return {
        ...b,
        right: b.left + b.width,
        bottom: b.top + b.height,
        x: b.left,
        y: b.top,
        toJSON: () => ({}),
      } as DOMRect;
    });
}

/** 2 columns of 40x40 tiles: idx 0 1 / 2 3 / 4 5. */
const grid2 = (idx: number): Box => ({
  top: Math.floor(idx / 2) * 40,
  left: (idx % 2) * 40,
  width: 40,
  height: 40,
});

const fixtures: ComponentFixture<KeyboardHost>[] = [];

function setup(labels: string[], options: HostOptions = {}) {
  hostLabels = labels;
  hostOptions = options;
  const fixture = TestBed.createComponent(KeyboardHost);
  fixtures.push(fixture);
  fixture.detectChanges();
  TestBed.tick();
  fixture.detectChanges();
  const rows = () =>
    Array.from(fixture.nativeElement.querySelectorAll('li')) as HTMLElement[];
  const order = () => fixture.componentInstance.data().map((t) => t.label);
  const press = (
    index: number,
    key: string,
    init: KeyboardEventInit = {},
  ): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    rows()[index].dispatchEvent(event);
    fixture.detectChanges();
    TestBed.tick();
    return event;
  };
  return { host: fixture.componentInstance, order, press };
}

const announced = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? null;

beforeEach(() => {
  TestBed.resetTestingModule();
  document.body.querySelectorAll('[aria-live]').forEach((el) => el.remove());
});

afterEach(() => {
  for (const f of fixtures.splice(0)) f.destroy();
  vi.restoreAllMocks();
});

describe('keyboard reorder: linear list', () => {
  it('ArrowDown moves the item down, claims the key and announces the default message', () => {
    const { order, press } = setup(['A', 'B', 'C']);
    const e = press(0, 'ArrowDown');
    expect(order()).toEqual(['B', 'A', 'C']);
    expect(e.defaultPrevented).toBe(true);
    expect(announced()).toBe('Moved to position 2 of 3');
  });

  it('ArrowUp on the last item moves it up', () => {
    const { order, press } = setup(['A', 'B', 'C']);
    const e = press(2, 'ArrowUp');
    expect(order()).toEqual(['A', 'C', 'B']);
    expect(e.defaultPrevented).toBe(true);
  });

  it.each([
    [0, 'ArrowUp'],
    [2, 'ArrowDown'],
    [0, 'a'],
    [0, 'Tab'],
    [0, 'ArrowRight'],
  ])('row %i + %s leaves the order alone and the key to the page', (i, key) => {
    const { order, press, host } = setup(['A', 'B', 'C']);
    const e = press(i, key);
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(e.defaultPrevented).toBe(false);
    expect(host.reorders).toEqual([]);
  });

  it('the jump modifier moves to the end or the start', () => {
    const down = setup(['A', 'B', 'C']);
    down.press(0, 'ArrowDown', { shiftKey: true });
    expect(down.order()).toEqual(['B', 'C', 'A']);

    const up = setup(['A', 'B', 'C']);
    up.press(2, 'ArrowUp', { shiftKey: true });
    expect(up.order()).toEqual(['C', 'A', 'B']);
  });

  it("axis: 'x' uses Left/Right, not Up/Down", () => {
    const { order, press } = setup(['A', 'B', 'C'], { axis: 'x' });
    expect(press(0, 'ArrowDown').defaultPrevented).toBe(false);
    expect(order()).toEqual(['A', 'B', 'C']);
    press(0, 'ArrowRight');
    expect(order()).toEqual(['B', 'A', 'C']);
    press(1, 'ArrowLeft');
    expect(order()).toEqual(['A', 'B', 'C']);
  });

  it('keyboard: false disables the keys', () => {
    const { order, press } = setup(['A', 'B', 'C'], { keyboard: false });
    const e = press(0, 'ArrowDown');
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('keyboard reorder: custom handler api.move', () => {
  it('clamps the target to the last index', () => {
    const { host, order, press } = setup(['A', 'B', 'C'], {
      onKeyboardKeydown: (_e, api) => api.move(99),
    });
    press(0, 'x');
    expect(order()).toEqual(['B', 'C', 'A']);
    expect(host.reorders).toEqual([{ from: 0, to: 2 }]);
    expect(announced()).toBe('Moved to position 3 of 3');
  });

  it('is a no-op at the current index (no move, no announcement)', () => {
    const { host, order, press } = setup(['A', 'B', 'C'], {
      onKeyboardKeydown: (_e, api) => api.move(api.index),
    });
    press(1, 'x');
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(host.reorders).toEqual([]);
    expect(announced() ?? '').toBe('');
  });
});

describe("keyboard reorder: axis 'wrap'", () => {
  const six = ['A', 'B', 'C', 'D', 'E', 'F'];
  const wrap = () => {
    mockLayout(grid2);
    return setup(six, { axis: 'wrap' });
  };

  it('ArrowDown lands in the adjacent row, not a farther one', () => {
    const { order, press } = wrap();
    const e = press(0, 'ArrowDown');
    expect(order()).toEqual(['B', 'C', 'A', 'D', 'E', 'F']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('ArrowUp lands on the nearest tile in the row above', () => {
    const { order, press } = wrap();
    press(4, 'ArrowUp');
    expect(order()).toEqual(['A', 'B', 'E', 'C', 'D', 'F']);
  });

  it('ArrowDown on the bottom row is a no-op that leaves the key to the page', () => {
    const { order, press } = wrap();
    let e: KeyboardEvent | undefined;
    expect(() => (e = press(4, 'ArrowDown'))).not.toThrow();
    expect(order()).toEqual(six);
    expect(e?.defaultPrevented).toBe(false);
  });

  it('ArrowLeft steps back; at the first tile it leaves the key to the page', () => {
    const { order, press } = wrap();
    expect(press(0, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(order()).toEqual(six);
    press(1, 'ArrowLeft');
    expect(order()).toEqual(['B', 'A', 'C', 'D', 'E', 'F']);
  });

  it('ArrowLeft on the last tile moves it back one', () => {
    const { order, press } = wrap();
    press(5, 'ArrowLeft');
    expect(order()).toEqual(['A', 'B', 'C', 'D', 'F', 'E']);
  });

  it.each([
    ['ArrowRight', 0, ['B', 'C', 'D', 'E', 'F', 'A']],
    ['ArrowDown', 0, ['B', 'C', 'D', 'E', 'F', 'A']],
    ['ArrowLeft', 5, ['F', 'A', 'B', 'C', 'D', 'E']],
    ['ArrowUp', 5, ['F', 'A', 'B', 'C', 'D', 'E']],
  ])('jump + %s from tile %i goes to the end or the start', (key, i, want) => {
    const { order, press } = wrap();
    press(i as number, key as string, { shiftKey: true });
    expect(order()).toEqual(want);
  });

  it('an unrelated key does nothing', () => {
    const { order, press } = wrap();
    const e = press(0, 'a');
    expect(order()).toEqual(six);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a slightly taller tile in the same row is not the row below', () => {
    // row 0: a 40px tile and a 50px tile (centers 20 and 25); row 1 starts at 60
    mockLayout((idx) =>
      idx < 2
        ? { top: 0, left: idx * 40, width: 40, height: idx === 1 ? 50 : 40 }
        : { top: 60, left: (idx - 2) * 40, width: 40, height: 40 },
    );
    const { order, press } = setup(['A', 'B', 'C', 'D'], { axis: 'wrap' });
    press(0, 'ArrowDown');
    expect(order()).toEqual(['B', 'C', 'A', 'D']);
  });
});
