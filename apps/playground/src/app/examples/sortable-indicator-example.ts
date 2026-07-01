import { Component, signal } from '@angular/core';
import {
  Draggable,
  Reorderable,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';

type Row = { id: number; label: string };
type Chip = { kind: string };

/**
 * Demos of the NEW native ("indicator") sortable engine — the lib's
 * `reorderable` with `engine: 'native'` (the default). Mirrors the app's
 * `/sortable` sections so the two can be compared before the old one retires.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-sortable-indicator-example',
  imports: [Reorderable, ReorderableItem, Draggable],
  template: `
    <main>
      <h1>Sortable — native engine (indicator)</h1>
      <p class="hint">
        HTML5 drag-and-drop; items stay put and a drop-line shows the insert.
        Same primitives as the pointer engine — this is
        <code>engine: 'native'</code>
        (the default). Reorders FLIP-animate to their new spot on commit.
      </p>

      <h2>Reorder</h2>
      <ul class="list" data-list="ind" [mmReorderable]="list">
        @for (r of list.items(); track r.id) {
          <li class="item" [mmReorderableItem]="r">{{ r.label }}</li>
        }
      </ul>

      <h2>Cross-list (shared group)</h2>
      <p class="hint">Drag rows between the columns — one shared group.</p>
      <div class="board">
        <ul class="list col" data-list="ind-todo" [mmReorderable]="todoList">
          @for (r of todoList.items(); track r.id) {
            <li class="item" [mmReorderableItem]="r">{{ r.label }}</li>
          }
        </ul>
        <ul class="list col" data-list="ind-doing" [mmReorderable]="doingList">
          @for (r of doingList.items(); track r.id) {
            <li class="item" [mmReorderableItem]="r">{{ r.label }}</li>
          }
        </ul>
      </div>

      <h2>Palette → insert</h2>
      <p class="hint">
        Drag a chip into the list — a foreign payload mapped to a new item.
      </p>
      <div class="palette">
        @for (chip of chips; track chip.kind) {
          <span class="chip" mmDraggable [data]="chip">{{ chip.kind }}</span>
        }
      </div>
      <ul class="list" data-list="ind-insert" [mmReorderable]="insertList">
        @for (r of insertList.items(); track r.id) {
          <li class="item" [mmReorderableItem]="r">{{ r.label }}</li>
        }
      </ul>

      <h2>Keyboard</h2>
      <p class="hint">
        Every list above is keyboard-reorderable: focus a row, then ↑/↓ (or ←/→
        on an x-axis list); Cmd/Ctrl + arrow jumps to an end.
      </p>
    </main>
  `,
  styles: `
    main {
      max-width: 30rem;
      margin: 2rem auto;
      font:
        14px/1.4 system-ui,
        sans-serif;
    }
    .hint {
      color: #6b7280;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item {
      padding: 12px 14px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      cursor: grab;
      position: relative;
    }
    .board {
      display: flex;
      gap: 16px;
      align-items: start;
    }
    .col {
      flex: 1;
      min-height: 100px;
      padding: 8px;
      background: #f9fafb;
      border-radius: 10px;
    }
    .palette {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .chip {
      padding: 8px 14px;
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      border-radius: 999px;
      cursor: grab;
    }
  `,
})
export class SortableIndicatorExample {
  // reorder
  protected readonly data = signal<Row[]>([
    { id: 1, label: 'One' },
    { id: 2, label: 'Two' },
    { id: 3, label: 'Three' },
    { id: 4, label: 'Four' },
  ]);
  protected readonly list = reorderable(this.data, { key: (r) => r.id });

  // cross-list
  private readonly board = sortableGroup<Row>();
  protected readonly todo = signal<Row[]>([
    { id: 10, label: 'Spec' },
    { id: 11, label: 'Build' },
  ]);
  protected readonly doing = signal<Row[]>([{ id: 12, label: 'Review' }]);
  protected readonly todoList = reorderable(this.todo, {
    key: (r) => r.id,
    group: this.board,
  });
  protected readonly doingList = reorderable(this.doing, {
    key: (r) => r.id,
    group: this.board,
  });

  // palette → insert
  private nextId = 100;
  protected readonly chips: Chip[] = [{ kind: 'note' }, { kind: 'task' }];
  protected readonly insertData = signal<Row[]>([
    { id: 20, label: 'Existing A' },
    { id: 21, label: 'Existing B' },
  ]);
  protected readonly insertList = reorderable(this.insertData, {
    key: (r) => r.id,
    insert: {
      accepts: (d): d is Chip =>
        !!d && typeof d === 'object' && 'kind' in (d as object),
      create: (d) => ({ id: this.nextId++, label: `New ${(d as Chip).kind}` }),
    },
  });
}
