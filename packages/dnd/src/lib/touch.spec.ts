import {
  Component,
  ElementRef,
  inject,
  signal,
  type Provider,
  type EnvironmentProviders,
  type Type,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  Canvas,
  CanvasHandle,
  CanvasItem,
  CanvasResizeHandle,
  CanvasRotateHandle,
  canvas,
  injectCanvas,
  injectCanvasDefaults,
  provideCanvasDefaults,
  type CanvasController,
} from './canvas';
import { movable } from './canvas/movable';
import {
  draggable,
  injectDraggableDefaults,
  provideDraggableDefaults,
} from './element/draggable';
import {
  injectPlacementGrid,
  injectPlacementGridDefaults,
  PlacementGrid,
  PlacementGridItem,
  PlacementGridResizeHandle,
  placementGrid,
  providePlacementGridDefaults,
  type GridPlacement,
  type PlacementGridController,
} from './grid';
import { provideDndDefaults } from './provide';
import {
  injectReorderable,
  injectReorderableDefaults,
  provideReorderableDefaults,
  Reorderable,
  ReorderableHandle,
  ReorderableItem,
  reorderable,
  reorderableItemTouchAction,
  sortableGroup,
  type ReorderableController,
  type ReorderableOptions,
} from './sortable';

vi.mock('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter', () => ({
  draggable: vi.fn(() => () => undefined),
  dropTargetForElements: vi.fn(() => () => undefined),
  monitorForElements: vi.fn(() => () => undefined),
}));

const LONG_PRESS = { delay: 250 } as const;

function pe(
  type: string,
  x: number,
  y: number,
  pointerType = 'touch',
  pointerId = 1,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId,
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

function touchMoveBlocked(el: Element): boolean {
  const e = new Event('touchmove', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

const touchAction = (el: Element | null) =>
  (el as HTMLElement | null)?.style.getPropertyValue('touch-action') ?? null;

/** Rows stacked by DOM order, 40px tall, 100px wide; containers 600x400 at 0,0. */
function mockRects() {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-mm-reorderable-item')) {
        const parent = this.parentElement;
        const idx = parent ? Array.from(parent.children).indexOf(this) : 0;
        return rect(0, idx * 40, 100, 40);
      }
      return rect(0, 0, 600, 400);
    });
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

type Row = { id: number; label: string };
const rows = (): Row[] => [
  { id: 1, label: 'A' },
  { id: 2, label: 'B' },
  { id: 3, label: 'C' },
];

function listHost(
  opts: Partial<ReorderableOptions<Row, number>>,
  withHandle = false,
): Type<{
  data: WritableSignal<Row[]>;
  list: ReorderableController<Row, number>;
}> {
  @Component({
    selector: 'mm-touch-list',
    imports: [Reorderable, ReorderableItem, ReorderableHandle],
    template: `
      <ul [mmReorderable]="list">
        @for (r of list.items(); track r.id) {
          <li [mmReorderableItem]="r">
            @if (withHandle) {
              <span mmReorderableHandle class="grip">::</span>
            }
            {{ r.label }}
          </li>
        }
      </ul>
    `,
  })
  class ListHost {
    readonly withHandle = withHandle;
    readonly data = signal<Row[]>(rows());
    readonly list = injectReorderable(this.data, {
      key: (r: Row) => r.id,
      ...opts,
    } as ReorderableOptions<Row, number>);
  }
  return ListHost;
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
  return fixture;
}

describe('touch long-press: DI defaults and per-call precedence', () => {
  function inCtx<T>(
    providers: (Provider | EnvironmentProviders)[],
    fn: () => T,
  ): T {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers });
    return TestBed.runInInjectionContext(fn);
  }
  const src = () => signal<Row[]>(rows());
  const cells = () => signal<(GridPlacement & { id: string })[]>([]);

  it('provideDndDefaults turns it on for every pointer-driven primitive', () => {
    inCtx([provideDndDefaults({ touchActivation: LONG_PRESS })], () => {
      expect(injectReorderableDefaults()?.touchActivation).toEqual(LONG_PRESS);
      expect(injectDraggableDefaults()?.touchActivation).toEqual(LONG_PRESS);
      expect(injectPlacementGridDefaults()).toEqual({
        touchActivation: LONG_PRESS,
      });
      expect(injectCanvasDefaults()).toEqual({ touchActivation: LONG_PRESS });

      const resolved = { delay: 250, tolerance: 5 };
      const list = injectReorderable(src(), {
        key: (r) => r.id,
        engine: 'pointer',
      });
      expect(list.touchActivation).toEqual(resolved);
      const grid = injectPlacementGrid(cells(), { key: (c) => c.id, cols: 4 });
      expect(grid.touchActivation).toEqual(resolved);
      const board = injectCanvas(signal<readonly Row[]>([]), {
        key: (r) => r.id,
        frame: () => ({ x: 0, y: 0, width: 1, height: 1 }),
        patch: (r) => r,
      });
      expect(board.touchActivation).toEqual(resolved);
    });
  });

  it('native-engine lists ignore it (the browser owns touch activation there)', () => {
    inCtx([provideDndDefaults({ touchActivation: LONG_PRESS })], () => {
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const list = injectReorderable(src(), { key: (r) => r.id });
      expect(list.engine).toBe('native');
      expect(list.touchActivation).toBeNull();
      expect(warn).not.toHaveBeenCalled(); // a common default is not a misconfiguration
      warn.mockRestore();
    });
  });

  it('a per-primitive default wins over the common one, `false` included', () => {
    inCtx(
      [
        provideDndDefaults({ touchActivation: LONG_PRESS }),
        provideReorderableDefaults({
          touchActivation: { delay: 400, tolerance: 8 },
        }),
        providePlacementGridDefaults({ touchActivation: false }),
        provideCanvasDefaults({ touchActivation: false }),
        provideDraggableDefaults({ touchActivation: false }),
      ],
      () => {
        const list = injectReorderable(src(), {
          key: (r) => r.id,
          engine: 'pointer',
        });
        expect(list.touchActivation).toEqual({ delay: 400, tolerance: 8 });
        expect(
          injectPlacementGrid(cells(), { key: (c) => c.id, cols: 4 })
            .touchActivation,
        ).toBeNull();
        expect(injectCanvasDefaults()?.touchActivation).toBe(false);
        expect(injectDraggableDefaults()?.touchActivation).toBe(false);
      },
    );
  });

  it('a per-call option always wins, and `false` opts one instance out', () => {
    inCtx([provideDndDefaults({ touchActivation: LONG_PRESS })], () => {
      const off = injectReorderable(src(), {
        key: (r) => r.id,
        engine: 'pointer',
        touchActivation: false,
      });
      expect(off.touchActivation).toBeNull();
      const own = injectPlacementGrid(cells(), {
        key: (c) => c.id,
        cols: 4,
        touchActivation: { delay: 120, tolerance: 2 },
      });
      expect(own.touchActivation).toEqual({ delay: 120, tolerance: 2 });
    });
  });

  it('off by default: library behaviour is unchanged without configuration', () => {
    inCtx([], () => {
      expect(
        injectReorderable(src(), { key: (r) => r.id, engine: 'pointer' })
          .touchActivation,
      ).toBeNull();
      expect(
        injectPlacementGrid(cells(), { key: (c) => c.id, cols: 4 })
          .touchActivation,
      ).toBeNull();
    });
    // the pure factories never read DI
    expect(
      reorderable(src(), { key: (r) => r.id, engine: 'pointer' })
        .touchActivation,
    ).toBeNull();
    expect(
      placementGrid(cells(), { key: (c) => c.id, cols: 4 }).touchActivation,
    ).toBeNull();
    expect(
      canvas(signal<readonly Row[]>([]), {
        key: (r) => r.id,
        frame: () => ({ x: 0, y: 0, width: 1, height: 1 }),
        patch: (r) => r,
      }).touchActivation,
    ).toBeNull();
  });

  it('a per-call touchActivation on a native list warns in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const opts = {
      key: (r: Row) => r.id,
      touchActivation: LONG_PRESS,
    } as unknown as ReorderableOptions<Row, number>;
    expect(reorderable(src(), opts).touchActivation).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('`touchActivation`'),
    );
    warn.mockRestore();
  });
});

describe('touch-action per configuration', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each([
    ['axis y, no handle', { engine: 'pointer', axis: 'y' }, 'pan-x'],
    ['axis x, no handle', { engine: 'pointer', axis: 'x' }, 'pan-y'],
    ['axis wrap', { engine: 'pointer', axis: 'wrap' }, 'none'],
    ['native axis y', { axis: 'y' }, 'pan-x'],
    ['native axis x', { axis: 'x' }, 'pan-y'],
    [
      'grouped axis y (drags in 2D)',
      { engine: 'pointer', axis: 'y', group: sortableGroup() },
      'none',
    ],
    [
      'long-press',
      { engine: 'pointer', axis: 'y', touchActivation: LONG_PRESS },
      'manipulation',
    ],
    [
      'long-press, wrap',
      { engine: 'pointer', axis: 'wrap', touchActivation: LONG_PRESS },
      'manipulation',
    ],
  ] as const)('reorderable item: %s → %s', (_, opts, expected) => {
    const fixture = render(
      listHost(opts as Partial<ReorderableOptions<Row, number>>),
    );
    const items = fixture.nativeElement.querySelectorAll('li');
    expect(items.length).toBe(3);
    for (const li of items) expect(touchAction(li)).toBe(expected);
  });

  it.each([
    ['plain', { engine: 'pointer', axis: 'x' }, 'none'],
    [
      'long-press',
      { engine: 'pointer', axis: 'x', touchActivation: LONG_PRESS },
      'manipulation',
    ],
  ] as const)(
    'reorderable handle (%s): the item body stays scrollable, the grip carries %s',
    (_, opts, expected) => {
      const fixture = render(
        listHost(opts as Partial<ReorderableOptions<Row, number>>, true),
      );
      const li = fixture.nativeElement.querySelector('li');
      expect(touchAction(li)).toBe('');
      expect(touchAction(li.querySelector('.grip'))).toBe(expected);
    },
  );

  it('reorderableItemTouchAction is the same rule for custom item directives', () => {
    const touch = { delay: 250, tolerance: 5 };
    const group = sortableGroup();
    expect(
      reorderableItemTouchAction({ axis: 'y', touchActivation: null }),
    ).toBe('pan-x');
    expect(
      reorderableItemTouchAction({ axis: 'x', touchActivation: null }),
    ).toBe('pan-y');
    expect(
      reorderableItemTouchAction({ axis: 'wrap', touchActivation: null }),
    ).toBe('none');
    expect(
      reorderableItemTouchAction({ axis: 'y', group, touchActivation: null }),
    ).toBe('none');
    expect(
      reorderableItemTouchAction({ axis: 'y', touchActivation: touch }),
    ).toBe('manipulation');
  });

  type Cell = GridPlacement & { id: string };
  function gridHost(touch?: { delay: number }) {
    @Component({
      selector: 'mm-touch-grid',
      imports: [PlacementGrid, PlacementGridItem, PlacementGridResizeHandle],
      template: `
        <div [mmPlacementGrid]="grid" class="grid">
          @for (c of grid.items(); track c.id) {
            <div [mmPlacementGridItem]="c" class="cell">
              <span mmPlacementGridResizeHandle="se" class="grip"></span>
            </div>
          }
        </div>
      `,
    })
    class GridHost {
      readonly cells = signal<Cell[]>([{ id: 'a', x: 0, y: 0, w: 2, h: 1 }]);
      readonly grid: PlacementGridController<Cell, string> =
        injectPlacementGrid(this.cells, {
          key: (c) => c.id,
          cols: 6,
          touchActivation: touch,
        });
    }
    return GridHost;
  }

  it.each([
    ['plain', undefined, 'none'],
    ['long-press', LONG_PRESS, 'manipulation'],
  ] as const)(
    'placement grid item (%s) → %s; its resize grip always claims the touch',
    (_, touch, expected) => {
      const fixture = render(gridHost(touch));
      const cell = fixture.nativeElement.querySelector('.cell');
      expect(touchAction(cell)).toBe(expected);
      // a grip starts at once even under a long-press, so it never lets the page pan
      expect(touchAction(cell.querySelector('.grip'))).toBe('none');
    },
  );

  type Box = {
    id: string;
    frame: { x: number; y: number; width: number; height: number };
  };
  function canvasHost(touch?: { delay: number }) {
    @Component({
      selector: 'mm-touch-canvas',
      imports: [
        Canvas,
        CanvasItem,
        CanvasHandle,
        CanvasResizeHandle,
        CanvasRotateHandle,
      ],
      template: `
        <div [mmCanvas]="board" class="surface">
          @for (b of board.items(); track b.id) {
            <div [mmCanvasItem]="b" class="box">
              <span mmCanvasHandle class="move"></span>
            </div>
          }
          <span mmCanvasResizeHandle="se" class="resize"></span>
          <span mmCanvasRotateHandle class="rotate"></span>
        </div>
      `,
    })
    class CanvasHost {
      readonly boxes = signal<readonly Box[]>([
        { id: 'a', frame: { x: 10, y: 10, width: 50, height: 50 } },
      ]);
      readonly board: CanvasController<Box, string> = injectCanvas(this.boxes, {
        key: (b) => b.id,
        frame: (b) => b.frame,
        patch: (b, frame) => ({ ...b, frame }),
        touchActivation: touch,
      });
    }
    return CanvasHost;
  }

  it.each([
    ['plain', undefined, 'none'],
    ['long-press', LONG_PRESS, 'manipulation'],
  ] as const)(
    'canvas surface + move handle (%s) → %s; resize/rotate grips always claim the touch',
    (_, touch, expected) => {
      const fixture = render(canvasHost(touch));
      const root: HTMLElement = fixture.nativeElement;
      for (const sel of ['.surface', '.move']) {
        expect([sel, touchAction(root.querySelector(sel))]).toEqual([
          sel,
          expected,
        ]);
      }
      for (const sel of ['.resize', '.rotate']) {
        expect([sel, touchAction(root.querySelector(sel))]).toEqual([
          sel,
          'none',
        ]);
      }
      expect(touchAction(root.querySelector('.box'))).toBe(''); // inherits the surface's
    },
  );

  it('a DI default reaches the directives too', () => {
    const fixture = render(listHost({ engine: 'pointer', axis: 'y' }), [
      provideDndDefaults({ touchActivation: LONG_PRESS }),
    ]);
    expect(touchAction(fixture.nativeElement.querySelector('li'))).toBe(
      'manipulation',
    );
  });
});

describe('touch long-press through the real directives', () => {
  let rectSpy: ReturnType<typeof mockRects>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rectSpy = mockRects();
  });
  afterEach(() => {
    rectSpy.mockRestore();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  function list() {
    const fixture = render(
      listHost({ engine: 'pointer', axis: 'y', touchActivation: LONG_PRESS }),
    );
    const host = fixture.componentInstance;
    const first = fixture.nativeElement.querySelector('li') as HTMLElement;
    const fire = (e: Event) => {
      first.dispatchEvent(e);
      TestBed.tick();
    };
    const labels = () =>
      host
        .data()
        .map((r) => r.label)
        .join('');
    return { fixture, host, first, fire, labels };
  }

  it('reorderable: a touch that rests for the delay then moves reorders', () => {
    const { host, first, fire, labels } = list();
    fire(pe('pointerdown', 5, 20));
    advance(250);
    expect(host.list.activeKey()).toBeNull(); // armed, not yet past the threshold
    fire(pe('pointermove', 5, 70));
    expect(host.list.activeKey()).toBe(1);
    expect(touchMoveBlocked(first)).toBe(true);
    fire(pe('pointerup', 5, 70));
    expect(labels()).toBe('BAC');
  });

  it('reorderable: a quick touch swipe is a scroll: no drag, nothing blocked, nothing written', () => {
    const { host, first, fire, labels } = list();
    fire(pe('pointerdown', 5, 20));
    fire(pe('pointermove', 5, 70)); // before the delay, past the tolerance
    expect(host.list.activeKey()).toBeNull();
    expect(touchMoveBlocked(first)).toBe(false);
    advance(1000);
    fire(pe('pointermove', 5, 110));
    fire(pe('pointerup', 5, 110));
    expect(host.list.activeKey()).toBeNull();
    expect(labels()).toBe('ABC');
  });

  it('reorderable: the mouse is never delayed, even with a long-press configured', () => {
    const { host, fire, labels } = list();
    fire(pe('pointerdown', 5, 20, 'mouse'));
    fire(pe('pointermove', 5, 70, 'mouse'));
    expect(host.list.activeKey()).toBe(1);
    fire(pe('pointerup', 5, 70, 'mouse'));
    expect(labels()).toBe('BAC');
  });

  it('placement grid: a touch move starts only after the long-press', () => {
    type Cell = GridPlacement & { id: string };
    @Component({
      selector: 'mm-touch-grid-drag',
      imports: [PlacementGrid, PlacementGridItem],
      template: `
        <div [mmPlacementGrid]="grid">
          @for (c of grid.items(); track c.id) {
            <div [mmPlacementGridItem]="c" class="cell"></div>
          }
        </div>
      `,
    })
    class GridDragHost {
      readonly cells = signal<Cell[]>([{ id: 'a', x: 0, y: 0, w: 1, h: 1 }]);
      readonly grid = injectPlacementGrid(this.cells, {
        key: (c: Cell) => c.id,
        cols: 6,
        touchActivation: LONG_PRESS,
      });
    }
    const fixture = render(GridDragHost);
    const grid = fixture.componentInstance.grid;
    const cell = fixture.nativeElement.querySelector('.cell') as HTMLElement;
    const fire = (e: Event) => {
      cell.dispatchEvent(e);
      TestBed.tick();
    };
    fire(pe('pointerdown', 20, 20));
    fire(pe('pointermove', 23, 24)); // 5px: the activation threshold, inside the tolerance
    expect(grid.activeKey()).toBeNull();
    advance(250);
    fire(pe('pointermove', 30, 30));
    expect(grid.activeKey()).toBe('a');
    fire(pe('pointercancel', 30, 30));
    expect(grid.activeKey()).toBeNull();
  });

  it('canvas: a touch move starts only after the long-press', () => {
    type Box = {
      id: string;
      frame: { x: number; y: number; width: number; height: number };
    };
    @Component({
      selector: 'mm-touch-canvas-drag',
      imports: [Canvas, CanvasItem],
      template: `
        <div [mmCanvas]="board">
          @for (b of board.items(); track b.id) {
            <div [mmCanvasItem]="b" class="box"></div>
          }
        </div>
      `,
    })
    class CanvasDragHost {
      readonly boxes = signal<readonly Box[]>([
        { id: 'a', frame: { x: 0, y: 0, width: 50, height: 50 } },
      ]);
      readonly board = injectCanvas(this.boxes, {
        key: (b: Box) => b.id,
        frame: (b: Box) => b.frame,
        patch: (b: Box, frame) => ({ ...b, frame }),
        touchActivation: LONG_PRESS,
      });
    }
    const fixture = render(CanvasDragHost);
    const board = fixture.componentInstance.board;
    const box = fixture.nativeElement.querySelector('.box') as HTMLElement;
    const fire = (e: Event) => {
      box.dispatchEvent(e);
      TestBed.tick();
    };
    fire(pe('pointerdown', 20, 20));
    fire(pe('pointermove', 23, 23));
    expect(board.liveFrames()).toBeNull();
    advance(250);
    fire(pe('pointermove', 40, 40));
    expect(board.liveFrames()?.has('a')).toBe(true);
    fire(pe('pointerup', 40, 40));
    expect(board.liveFrames()).toBeNull();
    expect(fixture.componentInstance.boxes()[0].frame).toMatchObject({
      x: 20,
      y: 20,
    });
  });

  it('draggable (pointer engine): onDragStart waits for the long-press; mouse does not', () => {
    const starts: string[] = [];
    @Component({ selector: 'mm-touch-draggable', template: '' })
    class DraggableHost {
      readonly ref = draggable({
        data: 'card',
        engine: 'pointer',
        touchActivation: LONG_PRESS,
        onDragStart: () => starts.push('start'),
      });
    }
    const fixture = render(DraggableHost);
    const el = fixture.nativeElement as HTMLElement;
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 3, 3)); // 4.2px: within the tolerance
    el.dispatchEvent(pe('pointermove', 0, 30)); // a swipe before the delay
    advance(500);
    el.dispatchEvent(pe('pointermove', 0, 60));
    expect(starts).toEqual([]);
    el.dispatchEvent(pe('pointerup', 0, 60));

    el.dispatchEvent(pe('pointerdown', 0, 0, 'touch', 2));
    advance(250);
    el.dispatchEvent(pe('pointermove', 0, 10, 'touch', 2));
    expect(starts).toEqual(['start']);
    expect(touchMoveBlocked(el)).toBe(true);
    el.dispatchEvent(pe('pointerup', 0, 10, 'touch', 2));

    el.dispatchEvent(pe('pointerdown', 0, 0, 'mouse', 3));
    el.dispatchEvent(pe('pointermove', 0, 10, 'mouse', 3));
    expect(starts).toEqual(['start', 'start']);
    el.dispatchEvent(pe('pointerup', 0, 10, 'mouse', 3));
  });

  it('movable: falls back to the common DI default and gates touch the same way', () => {
    @Component({ selector: 'mm-touch-movable', template: '' })
    class MovableHost {
      readonly pos = signal({ x: 0, y: 0 });
      readonly el = inject(ElementRef).nativeElement as HTMLElement;
      readonly ref = movable(this.pos);
    }
    const fixture = render(MovableHost, [
      provideDndDefaults({ touchActivation: LONG_PRESS }),
    ]);
    const host = fixture.componentInstance;
    const fire = (e: Event) => {
      host.el.dispatchEvent(e);
      TestBed.tick();
    };
    fire(pe('pointerdown', 0, 0));
    fire(pe('pointermove', 4, 0));
    expect(host.ref.moving()).toBe(false);
    advance(250);
    expect(host.ref.moving()).toBe(true);
    fire(pe('pointermove', 30, 0));
    fire(pe('pointerup', 30, 0));
    expect(host.pos()).toEqual({ x: 30, y: 0 });
  });
});
