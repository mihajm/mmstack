import { Component, signal } from '@angular/core';

import {
  center,
  drag,
  frames,
  labels,
  mount,
  moveTo,
  resetPointer,
  until,
  up,
} from '../testing/browser';
import { sortableGroup } from './group';
import { Reorderable, ReorderableItem, reorderable } from './reorderable';

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

const STYLES = `
  .board { display: flex; gap: 40px; padding: 40px; }
  ul { list-style: none; margin: 0; padding: 0; width: 200px; min-height: 200px; }
  li { box-sizing: border-box; height: 40px; border: 1px solid #ccc; background: #fff; }
`;

@Component({
  selector: 'mm-insert-during-drag',
  imports: [Reorderable, ReorderableItem],
  styles: STYLES,
  template: `
    <div class="board">
      <ul data-list="left" [mmReorderable]="left">
        @for (r of left.items(); track r.id) {
          <li [mmReorderableItem]="r">{{ r.id }}</li>
        }
      </ul>
      <ul data-list="right" [mmReorderable]="right">
        @for (r of right.items(); track r.id) {
          <li [mmReorderableItem]="r">{{ r.id }}</li>
        }
      </ul>
    </div>
  `,
})
class InsertDuringDrag {
  readonly group = sortableGroup<Row>();
  readonly a = signal(rows('A', 'B', 'C', 'D'));
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

let root: HTMLElement;
let host: InsertDuringDrag;
let warn: ReturnType<typeof vi.spyOn>;
const row = (list: string, id: string) =>
  Array.from(
    root.querySelectorAll<HTMLElement>(`ul[data-list="${list}"] li`),
  ).find((li) => (li.textContent ?? '').trim() === id) as HTMLElement;
const order = (list: string) => labels(root, `ul[data-list="${list}"] li`);
const below = (list: string) => {
  const items = root.querySelectorAll(`ul[data-list="${list}"] li`);
  const r = items[items.length - 1].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom + 15 };
};

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn');
  const fixture = await mount(InsertDuringDrag);
  root = fixture.nativeElement as HTMLElement;
  host = fixture.componentInstance;
});
afterEach(async () => {
  warn.mockRestore();
  await resetPointer();
});

/** A second writer inserts mid-drag; the drag keeps going after the insert has rendered. */
async function insertMidDrag(write: () => void) {
  write();
  await frames(3);
}

describe('pointer engine, real browser: a row inserted mid-drag', () => {
  it('before the dragged row: no cancel, the dragged row lands where it is dropped', async () => {
    await drag(row('left', 'B'), center(row('left', 'C')), {
      steps: 12,
      release: false,
    });
    await insertMidDrag(() => host.a.update((arr) => [{ id: 'X' }, ...arr]));
    expect(host.left.activeKey()).toBe('B');
    await moveTo(below('left'), 12);
    await up();
    await until(() => expect(order('left')).toEqual(['X', 'A', 'C', 'D', 'B']));
    expect(warn).not.toHaveBeenCalled();
  });

  it('after the dragged row: no cancel, the dragged row lands where it is dropped', async () => {
    await drag(row('left', 'A'), center(row('left', 'B')), {
      steps: 12,
      release: false,
    });
    await insertMidDrag(() =>
      host.a.update((arr) => [arr[0], { id: 'X' }, ...arr.slice(1)]),
    );
    expect(host.left.activeKey()).toBe('A');
    await moveTo(below('left'), 12);
    await up();
    await until(() => expect(order('left')).toEqual(['X', 'B', 'C', 'D', 'A']));
    expect(warn).not.toHaveBeenCalled();
  });

  it('into the source list while hovering a sibling: the transfer lands at the hovered slot', async () => {
    const k = row('right', 'K').getBoundingClientRect();
    const between = { x: k.left + k.width / 2, y: k.bottom - 4 };
    await drag(row('left', 'B'), between, { steps: 12, release: false });
    await insertMidDrag(() => host.a.update((arr) => [{ id: 'X' }, ...arr]));
    expect(host.left.activeKey()).toBe('B');
    await moveTo({ x: between.x, y: between.y + 1 }, 2);
    await up();
    await until(() => expect(order('right')).toEqual(['K', 'B', 'L']));
    expect(order('left')).toEqual(['X', 'A', 'C', 'D']);
    expect(warn).not.toHaveBeenCalled();
  });
});
