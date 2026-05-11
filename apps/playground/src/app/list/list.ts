import { Component, signal } from '@angular/core';
import { DragHandle, Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Item = { id: number; label: string };

const isItem = (d: unknown): d is Item =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

@Component({
  selector: 'mm-list',
  imports: [DragHandle, Reorderable, ReorderableItem],
  template: `
    <h3>Sortable list — grab the grip to reorder</h3>
    <ul [mmReorderable]="todos">
      @for (item of todos.items(); track todos.key(item)) {
        <li [mmReorderableItem]="item">
          <span class="grip" mmDragHandle>⋮⋮</span>
          <span class="label">{{ item.label }}</span>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
      padding: 2rem;
      font-family: system-ui, sans-serif;
    }
    h3 { margin-top: 0; }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: 360px;
    }
    li {
      position: relative;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      user-select: none;
    }
    .grip { color: #94a3b8; cursor: grab; }
  `,
})
export class List {
  protected readonly items = signal<Item[]>([
    { id: 1, label: 'Buy groceries' },
    { id: 2, label: 'Walk the dog' },
    { id: 3, label: 'Write the PR' },
    { id: 4, label: 'Ship the feature' },
    { id: 5, label: 'Celebrate' },
  ]);

  protected readonly todos = reorderable(this.items, {
    accepts: isItem,
    key: (t) => t.id,
  });
}
