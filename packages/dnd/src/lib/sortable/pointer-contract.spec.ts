import {
  Component,
  Directive,
  input,
  signal,
  viewChildren,
  type Type,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideDnd } from '../provide';
import { parseTranslate } from './dom';
import {
  connectReorderableItem,
  Reorderable,
  ReorderableHandle,
  ReorderableItem,
  reorderable,
} from './reorderable';

type Row = { id: number; label: string };
const ROWS = (): Row[] => [
  { id: 1, label: 'A' },
  { id: 2, label: 'B' },
  { id: 3, label: 'C' },
];

function pe(type: string, x = 0, y = 0, pointerType = 'mouse', id = 1) {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId: id,
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

/** 40px rows by live position among the parent's item rows: centers 20 / 60 / 100 (x for an x list). */
function mockRows(axis: 'x' | 'y' = 'y') {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      const items = parent
        ? Array.from(parent.children).filter((c) =>
            c.hasAttribute('data-mm-reorderable-item'),
          )
        : [];
      const i = Math.max(0, items.indexOf(this));
      // rendered position: layout slot plus the inline translate the row carries
      const shift = parseTranslate(this.style.transform);
      const main = i * 40 + (axis === 'y' ? shift.y : shift.x);
      return {
        top: axis === 'y' ? main : 0,
        left: axis === 'x' ? main : 0,
        width: axis === 'x' ? 40 : 100,
        height: 40,
        right: axis === 'x' ? main + 40 : 100,
        bottom: axis === 'y' ? main + 40 : 40,
        x: axis === 'x' ? main : 0,
        y: axis === 'y' ? main : 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
}

function mount<C>(cmp: Type<C>, providers: unknown[] = []) {
  TestBed.configureTestingModule({ providers: providers as never[] });
  const fixture = TestBed.createComponent(cmp);
  fixture.detectChanges();
  TestBed.tick();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const lis = () =>
    Array.from(
      el.querySelectorAll('li[data-mm-reorderable-item]'),
    ) as HTMLElement[];
  return { fixture, host: fixture.componentInstance, el, lis };
}

function fakeAutoScroll() {
  const stop = vi.fn();
  const calls: Array<Record<string, unknown>> = [];
  const plugin = vi.fn((opts: Record<string, unknown>) => {
    calls.push(opts);
    return stop;
  });
  return { plugin, stop, calls };
}

const TEMPLATE = `
  <ul [mmReorderable]="list">
    @for (r of list.items(); track r.id) {
      <li [mmReorderableItem]="r">{{ r.label }}</li>
    }
  </ul>
`;

@Component({
  selector: 'mm-ptr-scroll',
  imports: [Reorderable, ReorderableItem],
  template: TEMPLATE,
})
class ScrollHost {
  readonly data = signal(ROWS());
  readonly onReorder = vi.fn();
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    autoScroll: {},
    onReorder: this.onReorder,
  });
}

@Component({
  selector: 'mm-ptr-scroll-x',
  imports: [Reorderable, ReorderableItem],
  template: TEMPLATE,
})
class ScrollXHost {
  readonly data = signal(ROWS());
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    axis: 'x',
    autoScroll: {},
  });
}

@Component({
  selector: 'mm-ptr-plain',
  imports: [Reorderable, ReorderableItem],
  template: TEMPLATE,
})
class PlainHost {
  readonly data = signal(ROWS());
  readonly onReorder = vi.fn();
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    onReorder: this.onReorder,
  });
}

const drag = (li: HTMLElement, from: number, to: number, type = 'mouse') => {
  li.dispatchEvent(pe('pointerdown', 5, from, type));
  li.dispatchEvent(pe('pointermove', 5, to, type));
  TestBed.tick();
};
const release = (li: HTMLElement, at: number) => {
  li.dispatchEvent(pe('pointerup', 5, at));
  TestBed.tick();
};

describe('pointer engine: the auto-scroll plugin seam', () => {
  it('starts once per drag with the list, its axis, the defaults and a live pointer; stops on release', () => {
    const fake = fakeAutoScroll();
    const rects = mockRows();
    try {
      const { host, el, lis } = mount(ScrollHost, [
        provideDnd({ plugins: { autoScroll: fake.plugin } }),
      ]);
      drag(lis()[0], 20, 70);
      expect(fake.plugin).toHaveBeenCalledTimes(1);
      const opts = fake.calls[0];
      expect(opts).toMatchObject({
        element: el.querySelector('ul'),
        axis: 'y',
        edge: 48,
        speed: 16,
      });
      expect((opts['pointer'] as () => unknown)()).toEqual({ x: 5, y: 70 });
      const a = host.list.itemState(() => host.data()[0]);
      expect(a.transformY()).toBe(50);
      (opts['onScroll'] as (d: number) => void)(30);
      expect(a.transformY()).toBe(80);
      release(lis()[0], 70);
      expect(fake.stop).toHaveBeenCalledTimes(1);
      drag(lis()[0], 20, 70);
      expect(fake.plugin).toHaveBeenCalledTimes(2);
    } finally {
      rects.mockRestore();
    }
  });

  it('passes axis x for an x list', () => {
    const fake = fakeAutoScroll();
    const rects = mockRows('x');
    try {
      const { lis } = mount(ScrollXHost, [
        provideDnd({ plugins: { autoScroll: fake.plugin } }),
      ]);
      const li = lis()[0];
      li.dispatchEvent(pe('pointerdown', 20, 5));
      li.dispatchEvent(pe('pointermove', 70, 5));
      TestBed.tick();
      expect(fake.calls[0]['axis']).toBe('x');
    } finally {
      rects.mockRestore();
    }
  });

  it('a list that did not opt in never calls the plugin, and still reorders', () => {
    const fake = fakeAutoScroll();
    const rects = mockRows();
    try {
      const { host, lis } = mount(PlainHost, [
        provideDnd({ plugins: { autoScroll: fake.plugin } }),
      ]);
      drag(lis()[0], 20, 70);
      release(lis()[0], 70);
      expect(fake.plugin).not.toHaveBeenCalled();
      expect(host.onReorder).toHaveBeenCalledTimes(1);
    } finally {
      rects.mockRestore();
    }
  });

  it('an opted-in list with no plugin registered still drags and commits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rects = mockRows();
    try {
      const { host, lis } = mount(ScrollHost);
      expect(() => drag(lis()[0], 20, 70)).not.toThrow();
      release(lis()[0], 70);
      expect(host.data().map((r) => r.label)).toEqual(['B', 'A', 'C']);
    } finally {
      rects.mockRestore();
      warn.mockRestore();
    }
  });

  it('a list destroyed mid-drag stops the scroll loop and tears the drag down', () => {
    const fake = fakeAutoScroll();
    const rects = mockRows();
    try {
      const { fixture, host, lis } = mount(ScrollHost, [
        provideDnd({ plugins: { autoScroll: fake.plugin } }),
      ]);
      drag(lis()[0], 20, 70);
      fixture.destroy();
      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(host.list.activeKey()).toBeNull();
    } finally {
      rects.mockRestore();
    }
  });
});

@Component({
  selector: 'mm-ptr-stray',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      <li class="stray" data-mm-reorderable-handle>stray</li>
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class StrayHost {
  readonly data = signal(ROWS());
  readonly onReorder = vi.fn();
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    autoScroll: {},
    onReorder: this.onReorder,
  });
}

@Component({
  selector: 'mm-ptr-handle',
  imports: [Reorderable, ReorderableItem, ReorderableHandle],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">
          @if (handles()) {
            <span mmReorderableHandle>::</span>
          }
          {{ r.label }}
        </li>
      }
    </ul>
  `,
})
class HandleHost {
  readonly handles = signal(true);
  readonly data = signal(ROWS());
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
  });
}

describe('pointer engine: gesture wiring', () => {
  it('a press on a handle-marked element that is no registered row starts nothing', () => {
    const fake = fakeAutoScroll();
    const rects = mockRows();
    try {
      const { host, el } = mount(StrayHost, [
        provideDnd({ plugins: { autoScroll: fake.plugin } }),
      ]);
      const stray = el.querySelector('li.stray') as HTMLElement;
      drag(stray, 20, 90);
      expect(host.list.activeKey()).toBeNull();
      expect(fake.plugin).not.toHaveBeenCalled();
      release(stray, 90);
      expect(host.onReorder).not.toHaveBeenCalled();
    } finally {
      rects.mockRestore();
    }
  });

  it('a touch press drags at once when touchActivation is off (the default)', () => {
    const rects = mockRows();
    try {
      const { host, lis } = mount(PlainHost);
      drag(lis()[0], 20, 70, 'touch');
      expect(host.list.activeKey()).toBe(1);
    } finally {
      rects.mockRestore();
    }
  });

  it('a row removed and re-added as the same object can be dragged again', () => {
    const rects = mockRows();
    try {
      const { fixture, host, lis } = mount(PlainHost);
      const b = host.data()[1];
      host.data.update((arr) => arr.filter((r) => r !== b));
      fixture.detectChanges();
      TestBed.tick();
      host.data.update((arr) => [arr[0], b, arr[1]]);
      fixture.detectChanges();
      TestBed.tick();
      fixture.detectChanges();
      drag(lis()[1], 60, 110);
      release(lis()[1], 110);
      expect(host.data().map((r) => r.label)).toEqual(['A', 'C', 'B']);
    } finally {
      rects.mockRestore();
    }
  });

  it('re-measures once a mid-drag removal has rendered, with no manual sync, so the drop commits', () => {
    const rects = mockRows();
    try {
      const { fixture, host, lis } = mount(PlainHost);
      drag(lis()[0], 20, 70);
      host.data.update((arr) => arr.filter((r) => r.label !== 'C'));
      fixture.detectChanges();
      TestBed.tick();
      expect(host.list.activeKey()).toBe(1);
      release(lis()[0], 70);
      expect(host.data().map((r) => r.label)).toEqual(['B', 'A']);
    } finally {
      rects.mockRestore();
    }
  });

  it('binds the documented host state: dragging class, transform, glide, reserved space', () => {
    const rects = mockRows();
    try {
      const { fixture, el, lis } = mount(PlainHost);
      const ul = el.querySelector('ul') as HTMLElement;
      expect(ul.style.getPropertyValue('--mm-sortable-reserved')).toBe('0px');
      drag(lis()[0], 20, 70);
      fixture.detectChanges();
      const [first, second] = lis();
      expect(first.classList.contains('mm-sortable-dragging')).toBe(true);
      expect(second.classList.contains('mm-sortable-dragging')).toBe(false);
      expect(second.style.transform).toBe('translateY(-40px)');
      expect(second.style.transition).toContain('transform');
      expect(first.hasAttribute('draggable')).toBe(false);
    } finally {
      rects.mockRestore();
    }
  });

  it('removing the handle makes the whole row the drag surface again', () => {
    const { fixture, host, lis } = mount(HandleHost);
    expect(lis()[0].hasAttribute('data-mm-reorderable-handle')).toBe(false);
    host.handles.set(false);
    fixture.detectChanges();
    expect(lis()[0].hasAttribute('data-mm-reorderable-handle')).toBe(true);
    expect(lis()[0].style.touchAction).toBe('pan-x');
  });
});

@Directive({ selector: '[mmTestItem]', exportAs: 'mmTestItem' })
class TestItem {
  readonly item = input.required<Row>({ alias: 'mmTestItem' });
  readonly state = connectReorderableItem<Row, number>(() => this.item());
}

@Component({
  selector: 'mm-ptr-custom',
  imports: [Reorderable, TestItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li
          data-mm-reorderable-item
          data-mm-reorderable-handle
          [mmTestItem]="r"
          [attr.data-index]="it.state.index()"
          #it="mmTestItem"
          [style.transform]="it.state.transformCss()"
        >
          {{ r.label }} {{ it.state.transformY() }}
        </li>
      }
    </ul>
  `,
})
class CustomItemHost {
  readonly items = viewChildren(TestItem);
  readonly data = signal(ROWS());
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
  });
}

describe('connectReorderableItem: a custom item directive', () => {
  it('reads safe defaults before wiring, then the live per-row state', () => {
    const rects = mockRows();
    try {
      const fixture = TestBed.createComponent(CustomItemHost);
      expect(() => fixture.detectChanges()).not.toThrow();
      TestBed.tick();
      fixture.detectChanges();
      const host = fixture.componentInstance;
      const states = host.items().map((d) => d.state);
      expect(states.map((s) => s.index())).toEqual([0, 1, 2]);
      expect(states.map((s) => s.itemKey())).toEqual([1, 2, 3]);
      const lis = Array.from(
        fixture.nativeElement.querySelectorAll('li'),
      ) as HTMLElement[];
      drag(lis[0], 20, 70);
      expect(states[0].isSource()).toBe(true);
      expect(states[1].isSource()).toBe(false);
      expect(states[1].transform()).toBe(-40);
      expect(states[1].transformY()).toBe(-40);
      expect(states[1].transformX()).toBe(0);
      expect(states[1].transformCss()).toBe('translateY(-40px)');
      expect(states[1].transitionCss()).toContain('transform');
      expect(states[0].transitionCss()).toBe('none');
    } finally {
      rects.mockRestore();
    }
  });
});
