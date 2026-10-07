import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';
import { DemoReset } from './demo-reset';

type Card = { id: number; label: string };

const todoSeed = (): Card[] => [
  { id: 1, label: 'Spec API' },
  { id: 2, label: 'Write docs' },
  { id: 3, label: 'Add tests' },
];

const doingSeed = (): Card[] => [
  { id: 4, label: 'Build engine' },
  { id: 5, label: 'Review PR' },
];

@Component({
  selector: 'demo-sortable-board',
  imports: [Reorderable, ReorderableItem, DemoReset],
  template: `
    <demo-reset (restore)="reset()" />
    <p class="touch-hint">Hold a card to drag it.</p>
    <div class="board">
      <div class="col-wrap">
        <p class="col-title">Todo</p>
        <ul class="list col" [mmReorderable]="todoList">
          @for (card of todoList.items(); track card.id) {
            <li class="item" [mmReorderableItem]="card">{{ card.label }}</li>
          }
        </ul>
      </div>
      <div class="col-wrap">
        <p class="col-title">Doing</p>
        <ul class="list col" [mmReorderable]="doingList">
          @for (card of doingList.items(); track card.id) {
            <li class="item" [mmReorderableItem]="card">{{ card.label }}</li>
          }
        </ul>
      </div>
    </div>
  `,
  styles: `
    .board {
      display: flex;
      gap: 16px;
      align-items: start;
      max-width: 30rem;
    }

    .col-wrap {
      flex: 1;
    }

    .col-title {
      margin: 0 0 0.5rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--fg-muted, #6b7280);
    }

    .list {
      list-style: none;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .col {
      min-height: 80px;
      padding: 8px;
      background: var(--bg-soft, #f9fafb);
      border-radius: 10px;
      padding-bottom: calc(8px + var(--mm-sortable-reserved, 0px));
    }

    .item {
      padding: 10px 12px;
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      cursor: grab;
    }

    .touch-hint {
      display: none;
      margin: 0 0 0.5rem;
      color: var(--fg-muted, #6b7280);
      font-size: 0.8rem;
    }

    @media (pointer: coarse) {
      .touch-hint {
        display: block;
      }
    }

    .item.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: var(--accent, #c7d2fe);
      opacity: 0.95;
    }
  `,
})
export class SortableBoardDemo {
  private readonly group = sortableGroup<Card>();

  private readonly todo = signal<Card[]>(todoSeed());
  private readonly doing = signal<Card[]>(doingSeed());

  protected readonly todoList = reorderable(this.todo, {
    engine: 'pointer',
    key: (c) => c.id,
    group: this.group,
    // touch: hold to drag, so a swipe over the cards still scrolls the page
    touchActivation: { delay: 250 },
  });

  protected readonly doingList = reorderable(this.doing, {
    engine: 'pointer',
    key: (c) => c.id,
    group: this.group,
    // touch: hold to drag, so a swipe over the cards still scrolls the page
    touchActivation: { delay: 250 },
  });

  protected reset() {
    this.todo.set(todoSeed());
    this.doing.set(doingSeed());
  }
}
