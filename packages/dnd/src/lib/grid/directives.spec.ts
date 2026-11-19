import {
  Component,
  PLATFORM_ID,
  signal,
  type EnvironmentProviders,
  type Provider,
  type Type,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { provideDnd } from '../provide';
import { sortableGroup, type SortableGroup } from '../sortable/group';
import {
  injectPlacementGrid,
  type PlacementGridController,
  type PlacementGridOptions,
} from './controller';
import {
  connectPlacementGrid,
  connectPlacementGridItem,
  PlacementGrid,
  PlacementGridItem,
  PlacementGridResizeHandle,
} from './directives';
import type { GridPlacement } from './layout';

vi.mock('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

type Cell = GridPlacement & { id: string };
const c_ = (id: string, x: number, y: number, w = 2, h = 2): Cell => ({
  id,
  x,
  y,
  w,
  h,
});

/** 600px wide grid, 6 cols, gap 8: unitX 560/6, a column step of 560/6 + 8. */
const WIDTH = 600;
const COLS = 6;
const GAP = 8;
const ROW = 56;
const UNIT_X = (WIDTH - GAP * (COLS - 1)) / COLS;
const STEP_X = UNIT_X + GAP;
const STEP_Y = ROW + GAP;

/** A ResizeObserver that reports its first observation on `observe`, like a real one. */
class FakeResizeObserver {
  static width = WIDTH;
  static live = new Set<FakeResizeObserver>();
  private readonly targets: Element[] = [];
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.live.add(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
    this.report();
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    FakeResizeObserver.live.delete(this);
  }
  report(): void {
    const entries = this.targets.map(
      (target) =>
        ({
          target,
          contentRect: { width: FakeResizeObserver.width },
        }) as unknown as ResizeObserverEntry,
    );
    if (entries.length) {
      this.cb(entries, this as unknown as ResizeObserver);
    }
  }
  static resizeAll(width: number): void {
    FakeResizeObserver.width = width;
    for (const ro of FakeResizeObserver.live) ro.report();
  }
}

function rect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    x,
    y,
    toJSON: () => ({}),
  } as DOMRect;
}

function pe(type: string, x: number, y: number, pointerType = 'mouse'): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    button: 0,
    pointerType,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return e;
}

type HostShape = {
  cells: ReturnType<typeof signal<Cell[]>>;
  grid: PlacementGridController<Cell, string>;
};

function gridHost(
  initial: Cell[],
  opts: Partial<PlacementGridOptions<Cell, string>> = {},
  grip: 'se' | 'e' | 's' | 'bare' = 'se',
): Type<HostShape> {
  @Component({
    selector: 'mm-grid-spec-host',
    imports: [PlacementGrid, PlacementGridItem, PlacementGridResizeHandle],
    template: `
      <div class="outer" (pointerdown)="outerPresses = outerPresses + 1">
        <div [mmPlacementGrid]="grid" class="grid">
          @for (c of grid.items(); track $index) {
            <div [mmPlacementGridItem]="c" class="cell" [attr.data-id]="c.id">
              @if (bare) {
                <i class="grip" mmPlacementGridResizeHandle></i>
              } @else {
                <i class="grip" [mmPlacementGridResizeHandle]="dir"></i>
              }
            </div>
          }
        </div>
      </div>
    `,
  })
  class GridHost {
    outerPresses = 0;
    readonly bare = grip === 'bare';
    readonly dir: 'se' | 'e' | 's' = grip === 'bare' ? 'se' : grip;
    readonly cells = signal<Cell[]>(initial);
    readonly grid = injectPlacementGrid(this.cells, {
      key: (c: Cell) => c.id,
      cols: COLS,
      gap: GAP,
      rowHeight: ROW,
      ...opts,
    });
  }
  return GridHost;
}

function render<T>(
  host: Type<T>,
  providers: (Provider | EnvironmentProviders)[] = [],
) {
  TestBed.configureTestingModule({ providers });
  const fixture = TestBed.createComponent(host);
  fixture.detectChanges();
  TestBed.tick();
  fixture.detectChanges();
  return harness(fixture as unknown as ComponentFixture<HostShape>);
}

function harness(fixture: ComponentFixture<HostShape>) {
  const host = fixture.componentInstance;
  const root = fixture.nativeElement as HTMLElement;
  const gridEl = root.querySelector('.grid') as HTMLElement;
  const cellEl = (id: string) =>
    root.querySelector(`.cell[data-id="${id}"]`) as HTMLElement;
  const units = () =>
    fixture.debugElement
      .query(By.directive(PlacementGrid))
      .injector.get(PlacementGrid).units;
  const flush = () => {
    TestBed.tick();
    fixture.detectChanges();
  };
  const fire = (el: Element, e: Event) => {
    el.dispatchEvent(e);
    flush();
  };
  /** Press `el` at (x, y), move to each point, release. */
  const drag = (
    el: Element,
    from: [number, number],
    ...to: [number, number][]
  ) => {
    fire(el, pe('pointerdown', ...from));
    for (const p of to) fire(el, pe('pointermove', ...p));
    const last = to[to.length - 1] ?? from;
    fire(el, pe('pointerup', ...last));
  };
  const at = (id: string) => host.cells().find((c) => c.id === id);
  return { fixture, host, root, gridEl, cellEl, units, flush, fire, drag, at };
}

const translate = (x: number, y: number) => `translate(${x}px, ${y}px)`;

let restoreRO: (() => void) | null = null;
function useFakeResizeObserver(width = WIDTH) {
  const original = globalThis.ResizeObserver;
  FakeResizeObserver.width = width;
  FakeResizeObserver.live.clear();
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  restoreRO = () => {
    globalThis.ResizeObserver = original;
  };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => rect(0, 0, WIDTH, 400),
  );
});
afterEach(() => {
  restoreRO?.();
  restoreRO = null;
  vi.restoreAllMocks();
});

describe('PlacementGrid: cell units', () => {
  it('before the container is measured the unit is 0, never negative, and spans keep their gaps', () => {
    // happy-dom's own ResizeObserver never reports
    const h = render(gridHost([c_('a', 0, 0)]));
    expect(h.units().unitX()).toBe(0);
    expect(h.cellEl('a').style.width).toBe(`${GAP}px`);
  });

  it('sizes items from the observed width: unitX, width and transform follow it live', () => {
    useFakeResizeObserver();
    const h = render(gridHost([c_('a', 0, 0), c_('b', 2, 1)]));
    expect(h.units().unitX()).toBeCloseTo(UNIT_X, 4);
    const b = h.cellEl('b');
    expect(b.style.transform).toBe(translate(2 * STEP_X, STEP_Y));
    expect(parseFloat(b.style.width)).toBeCloseTo(2 * UNIT_X + GAP, 4);

    FakeResizeObserver.resizeAll(300);
    h.flush();
    const unit = (300 - GAP * (COLS - 1)) / COLS;
    expect(h.units().unitX()).toBeCloseTo(unit, 4);
    expect(parseFloat(b.style.width)).toBeCloseTo(2 * unit + GAP, 4);
    expect(b.style.transform).toBe(translate(2 * (unit + GAP), STEP_Y));
  });

  it('rowHeight sets unitY and item height; without it cells are square', () => {
    useFakeResizeObserver();
    const h = render(gridHost([c_('a', 0, 0)]));
    expect(h.units().unitY()).toBe(ROW);
    expect(h.cellEl('a').style.height).toBe(`${2 * ROW + GAP}px`);

    TestBed.resetTestingModule();
    useFakeResizeObserver();
    const sq = render(gridHost([c_('a', 0, 0)], { rowHeight: undefined }));
    expect(sq.units().unitY()).toBeCloseTo(UNIT_X, 4);
  });

  it('the container is as tall as its rows, gaps between them', () => {
    const h = render(gridHost([c_('a', 0, 0, 2, 3)]));
    expect(h.gridEl.style.height).toBe(`${3 * ROW + 2 * GAP}px`);
    expect(h.units().heightPx()).toBe(3 * ROW + 2 * GAP);
  });

  it('a browser without ResizeObserver renders with a zero unit instead of throwing', () => {
    useFakeResizeObserver();
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const h = render(gridHost([c_('a', 0, 0)]));
    expect(h.units().unitX()).toBe(0);
    expect(h.units().unitY()).toBe(ROW);
  });

  it('on the server it measures nothing and still returns live units', () => {
    useFakeResizeObserver();
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const cells = signal<Cell[]>([c_('a', 0, 0, 2, 3)]);
    const binding = TestBed.runInInjectionContext(() => {
      const grid = injectPlacementGrid(cells, {
        key: (c: Cell) => c.id,
        cols: COLS,
        gap: GAP,
        rowHeight: ROW,
      });
      return connectPlacementGrid(() => grid, document.createElement('div'));
    });
    expect(binding.unitX()).toBe(0);
    expect(binding.unitY()).toBe(ROW);
    expect(binding.heightPx()).toBe(3 * ROW + 2 * GAP);
  });
});

describe('PlacementGridResizeHandle', () => {
  it("a bare grip reads as 'se' in its data attribute", () => {
    const h = render(gridHost([c_('a', 0, 0)], {}, 'bare'));
    const grip = h.cellEl('a').querySelector('.grip') as HTMLElement;
    expect(grip.getAttribute('data-mm-placement-resize')).toBe('se');
  });

  it('an explicit direction is kept', () => {
    const h = render(gridHost([c_('a', 0, 0)], {}, 'e'));
    const grip = h.cellEl('a').querySelector('.grip') as HTMLElement;
    expect(grip.getAttribute('data-mm-placement-resize')).toBe('e');
  });
});

describe('PlacementGrid: pointer gestures', () => {
  beforeEach(() => useFakeResizeObserver());

  it('dragging the body moves the item and keeps its spans; the release commits and ends the drag', () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)]));
    h.drag(h.cellEl('a'), [20, 20], [20 + 2 * STEP_X, 20]);
    expect(h.at('a')).toMatchObject({ x: 2, y: 0, w: 1, h: 1 });
    expect(h.host.grid.activeKey()).toBeNull();
  });

  it('dragging a grip resizes the item and keeps its cell', () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)]));
    const grip = h.cellEl('a').querySelector('.grip') as HTMLElement;
    h.drag(grip, [20, 20], [20 + STEP_X, 20 + STEP_Y]);
    expect(h.at('a')).toMatchObject({ x: 0, y: 0, w: 2, h: 2 });
  });

  it("an 'e' grip resizes the width only", () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], {}, 'e'));
    const grip = h.cellEl('a').querySelector('.grip') as HTMLElement;
    h.drag(grip, [20, 20], [20 + STEP_X, 20 + STEP_Y]);
    expect(h.at('a')).toMatchObject({ x: 0, y: 0, w: 2, h: 1 });
  });

  it('while moving, the dragged item follows the pointer freely; neighbours sit at their preview cells and glide', () => {
    const h = render(gridHost([c_('a', 0, 0), c_('b', 2, 0)]));
    const a = h.cellEl('a');
    const b = h.cellEl('b');
    expect(b.style.transition).toBe('none');
    h.fire(a, pe('pointerdown', 20, 20));
    h.fire(a, pe('pointermove', 57, 40));
    expect(h.host.grid.activeKey()).toBe('a');
    expect(a.style.transform).toBe(translate(37, 20));
    expect(a.classList.contains('mm-grid-dragging')).toBe(true);
    expect(a.style.zIndex).toBe('1');
    expect(b.classList.contains('mm-grid-dragging')).toBe(false);
    expect(b.style.transform).toBe(translate(2 * STEP_X, 0));
    expect(b.style.transition).toContain('200ms');
    h.fire(a, pe('pointerup', 57, 40));
    expect(a.classList.contains('mm-grid-dragging')).toBe(false);
    expect(a.style.transform).toBe(translate(0, 0));
  });

  it('while resizing, the item stays on its cell and its width previews the spans', () => {
    const h = render(gridHost([c_('b', 2, 1, 1, 1)], { compact: 'none' }));
    const b = h.cellEl('b');
    const grip = b.querySelector('.grip') as HTMLElement;
    const x0 = 2 * STEP_X + 20;
    const y0 = STEP_Y + 20;
    h.fire(grip, pe('pointerdown', x0, y0));
    h.fire(grip, pe('pointermove', x0 + STEP_X, y0));
    expect(h.host.grid.activeKey()).toBe('b');
    expect(b.style.transform).toBe(translate(2 * STEP_X, STEP_Y));
    expect(parseFloat(b.style.width)).toBeCloseTo(2 * UNIT_X + GAP, 4);
    h.fire(grip, pe('pointerup', x0 + STEP_X, y0));
    expect(h.at('b')).toMatchObject({ x: 2, y: 1, w: 2, h: 1 });
  });

  it('a claimed press does not reach an ancestor surface', () => {
    const h = render(gridHost([c_('a', 0, 0)]));
    const outer = h.root.querySelector('.outer') as HTMLElement;
    let presses = 0;
    outer.addEventListener('pointerdown', () => presses++);
    h.fire(h.gridEl, pe('pointerdown', 500, 300)); // empty grid space: not claimed
    expect(presses).toBe(1);
    h.fire(h.cellEl('a'), pe('pointerdown', 20, 20));
    expect(presses).toBe(1);
  });

  it('under a touch long-press, a resize grip still starts at once', () => {
    const h = render(
      gridHost([c_('a', 0, 0, 1, 1)], { touchActivation: { delay: 250 } }),
    );
    const grip = h.cellEl('a').querySelector('.grip') as HTMLElement;
    h.fire(grip, pe('pointerdown', 20, 20, 'touch'));
    h.fire(grip, pe('pointermove', 40, 40, 'touch'));
    expect(h.host.grid.activeKey()).toBe('a');
    h.fire(grip, pe('pointercancel', 40, 40, 'touch'));
  });
});

type AutoScrollArgs = {
  element: Element;
  axis: 'x' | 'y';
  pointer: () => { x: number; y: number };
  edge: number;
  speed: number;
  onScroll: (d: number) => void;
};
function fakeAutoScroll() {
  const calls: AutoScrollArgs[] = [];
  const stop = vi.fn();
  const plugin = vi.fn((args: { element: Element }) => {
    calls.push(args as unknown as AutoScrollArgs);
    return stop;
  });
  return {
    plugin,
    calls,
    stop,
    provider: provideDnd({ plugins: { autoScroll: plugin } }),
  };
}

describe('PlacementGrid: edge auto-scroll', () => {
  beforeEach(() => useFakeResizeObserver());

  it('a drag starts one auto-scroller per axis on the grid, with the option values and the live pointer', () => {
    const as = fakeAutoScroll();
    const h = render(
      gridHost([c_('a', 0, 0, 1, 1)], { autoScroll: { edge: 20, speed: 5 } }),
      [as.provider],
    );
    const a = h.cellEl('a');
    h.fire(a, pe('pointerdown', 20, 20));
    h.fire(a, pe('pointermove', 20, 30));
    expect(as.calls.map((c) => c.axis).sort()).toEqual(['x', 'y']);
    for (const c of as.calls) {
      expect(c.element).toBe(h.gridEl);
      expect(c.edge).toBe(20);
      expect(c.speed).toBe(5);
    }
    h.fire(a, pe('pointermove', 22, 33));
    expect(as.calls[0].pointer()).toEqual({ x: 22, y: 33 });
    h.fire(a, pe('pointerup', 22, 33));
    expect(as.stop).toHaveBeenCalledTimes(2);

    h.fire(a, pe('pointerdown', 20, 20));
    h.fire(a, pe('pointermove', 20, 30));
    expect(as.plugin).toHaveBeenCalledTimes(4);
    h.fire(a, pe('pointerup', 20, 30));
  });

  it('a scroll under a still pointer carries the projection and the dragged item along', () => {
    const as = fakeAutoScroll();
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], { autoScroll: {} }), [
      as.provider,
    ]);
    const a = h.cellEl('a');
    h.fire(a, pe('pointerdown', 20, 20));
    h.fire(a, pe('pointermove', 20, 30));
    const byAxis = (axis: 'x' | 'y') => as.calls.find((c) => c.axis === axis)!;
    byAxis('x').onScroll(30);
    h.flush();
    expect(a.style.transform).toBe(translate(30, 10));
    expect(h.host.grid.projectedCell()).toEqual({ x: 0, y: 0 });
    byAxis('y').onScroll(STEP_Y);
    h.flush();
    expect(h.host.grid.projectedCell()).toEqual({ x: 0, y: 1 });
    expect(a.style.transform).toBe(translate(30, 10 + STEP_Y));
    h.fire(a, pe('pointerup', 20, 30));
  });

  it('auto-scroll is opt-in: without the option the plugin is never started', () => {
    const as = fakeAutoScroll();
    const h = render(gridHost([c_('a', 0, 0, 1, 1)]), [as.provider]);
    h.drag(h.cellEl('a'), [20, 20], [20 + STEP_X, 20]);
    expect(as.plugin).not.toHaveBeenCalled();
    expect(h.at('a')?.x).toBe(1);
  });

  it('the option without a plugin still drags and commits', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], { autoScroll: {} }));
    h.drag(h.cellEl('a'), [20, 20], [20 + STEP_X, 20]);
    expect(h.at('a')?.x).toBe(1);
  });

  it('destroying the grid mid-drag stops its auto-scrollers', () => {
    const as = fakeAutoScroll();
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], { autoScroll: {} }), [
      as.provider,
    ]);
    const a = h.cellEl('a');
    h.fire(a, pe('pointerdown', 20, 20));
    h.fire(a, pe('pointermove', 20, 30));
    expect(as.stop).not.toHaveBeenCalled();
    h.fixture.destroy();
    expect(as.stop).toHaveBeenCalledTimes(2);
  });
});

describe('PlacementGrid: lifecycle', () => {
  beforeEach(() => useFakeResizeObserver());

  it('a destroyed grid leaves its group', () => {
    const group: SortableGroup<Cell> = sortableGroup<Cell>();
    const h = render(gridHost([c_('a', 0, 0)], { group }));
    expect(group.members()).toContain(h.host.grid);
    h.fixture.destroy();
    expect(group.members()).not.toContain(h.host.grid);
  });

  it('a removed item element drops its occurrence binding', () => {
    const h = render(gridHost([c_('a', 0, 0), c_('b', 2, 0)]));
    const b = h.cellEl('b');
    expect(h.host.grid.keyForElement(b)).toBe('b');
    h.host.cells.update((cs) => cs.filter((c) => c.id !== 'b'));
    h.flush();
    expect(h.host.grid.keyForElement(b)).toBeUndefined();
  });
});

function key(el: Element, k: string, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: k,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(e);
  return e;
}

function fakeAnnounce() {
  const announce = vi.fn();
  return { announce, provider: provideDnd({ plugins: { announce } }) };
}

describe('PlacementGridItem: keyboard', () => {
  beforeEach(() => useFakeResizeObserver());

  it('items are focusable, arrows move a cell, Shift+arrows resize, and arrows do not scroll the page', () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)]));
    const a = h.cellEl('a');
    expect(a.getAttribute('tabindex')).toBe('0');
    expect(key(a, 'ArrowRight').defaultPrevented).toBe(true);
    expect(h.at('a')).toMatchObject({ x: 1, y: 0, w: 1, h: 1 });
    key(a, 'ArrowRight', true);
    expect(h.at('a')).toMatchObject({ x: 1, y: 0, w: 2, h: 1 });
  });

  it('other keys pass through untouched', () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)]));
    const before = h.host.cells();
    expect(key(h.cellEl('a'), 'Tab').defaultPrevented).toBe(false);
    expect(h.host.cells()).toBe(before);
  });

  it('keyboard: false leaves items unfocusable and arrows inert', () => {
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], { keyboard: false }));
    const a = h.cellEl('a');
    h.flush();
    expect(a.hasAttribute('tabindex')).toBe(false);
    const before = h.host.cells();
    expect(key(a, 'ArrowRight').defaultPrevented).toBe(false);
    expect(h.host.cells()).toBe(before);
  });

  it('a committed step is announced with 1-based column and row; a refused step is silent', () => {
    const an = fakeAnnounce();
    const h = render(gridHost([c_('a', 0, 0, 1, 1)], { compact: 'none' }), [
      an.provider,
    ]);
    const a = h.cellEl('a');
    key(a, 'ArrowLeft'); // already at column 0
    expect(an.announce).not.toHaveBeenCalled();
    key(a, 'ArrowRight');
    expect(an.announce).toHaveBeenLastCalledWith('Moved to column 2, row 1');
    key(a, 'ArrowDown');
    expect(an.announce).toHaveBeenLastCalledWith('Moved to column 2, row 2');
    expect(an.announce).toHaveBeenCalledTimes(2);
  });

  it('a custom announcePlace gets the placed item', () => {
    const an = fakeAnnounce();
    const h = render(
      gridHost([c_('a', 0, 0, 1, 1)], {
        compact: 'none',
        announcePlace: (e) => `${e.item.id} ${e.x},${e.y} ${e.w}x${e.h}`,
      }),
      [an.provider],
    );
    key(h.cellEl('a'), 'ArrowRight', true);
    expect(an.announce).toHaveBeenLastCalledWith('a 0,0 2x1');
  });

  it('announcePlace: false moves without announcing', () => {
    const an = fakeAnnounce();
    const h = render(
      gridHost([c_('a', 0, 0, 1, 1)], { announcePlace: false }),
      [an.provider],
    );
    key(h.cellEl('a'), 'ArrowRight');
    expect(h.at('a')?.x).toBe(1);
    expect(an.announce).not.toHaveBeenCalled();
  });

  it('with a duplicated key, the keyboard moves the focused occurrence only', () => {
    const h = render(
      gridHost([c_('a', 0, 0, 1, 1), c_('a', 0, 1, 1, 1)], { compact: 'none' }),
    );
    const [first, second] = Array.from(
      h.root.querySelectorAll('.cell'),
    ) as HTMLElement[];
    key(second, 'ArrowRight');
    expect(h.host.cells().map((c) => [c.x, c.y])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    key(first, 'ArrowRight');
    expect(h.host.cells().map((c) => [c.x, c.y])).toEqual([
      [1, 0],
      [1, 1],
    ]);
  });
});

describe('connectPlacementGridItem: the binding signals', () => {
  beforeEach(() => useFakeResizeObserver());

  @Component({ selector: 'mm-grid-binding-host', template: '' })
  class BindingHost {
    readonly cells = signal<Cell[]>([c_('a', 0, 0), c_('b', 2, 0)]);
    readonly grid = injectPlacementGrid(this.cells, {
      key: (c: Cell) => c.id,
      cols: COLS,
      gap: GAP,
      rowHeight: ROW,
    });
    readonly unit = connectPlacementGrid(() => this.grid);
    readonly a = connectPlacementGridItem(
      () => this.grid,
      () => this.cells()[0],
      this.unit,
      document.createElement('div'),
    );
    readonly b = connectPlacementGridItem(
      () => this.grid,
      () => this.cells()[1],
      this.unit,
      document.createElement('div'),
    );
  }

  it('expose the item address at rest and the live preview during a drag', () => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(BindingHost);
    fixture.detectChanges();
    TestBed.tick();
    const { a, b, grid } = fixture.componentInstance;
    expect([a.itemKey(), a.cellX(), a.cellY(), a.spanW(), a.spanH()]).toEqual([
      'a',
      0,
      0,
      2,
      2,
    ]);
    expect([b.itemKey(), b.cellX(), b.cellY()]).toEqual(['b', 2, 0]);
    expect([a.isActive(), a.dragX(), a.dragY()]).toEqual([false, 0, 0]);
    expect(a.tabIndex()).toBe(0);
    expect(b.transitionCss()).toBe('none');

    grid.begin('a', {
      kind: 'move',
      originX: 0,
      originY: 0,
      cellW: UNIT_X,
      cellH: ROW,
      gap: GAP,
      startX: 20,
      startY: 20,
    });
    grid.move({ x: 20 + 2 * STEP_X, y: 30 });
    expect(a.isActive()).toBe(true);
    expect(a.dragX()).toBeCloseTo(2 * STEP_X, 4);
    expect(a.dragY()).toBe(10);
    expect(b.isActive()).toBe(false);
    expect([b.cellX(), b.cellY()]).toEqual([2, 2]);
    expect(b.transitionCss()).toContain('200ms');
    grid.cancel();
  });
});

describe('PlacementGrid: a controller outlives its container', () => {
  beforeEach(() => useFakeResizeObserver());

  @Component({
    selector: 'mm-grid-toggle-host',
    imports: [PlacementGrid, PlacementGridItem],
    template: `
      @if (show()) {
        <div [mmPlacementGrid]="grid" class="grid">
          @for (c of grid.items(); track c.id) {
            <div [mmPlacementGridItem]="c" class="cell"></div>
          }
        </div>
      }
    `,
  })
  class ToggleHost {
    readonly show = signal(true);
    readonly group = sortableGroup<Cell>();
    readonly cells = signal<Cell[]>([c_('a', 0, 0)]);
    readonly grid = injectPlacementGrid(this.cells, {
      key: (c: Cell) => c.id,
      cols: COLS,
      group: this.group,
    });
  }

  it('a grid container recreated with the same controller rejoins its group', () => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(ToggleHost);
    const step = () => {
      fixture.detectChanges();
      TestBed.tick();
      fixture.detectChanges();
    };
    step();
    const { group, grid, show } = fixture.componentInstance;
    expect(group.members()).toContain(grid);
    show.set(false);
    step();
    expect(group.members()).not.toContain(grid);
    show.set(true);
    step();
    expect(group.members()).toContain(grid);
    expect(group.members().filter((m) => m === grid)).toHaveLength(1);
  });
});
