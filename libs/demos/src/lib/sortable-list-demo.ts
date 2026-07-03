import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableHandle,
  ReorderableItem,
  reorderable,
} from '@mmstack/dnd';

type Task = { id: number; label: string };

@Component({
  selector: 'demo-sortable-list',
  imports: [Reorderable, ReorderableItem, ReorderableHandle],
  template: `
    <ul class="list" [mmReorderable]="list">
      @for (task of list.items(); track task.id) {
        <li class="item" [mmReorderableItem]="task">
          <span class="grip" mmReorderableHandle aria-hidden="true">⠿</span>
          {{ task.label }}
        </li>
      }
    </ul>
  `,
  styles: `
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 24rem;
    }

    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .grip {
      color: var(--fg-muted, #9ca3af);
      cursor: grab;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      margin: -8px 0 -8px -4px;
      min-width: 24px;
      min-height: 24px;
      touch-action: none;
    }

    .item.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: var(--accent, #c7d2fe);
      opacity: 0.95;
    }
  `,
})
export class SortableListDemo {
  private readonly data = signal<Task[]>([
    { id: 1, label: 'Auth flow' },
    { id: 2, label: 'Billing page' },
    { id: 3, label: 'Search filters' },
    { id: 4, label: 'Dashboard charts' },
    { id: 5, label: 'Settings panel' },
  ]);

  protected readonly list = reorderable(this.data, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'y',
  });
}
