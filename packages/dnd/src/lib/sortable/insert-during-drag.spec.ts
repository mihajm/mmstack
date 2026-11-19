import { Component, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { parseTranslate } from './dom';
import { sortableGroup } from './group';
import { Reorderable, ReorderableItem, reorderable } from './reorderable';

type Row = { id: number; label: string };
const rows = (...labels: string[]): Row[] =>
  labels.map((label) => ({ id: label.charCodeAt(0), label }));
const labels = (arr: readonly Row[]) => arr.map((r) => r.label);

function pe(type: string, x: number, y: number) {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId: 1,
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
 * 40px rows at their rendered position (layout slot plus inline translate);
 * a list marked `data-side="right"` sits at x 200..300. Containers span 0..400.
 */
function mockLayout() {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const list = this.closest('ul');
      const left = list?.getAttribute('data-side') === 'right' ? 200 : 0;
      const rect = (top: number, height: number) =>
        ({
          top,
          left,
          width: 100,
          height,
          right: left + 100,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      if (this.tagName === 'UL') return rect(0, 400);
      const items = Array.from(this.parentElement?.children ?? []).filter((c) =>
        c.hasAttribute('data-mm-reorderable-item'),
      );
      const i = Math.max(0, items.indexOf(this));
      return rect(i * 40 + parseTranslate(this.style.transform).y, 40);
    });
}

@Component({
  selector: 'mm-insert-single',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class SingleHost {
  readonly data = signal(rows('A', 'B', 'C'));
  readonly onReorder = vi.fn();
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
    onReorder: this.onReorder,
  });
}

@Component({
  selector: 'mm-insert-pair',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul data-side="left" [mmReorderable]="left">
      @for (r of left.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
    <ul data-side="right" [mmReorderable]="right">
      @for (r of right.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class PairHost {
  readonly group = sortableGroup<Row>();
  readonly a = signal(rows('A', 'B', 'C'));
  readonly b = signal(rows('K', 'L'));
  readonly left = reorderable(this.a, {
    key: (r) => r.id,
    engine: 'pointer',
    group: this.group,
  });
  readonly right = reorderable(this.b, {
    key: (r) => r.id,
    engine: 'pointer',
    group: this.group,
  });
}

function mount<C>(cmp: Type<C>) {
  const fixture = TestBed.createComponent(cmp);
  const render = () => {
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
  };
  render();
  const el = fixture.nativeElement as HTMLElement;
  const row = (text: string) =>
    Array.from(el.querySelectorAll('li')).find(
      (li) => (li.textContent ?? '').trim() === text,
    ) as HTMLElement;
  return { host: fixture.componentInstance, render, row };
}

/** Press on `li` at (x, y0), then move through `ys` one frame each. */
const press = (li: HTMLElement, x: number, y: number) => {
  li.dispatchEvent(pe('pointerdown', x, y));
};
const moveTo = (li: HTMLElement, x: number, y: number) => {
  li.dispatchEvent(pe('pointermove', x, y));
  TestBed.tick();
};
const release = (li: HTMLElement, x: number, y: number) => {
  li.dispatchEvent(pe('pointerup', x, y));
  TestBed.tick();
};

describe('pointer engine: another writer inserts a row mid-drag', () => {
  let rects: ReturnType<typeof mockLayout>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rects = mockLayout();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    rects.mockRestore();
    warn.mockRestore();
  });

  it('before the dragged row: the drag goes on and the drop lands at the hovered slot', () => {
    const { host, render, row } = mount(SingleHost);
    const b = row('B');
    press(b, 5, 60);
    moveTo(b, 5, 110);
    host.data.update((arr) => [{ id: 88, label: 'X' }, ...arr]);
    render();
    expect(host.list.activeKey()).toBe(66);
    // B now rests at 80..120; the follow was rebased, so it still sits under the pointer
    expect(host.list.itemState(() => host.data()[2]).transform()).toBe(10);
    moveTo(b, 5, 150);
    release(b, 5, 150);
    expect(labels(host.data())).toEqual(['X', 'A', 'C', 'B']);
    expect(host.onReorder).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('after the dragged row: the drag goes on and the drop lands at the hovered slot', () => {
    const { host, render, row } = mount(SingleHost);
    const a = row('A');
    press(a, 5, 20);
    moveTo(a, 5, 70);
    host.data.update((arr) => [
      arr[0],
      { id: 88, label: 'X' },
      ...arr.slice(1),
    ]);
    render();
    expect(host.list.activeKey()).toBe(65);
    moveTo(a, 5, 110);
    release(a, 5, 110);
    expect(labels(host.data())).toEqual(['X', 'B', 'A', 'C']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('into the source list while hovering a sibling: the transfer still lands', () => {
    const { host, render, row } = mount(PairHost);
    const b = row('B');
    press(b, 5, 60);
    moveTo(b, 250, 50);
    host.a.update((arr) => [{ id: 88, label: 'X' }, ...arr]);
    render();
    expect(host.left.activeKey()).toBe(66);
    moveTo(b, 250, 55);
    release(b, 250, 55);
    expect(labels(host.a())).toEqual(['X', 'A', 'C']);
    expect(labels(host.b())).toEqual(['K', 'B', 'L']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('into the hovered sibling: the drop lands next to the hovered neighbour', () => {
    const { host, render, row } = mount(PairHost);
    const b = row('B');
    press(b, 5, 60);
    moveTo(b, 250, 50);
    host.b.update((arr) => [{ id: 90, label: 'Z' }, ...arr]);
    render();
    expect(host.left.activeKey()).toBe(66);
    release(b, 250, 50);
    expect(labels(host.b())).toEqual(['Z', 'K', 'B', 'L']);
    expect(labels(host.a())).toEqual(['A', 'C']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the dragged row itself removed: still cancels, loudly', () => {
    const { host, render, row } = mount(SingleHost);
    const b = row('B');
    press(b, 5, 60);
    moveTo(b, 5, 110);
    host.data.update((arr) => arr.filter((r) => r.label !== 'B'));
    render();
    expect(host.list.activeKey()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('removed');
    expect(host.onReorder).not.toHaveBeenCalled();
  });

  it('a drop before the insert has rendered still cancels, loudly', () => {
    const { host, row } = mount(SingleHost);
    const b = row('B');
    press(b, 5, 60);
    moveTo(b, 5, 110);
    host.data.update((arr) => [{ id: 88, label: 'X' }, ...arr]);
    release(b, 5, 110);
    expect(labels(host.data())).toEqual(['X', 'A', 'B', 'C']);
    expect(host.onReorder).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
