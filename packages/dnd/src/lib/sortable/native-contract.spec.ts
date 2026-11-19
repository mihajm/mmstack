import {
  ApplicationRef,
  Component,
  Directive,
  ErrorHandler,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { boxData } from '../internal/payload';
import { provideDnd } from '../provide';
import { DndSession, type DropTargetHit } from '../session';
import { sortableGroup } from './group';
import {
  connectReorderableItem,
  Reorderable,
  ReorderableItem,
  reorderable,
} from './reorderable';

const draggableMock = vi.fn();
const dropTargetMock = vi.fn();
vi.mock('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter', () => ({
  draggable: (c: unknown) => {
    draggableMock(c);
    return () => undefined;
  },
  dropTargetForElements: (c: unknown) => {
    dropTargetMock(c);
    return () => undefined;
  },
  monitorForElements: () => () => undefined,
}));

type Row = { id: number; label: string };
type DragCfg = {
  element: Element;
  getInitialData: () => Record<string | symbol, unknown>;
};
type DropCfg = {
  element: Element;
  canDrop?: (a: unknown) => boolean;
  onDrop?: (a: unknown) => void;
};

const rowRect = (idx: number, size = 40, axis: 'x' | 'y' = 'y') =>
  ({
    top: axis === 'y' ? idx * size : 0,
    bottom: axis === 'y' ? idx * size + size : size,
    left: axis === 'x' ? idx * size : 0,
    right: axis === 'x' ? idx * size + size : 100,
    width: axis === 'x' ? size : 100,
    height: size,
    x: axis === 'x' ? idx * size : 0,
    y: axis === 'y' ? idx * size : 0,
    toJSON: () => ({}),
  }) as DOMRect;

/** Every row measures at its live DOM index inside its parent (40px rows). */
function mockRows(axis: 'x' | 'y' = 'y') {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      const rows = parent
        ? Array.from(parent.children).filter((c) => c.tagName === 'LI')
        : [];
      const idx = Math.max(0, rows.indexOf(this));
      return rowRect(idx, 40, axis);
    });
}

function render<C>(cmp: new () => C) {
  const fixture = TestBed.createComponent(cmp);
  fixture.detectChanges();
  TestBed.tick();
  fixture.detectChanges();
  const flush = () => {
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
  };
  return { fixture, host: fixture.componentInstance, flush };
}

const dragOf = (el: Element) =>
  draggableMock.mock.calls
    .map((c) => c[0] as DragCfg)
    .find((c) => c.element === el) as DragCfg;
const dropOf = (el: Element) =>
  dropTargetMock.mock.calls
    .map((c) => c[0] as DropCfg)
    .find((c) => c.element === el) as DropCfg;

function hover(
  sourceEl: Element,
  targets: Element[],
  pointer: { x: number; y: number },
) {
  const session = TestBed.inject(DndSession).session;
  session.set({
    sourceEl: sourceEl as HTMLElement,
    sourceData: dragOf(sourceEl)?.getInitialData() ?? {},
    targets: targets.map((element): DropTargetHit => ({ element, data: {} })),
    pointer,
    kind: 'transfer',
    engine: 'native',
  });
  return () => session.set(null);
}

function drop(target: Element, sourceEl: Element) {
  dropOf(target).onDrop?.({
    source: { element: sourceEl, data: dragOf(sourceEl).getInitialData() },
    self: { element: target, data: {} },
    location: { current: { dropTargets: [] }, previous: { dropTargets: [] } },
  });
}

const labels = (rows: readonly Row[]) => rows.map((r) => r.label);

@Component({
  selector: 'mm-nested-native-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul class="outer" [mmReorderable]="outer">
      @for (n of outer.items(); track n.id) {
        <li [mmReorderableItem]="n">
          {{ n.label }}
          @if (n.id === 1) {
            <ul class="inner" [mmReorderable]="inner">
              @for (c of inner.items(); track c.id) {
                <li [mmReorderableItem]="c">{{ c.label }}</li>
              }
            </ul>
          }
        </li>
      }
    </ul>
  `,
})
class NestedNativeHost {
  readonly group = sortableGroup<Row>();
  readonly outerData = signal<Row[]>([
    { id: 1, label: 'N' },
    { id: 2, label: 'O' },
  ]);
  readonly innerData = signal<Row[]>([
    { id: 10, label: 'I1' },
    { id: 11, label: 'I2' },
  ]);
  readonly outer = reorderable(this.outerData, {
    key: (r) => r.id,
    group: this.group,
  });
  readonly inner = reorderable(this.innerData, {
    key: (r) => r.id,
    group: this.group,
  });
}

describe('native engine: nested lists in one group', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('a drop inside the inner list commits once, in the inner list only; the outer list draws no line', () => {
    const rects = mockRows();
    try {
      const { fixture, host, flush } = render(NestedNativeHost);
      const el = fixture.nativeElement as HTMLElement;
      const outerUl = el.querySelector('ul.outer') as HTMLElement;
      const innerUl = el.querySelector('ul.inner') as HTMLElement;
      const [i1, i2] = Array.from(innerUl.querySelectorAll('li'));
      const n = outerUl.querySelector('li') as HTMLElement;

      // innermost first, as pragmatic reports the stack
      const end = hover(i1, [i2, innerUl, n, outerUl], { x: 5, y: 70 });
      flush();
      expect(host.inner.nativeInsert()).toBe(2);
      expect(host.outer.nativeInsert()).toBeNull();
      expect(
        outerUl.querySelectorAll(':scope > li > mm-drop-indicator .line'),
      ).toHaveLength(0);
      expect(innerUl.querySelectorAll('.line')).toHaveLength(1);

      // pragmatic calls onDrop on every target in the stack
      drop(innerUl, i1);
      drop(outerUl, i1);
      expect(labels(host.innerData())).toEqual(['I2', 'I1']);
      expect(labels(host.outerData())).toEqual(['N', 'O']);
      end();
    } finally {
      rects.mockRestore();
    }
  });

  it('when the inner list refuses (not in the stack), the outer list owns the drop', () => {
    const rects = mockRows();
    try {
      const { fixture, host, flush } = render(NestedNativeHost);
      const el = fixture.nativeElement as HTMLElement;
      const outerUl = el.querySelector('ul.outer') as HTMLElement;
      const innerUl = el.querySelector('ul.inner') as HTMLElement;
      const i1 = innerUl.querySelector('li') as HTMLElement;
      const n = outerUl.querySelector('li') as HTMLElement;

      const end = hover(i1, [n, outerUl], { x: 5, y: 50 });
      flush();
      expect(host.outer.nativeInsert()).toBe(1);
      drop(outerUl, i1);
      expect(labels(host.outerData())).toEqual(['N', 'I1', 'O']);
      expect(labels(host.innerData())).toEqual(['I2']);
      end();
    } finally {
      rects.mockRestore();
    }
  });
});

@Component({
  selector: 'mm-grouped-native-wrap-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul class="grid" [mmReorderable]="grid">
      @for (r of grid.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="list" [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class GroupedNativeWrapHost {
  readonly group = sortableGroup<Row>();
  readonly gridData = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly listData = signal<Row[]>([{ id: 10, label: 'M' }]);
  readonly grid = reorderable(this.gridData, {
    key: (r) => r.id,
    axis: 'wrap',
    group: this.group,
  });
  readonly list = reorderable(this.listData, {
    key: (r) => r.id,
    group: this.group,
  });
}

describe("native engine: a grouped `axis: 'wrap'` list refuses drops", () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('stays native, warns that drops are refused, shows no line and ignores a drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rects = mockRows();
    try {
      const { fixture, host, flush } = render(GroupedNativeWrapHost);
      expect(host.grid.engine).toBe('native');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('refuses');
      const el = fixture.nativeElement as HTMLElement;
      const grid = el.querySelector('ul.grid') as HTMLElement;
      const m = el.querySelector('ul.list li') as HTMLElement;
      const end = hover(m, [grid.querySelector('li') as HTMLElement, grid], {
        x: 5,
        y: 5,
      });
      flush();
      expect(host.grid.nativeInsert()).toBeNull();
      expect(grid.querySelectorAll('.line')).toHaveLength(0);
      drop(grid, m);
      expect(labels(host.gridData())).toEqual(['A', 'B', 'C']);
      expect(labels(host.listData())).toEqual(['M']);
      end();
    } finally {
      rects.mockRestore();
      warn.mockRestore();
    }
  });

  it('its rows can still be dragged out into a native sibling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rects = mockRows();
    try {
      const { fixture, host, flush } = render(GroupedNativeWrapHost);
      const el = fixture.nativeElement as HTMLElement;
      const list = el.querySelector('ul.list') as HTMLElement;
      const a = el.querySelector('ul.grid li') as HTMLElement;
      const end = hover(a, [list], { x: 5, y: 30 });
      flush();
      drop(list, a);
      expect(labels(host.listData())).toEqual(['M', 'A']);
      expect(labels(host.gridData())).toEqual(['B', 'C']);
      end();
    } finally {
      rects.mockRestore();
      warn.mockRestore();
    }
  });
});

@Component({
  selector: 'mm-native-gate-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul class="a" [mmReorderable]="a">
      @for (r of a.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="b" [mmReorderable]="b">
      @for (r of b.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="c" [mmReorderable]="c">
      @for (r of c.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="d" [mmReorderable]="d">
      @for (r of d.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="e" [mmReorderable]="e">
      @for (r of e.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul class="f" [mmReorderable]="f">
      @for (r of f.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class GateHost {
  readonly g1 = sortableGroup<Row>();
  readonly g2 = sortableGroup<Row>();
  private readonly one = (id: number, label: string) =>
    signal<Row[]>([{ id, label }]);
  readonly a = reorderable(this.one(1, 'A'), {
    key: (r) => r.id,
    group: this.g1,
  });
  readonly b = reorderable(this.one(2, 'B'), {
    key: (r) => r.id,
    group: this.g1,
  });
  readonly c = reorderable(this.one(3, 'C'), {
    key: (r) => r.id,
    group: this.g2,
  });
  readonly d = reorderable(this.one(4, 'D'), {
    key: (r) => r.id,
    group: this.g1,
    canReceive: () => false,
  });
  readonly e = reorderable(this.one(5, 'E'), {
    key: (r) => r.id,
    insert: {
      accepts: (x) => typeof x === 'string',
      create: (x) => ({ id: 50, label: String(x) }),
    },
  });
  readonly f = reorderable(this.one(6, 'F'), { key: (r) => r.id });
}

describe('native engine: the drop gate', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it.each([
    ['its own row', 'a', 'row:a', true],
    ['a row of a same-group list', 'b', 'row:a', true],
    ['a row of another group', 'c', 'row:a', false],
    ['a same-group row its canReceive refuses', 'd', 'row:a', false],
    ['a row, when the list is ungrouped', 'f', 'row:a', false],
    ['its own row, when the list is ungrouped', 'f', 'row:f', true],
    ['a foreign payload its insert accepts', 'e', 'foreign:X', true],
    ['a foreign payload its insert refuses', 'e', 'foreign:42', false],
    ['a foreign payload, without insert', 'f', 'foreign:X', false],
  ])('list and row targets agree on %s', (_name, list, from, ok) => {
    const { fixture } = render(GateHost);
    const el = fixture.nativeElement as HTMLElement;
    const ul = el.querySelector(`ul.${list}`) as HTMLElement;
    const li = ul.querySelector('li') as HTMLElement;
    const [kind, what] = from.split(':');
    const source =
      kind === 'row'
        ? (() => {
            const src = el.querySelector(`ul.${what} li`) as HTMLElement;
            return { element: src, data: dragOf(src).getInitialData() };
          })()
        : {
            element: document.createElement('div'),
            data: boxData(what === '42' ? 42 : what),
          };
    expect(dropOf(ul).canDrop?.({ source })).toBe(ok);
    expect(dropOf(li).canDrop?.({ source })).toBe(ok);
  });
});

@Component({
  selector: 'mm-native-basic-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    @if (shown()) {
      <ul [mmReorderable]="list">
        @for (r of list.items(); track r.id) {
          <li [mmReorderableItem]="r">{{ r.label }}</li>
        }
      </ul>
    }
  `,
})
class BasicHost {
  readonly shown = signal(true);
  readonly group = sortableGroup<Row>();
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly onReorder = vi.fn();
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    group: this.group,
    autoScroll: {},
    onReorder: this.onReorder,
  });
}

@Component({
  selector: 'mm-native-x-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class XHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    axis: 'x',
    autoScroll: {},
    animation: { duration: 123, easing: 'linear' },
  });
}

function basic(axis: 'x' | 'y' = 'y') {
  const rects = mockRows(axis);
  const r = render(axis === 'x' ? XHost : BasicHost);
  const el = r.fixture.nativeElement as HTMLElement;
  const ul = () => el.querySelector('ul') as HTMLElement;
  const lis = () => Array.from(el.querySelectorAll('ul > li')) as HTMLElement[];
  const lines = () =>
    Array.from(el.querySelectorAll('.line')).map((l) => ({
      edge: l.getAttribute('data-edge'),
      row: lis().findIndex((li) => li.contains(l)),
    }));
  return { ...r, el, ul, lis, lines, rects };
}

describe('native engine: the container', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('draws exactly one line: before the insert row, or after the last row at the end', () => {
    const t = basic();
    try {
      expect(t.lines()).toEqual([]);
      const end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(t.lines()).toEqual([{ edge: 'top', row: 1 }]);
      end();
      hover(t.lis()[0], [t.ul()], { x: 5, y: 130 });
      t.flush();
      expect(t.lines()).toEqual([{ edge: 'bottom', row: 2 }]);
    } finally {
      t.rects.mockRestore();
    }
  });

  it('only a list in the target stack owns the drag; an idle list shows nothing', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      expect(host.list.nativeInsert()).toBeNull();
      const end = hover(t.lis()[0], [t.lis()[1], t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(host.list.nativeInsert()).toBe(1);
      end();
      t.flush();
      expect(host.list.nativeInsert()).toBeNull();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('an x list hit-tests on x and draws vertical lines', () => {
    const t = basic('x');
    try {
      const host = t.host as XHost;
      const end = hover(t.lis()[0], [t.ul()], { x: 50, y: 5 });
      t.flush();
      expect(host.list.nativeInsert()).toBe(1);
      expect(t.lines()).toEqual([{ edge: 'left', row: 1 }]);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a list changed under a moving pointer is re-measured mid-drag', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      const end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(host.list.nativeInsert()).toBe(1);
      host.data.update((arr) => [{ id: 9, label: 'X' }, ...arr]);
      t.flush();
      hover(t.lis()[1], [t.ul()], { x: 5, y: 150 });
      t.flush();
      expect(host.list.nativeInsert()).toBe(4);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a drop the session never tracked commits nothing', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      drop(t.ul(), t.lis()[0]);
      expect(labels(host.data())).toEqual(['A', 'B', 'C']);
      expect(host.onReorder).not.toHaveBeenCalled();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a second drag records its own hover, never the last drag’s', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      let end = hover(t.lis()[0], [t.ul()], { x: 5, y: 90 });
      t.flush();
      expect(host.list.nativeHoverAnchor()).toEqual({ after: 2 });
      end();
      t.flush();
      expect(host.list.nativeHoverAnchor()).toBeNull();
      host.data.set([host.data()[2], host.data()[0], host.data()[1]]);
      t.flush();
      end = hover(t.lis()[1], [t.ul()], { x: 5, y: 30 });
      t.flush();
      drop(t.ul(), t.lis()[1]);
      expect(labels(host.data())).toEqual(['C', 'A', 'B']);
      end();
      end = hover(t.lis()[2], [t.ul()], { x: 5, y: 30 });
      t.flush();
      drop(t.ul(), t.lis()[2]);
      expect(labels(host.data())).toEqual(['C', 'B', 'A']);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a destroyed list leaves its group', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      expect(host.group.members()).toContain(host.list);
      host.shown.set(false);
      t.flush();
      expect(host.group.members()).not.toContain(host.list);
      host.shown.set(true);
      t.flush();
      expect(host.group.members()).toContain(host.list);
    } finally {
      t.rects.mockRestore();
    }
  });
});

@Component({
  selector: 'mm-native-still-host',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class StillHost {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    animation: false,
  });
}

function withAnimate(run: (animate: ReturnType<typeof vi.fn>) => void) {
  const animate = vi.fn(
    () => ({ finished: Promise.resolve() }) as unknown as Animation,
  );
  const proto = HTMLElement.prototype as { animate?: unknown };
  const orig = proto.animate;
  proto.animate = animate;
  try {
    run(animate);
  } finally {
    if (orig === undefined) delete proto.animate;
    else proto.animate = orig;
  }
}

const key = (el: HTMLElement, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('native engine: auto-scroll and FLIP-on-commit', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('auto-scroll runs only during a drag, shifts the insert by the scrolled distance, and restarts clean', () => {
    const fake = { stop: vi.fn(), calls: [] as Array<Record<string, unknown>> };
    const plugin = vi.fn((o: Record<string, unknown>) => {
      fake.calls.push(o);
      return fake.stop;
    });
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    const t = basic();
    try {
      const host = t.host as BasicHost;
      expect(plugin).not.toHaveBeenCalled();
      let end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(plugin).toHaveBeenCalledTimes(1);
      expect(fake.calls[0]).toMatchObject({
        element: t.ul(),
        axis: 'y',
        edge: 48,
        speed: 16,
      });
      expect((fake.calls[0]['pointer'] as () => unknown)()).toEqual({
        x: 5,
        y: 50,
      });
      expect(host.list.nativeInsert()).toBe(1);
      (fake.calls[0]['onScroll'] as (d: number) => void)(40);
      expect(host.list.nativeInsert()).toBe(2);
      end();
      t.flush();
      expect(fake.stop).toHaveBeenCalledTimes(1);
      end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(plugin).toHaveBeenCalledTimes(2);
      expect(host.list.nativeInsert()).toBe(1);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('auto-scroll passes axis x for an x list', () => {
    const plugin = vi.fn((o: Record<string, unknown>) => {
      void o;
      return () => undefined;
    });
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    const t = basic('x');
    try {
      const end = hover(t.lis()[0], [t.ul()], { x: 50, y: 5 });
      t.flush();
      expect(plugin.mock.calls[0][0]).toMatchObject({ axis: 'x' });
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('idle renders and a drag cycle report no errors', () => {
    const handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: ErrorHandler, useValue: { handleError } }],
    });
    const t = basic();
    try {
      const end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      end();
      t.flush();
      expect(handleError).not.toHaveBeenCalled();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a committed move glides each moved row from its old place, with the configured timing', () => {
    withAnimate((animate) => {
      const t = basic();
      try {
        animate.mockClear();
        const a = t.lis()[0];
        key(a, 'ArrowDown');
        t.flush();
        const calls = animate.mock.contexts.map((ctx, i) => ({
          el: ctx as HTMLElement,
          frames: animate.mock.calls[i][0],
          timing: animate.mock.calls[i][1],
        }));
        const forA = calls.find((c) => c.el === a);
        expect(forA?.frames[0]).toEqual({ transform: 'translate(0px, -40px)' });
        expect(forA?.timing).toEqual({
          duration: 200,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        });
        expect(calls.some((c) => c.el === t.lis()[0])).toBe(true);
      } finally {
        t.rects.mockRestore();
      }
    });
  });

  it('an x list glides horizontally with its own duration and easing', () => {
    withAnimate((animate) => {
      const t = basic('x');
      try {
        animate.mockClear();
        const a = t.lis()[0];
        key(a, 'ArrowRight');
        t.flush();
        const i = animate.mock.contexts.indexOf(a);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(animate.mock.calls[i][0][0]).toEqual({
          transform: 'translate(-40px, 0px)',
        });
        expect(animate.mock.calls[i][1]).toEqual({
          duration: 123,
          easing: 'linear',
        });
        expect(animate.mock.contexts).toContain(t.lis()[0]);
      } finally {
        t.rects.mockRestore();
      }
    });
  });

  it('animation: false moves rows without a glide', () => {
    withAnimate((animate) => {
      const rects = mockRows();
      try {
        const { fixture, flush } = render(StillHost);
        const a = (fixture.nativeElement as HTMLElement).querySelector(
          'li',
        ) as HTMLElement;
        expect(() => {
          key(a, 'ArrowDown');
          flush();
        }).not.toThrow();
        expect(animate).not.toHaveBeenCalled();
      } finally {
        rects.mockRestore();
      }
    });
  });

  it('a removed row takes its indicator view with it', () => {
    const t = basic();
    try {
      const appRef = TestBed.inject(ApplicationRef);
      const before = appRef.viewCount;
      const host = t.host as BasicHost;
      host.data.update((arr) => arr.slice(1));
      t.flush();
      expect(appRef.viewCount).toBe(before - 1);
    } finally {
      t.rects.mockRestore();
    }
  });
});

describe('native engine: the hover anchor follows the pointer and the scroll', () => {
  beforeEach(() => {
    draggableMock.mockReset();
    dropTargetMock.mockReset();
  });

  it('a pointer that moves on re-records the slot: the drop lands where it ended', () => {
    const t = basic();
    try {
      const host = t.host as BasicHost;
      const a = t.lis()[0];
      hover(a, [t.ul()], { x: 5, y: 50 });
      t.flush();
      const end = hover(a, [t.ul()], { x: 5, y: 90 });
      t.flush();
      drop(t.ul(), a);
      expect(labels(host.data())).toEqual(['B', 'A', 'C']);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('auto-scroll under a still pointer re-records the slot too', () => {
    let onScroll: ((d: number) => void) | undefined;
    TestBed.configureTestingModule({
      providers: [
        provideDnd({
          plugins: {
            autoScroll: (o) => {
              onScroll = o['onScroll'] as (d: number) => void;
              return () => undefined;
            },
          },
        }),
      ],
    });
    const t = basic();
    try {
      const host = t.host as BasicHost;
      const a = t.lis()[0];
      const end = hover(a, [t.ul()], { x: 5, y: 50 });
      t.flush();
      onScroll?.(40);
      t.flush();
      drop(t.ul(), a);
      expect(labels(host.data())).toEqual(['B', 'A', 'C']);
      end();
    } finally {
      t.rects.mockRestore();
    }
  });

  it('a row removed and re-added as the same object measures from its live element', () => {
    const t = basic();
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (!this.isConnected) return rowRect(0, 0);
        const rows = Array.from(this.parentElement?.children ?? []).filter(
          (c) => c.tagName === 'LI',
        );
        return rowRect(rows.indexOf(this));
      });
    try {
      const host = t.host as BasicHost;
      const b = host.data()[1];
      host.data.update((arr) => arr.filter((r) => r !== b));
      t.flush();
      host.data.update((arr) => [arr[0], b, arr[1]]);
      t.flush();
      const end = hover(t.lis()[0], [t.ul()], { x: 5, y: 50 });
      t.flush();
      expect(host.list.nativeInsert()).toBe(1);
      end();
    } finally {
      rects.mockRestore();
      t.rects.mockRestore();
    }
  });
});

@Directive({ selector: '[mmNativeTestItem]' })
class NativeTestItem {
  readonly item = input.required<Row>({ alias: 'mmNativeTestItem' });
  readonly state = connectReorderableItem<Row, number>(() => this.item());
}

@Component({
  selector: 'mm-native-custom-host',
  imports: [Reorderable, NativeTestItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmNativeTestItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class NativeCustomHost {
  readonly items = viewChildren(NativeTestItem);
  readonly list = reorderable(
    signal<Row[]>([
      { id: 1, label: 'A' },
      { id: 2, label: 'B' },
    ]),
    { key: (r) => r.id },
  );
}

describe('native engine: a custom item directive', () => {
  it('reads the row key and index; rows never move during a drag', () => {
    const { host } = render(NativeCustomHost);
    const states = host.items().map((d) => d.state);
    expect(states.map((s) => s.itemKey())).toEqual([1, 2]);
    expect(states.map((s) => s.index())).toEqual([0, 1]);
    expect(states.map((s) => s.transformCss())).toEqual(['', '']);
  });
});
