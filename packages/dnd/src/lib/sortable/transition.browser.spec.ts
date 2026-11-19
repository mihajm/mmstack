import { Component, signal } from '@angular/core';

import {
  center,
  drag,
  frame,
  mount,
  resetPointer,
  texts,
} from '../testing/browser';
import { Reorderable, ReorderableItem, reorderable } from './reorderable';

type Row = { id: number; label: string };

@Component({
  selector: 'mm-transition-rows',
  imports: [Reorderable, ReorderableItem],
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      width: 200px;
    }
    li {
      height: 40px;
      box-sizing: border-box;
      transition: all 400ms linear;
    }
  `,
  template: `
    <ul [mmReorderable]="list">
      @for (r of list.items(); track r.id) {
        <li [mmReorderableItem]="r">{{ r.label }}</li>
      }
    </ul>
  `,
})
class TransitionRows {
  readonly data = signal<Row[]>([
    { id: 1, label: 'A' },
    { id: 2, label: 'B' },
    { id: 3, label: 'C' },
  ]);
  readonly list = reorderable(this.data, {
    key: (r) => r.id,
    engine: 'pointer',
  });
}

const rowTransitions = (root: Element) =>
  document
    .getAnimations()
    .filter(
      (a) =>
        a instanceof CSSTransition &&
        a.playState === 'running' &&
        root.contains((a.effect as KeyframeEffect).target as Node),
    );

afterEach(resetPointer);

describe('reorderable rows that carry a consumer transition', () => {
  it('land in their slots with no animation after a drop', async () => {
    const fixture = await mount(TransitionRows);
    const ul = fixture.nativeElement.querySelector('ul') as HTMLElement;
    const [a, b] = Array.from(ul.querySelectorAll('li'));
    const below = center(b);

    await drag(a, { x: below.x, y: below.y + 12 });
    await frame();

    expect(texts(ul, 'li')).toEqual(['B', 'A', 'C']);
    expect(rowTransitions(ul)).toEqual([]);
    const top = ul.getBoundingClientRect().top;
    const tops = Array.from(
      ul.querySelectorAll('li'),
      (li) => li.getBoundingClientRect().top - top,
    );
    expect(tops).toEqual([0, 40, 80]);
  });
});
