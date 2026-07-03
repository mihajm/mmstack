import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';

type Card = { id: number; label: string };

@Component({
  selector: 'demo-sortable-board',
  imports: [Reorderable, ReorderableItem],
  template: `
    <div class="board">
      <div class="col-wrap">
        <h4>Todo</h4>
        <ul class="list col" [mmReorderable]="todoList">
          @for (card of todoList.items(); track card.id) {
            <li class="item" [mmReorderableItem]="card">{{ card.label }}</li>
          }
        </ul>
      </div>
      <div class="col-wrap">
        <h4>Doing</h4>
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

    h4 {
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

  private readonly todo = signal<Card[]>([
    { id: 1, label: 'Spec API' },
    { id: 2, label: 'Write docs' },
    { id: 3, label: 'Add tests' },
  ]);

  private readonly doing = signal<Card[]>([
    { id: 4, label: 'Build engine' },
    { id: 5, label: 'Review PR' },
  ]);

  protected readonly todoList = reorderable(this.todo, {
    engine: 'pointer',
    key: (c) => c.id,
    group: this.group,
  });

  protected readonly doingList = reorderable(this.doing, {
    engine: 'pointer',
    key: (c) => c.id,
    group: this.group,
  });
}
