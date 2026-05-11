import { Component, signal } from '@angular/core';
import { DragHandle, Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Card = { id: number; label: string };

const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

@Component({
  selector: 'mm-kanban',
  imports: [DragHandle, Reorderable, ReorderableItem],
  template: `
    <h3>Two reorderable lists in the same <code>group</code> — drag between them</h3>
    <div class="board">
      <section>
        <h4>To do ({{ todoList.items().length }})</h4>
        <ul [mmReorderable]="todoList">
          @for (card of todoList.items(); track todoList.key(card)) {
            <li [mmReorderableItem]="card">
              <span mmDragHandle class="grip">⋮⋮</span>
              <span>{{ card.label }}</span>
            </li>
          } @empty {
            <li class="empty">drop a card here</li>
          }
        </ul>
      </section>
      <section>
        <h4>Done ({{ doneList.items().length }})</h4>
        <ul [mmReorderable]="doneList">
          @for (card of doneList.items(); track doneList.key(card)) {
            <li [mmReorderableItem]="card">
              <span mmDragHandle class="grip">⋮⋮</span>
              <span>{{ card.label }}</span>
            </li>
          } @empty {
            <li class="empty">drop a card here</li>
          }
        </ul>
      </section>
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: 2rem;
      font-family: system-ui, sans-serif;
    }
    h3 { margin-top: 0; }
    h4 { margin: 0 0 0.5rem; }
    .board {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      max-width: 800px;
    }
    ul {
      list-style: none;
      padding: 0.5rem;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-height: 200px;
      background: #f1f5f9;
      border: 1px dashed #cbd5e1;
      border-radius: 6px;
    }
    li {
      position: relative;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      user-select: none;
    }
    li.empty {
      color: #94a3b8;
      font-style: italic;
      background: transparent;
      border-style: dashed;
      justify-content: center;
    }
    .grip { color: #94a3b8; cursor: grab; }
  `,
})
export class Kanban {
  protected readonly todos = signal<Card[]>([
    { id: 1, label: 'Plan the sprint' },
    { id: 2, label: 'Review the PR' },
    { id: 3, label: 'Write the docs' },
  ]);

  protected readonly done = signal<Card[]>([
    { id: 4, label: 'Wake up' },
    { id: 5, label: 'Drink coffee' },
  ]);

  protected readonly todoList = reorderable(this.todos, {
    accepts: isCard,
    key: (c) => c.id,
    group: 'kanban',
  });

  protected readonly doneList = reorderable(this.done, {
    accepts: isCard,
    key: (c) => c.id,
    group: 'kanban',
  });
}
