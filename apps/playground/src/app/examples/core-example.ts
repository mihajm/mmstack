import { Component, signal } from '@angular/core';
import { Draggable, DropTarget, monitor } from '@mmstack/dnd';

type Item = { id: number; label: string };

const isItem = (d: unknown): d is Item =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

type Column = 'todo' | 'doing' | 'done';

/**
 * Core-only example: `draggable` + `dropTarget` + `monitor`. No plugins, no
 * edges — just moving typed payloads between zones.
 */
@Component({
  selector: 'mm-core-example',
  imports: [Draggable, DropTarget],
  template: `
    <h2>Core — drag between zones</h2>
    <p class="hint">
      Built with just <code>draggable</code>, <code>dropTarget</code> and
      <code>monitor</code> — no plugins.
    </p>

    <div class="status" [class.active]="mon.isDragging()">
      @if (mon.isDragging()) {
        Dragging: <strong>{{ mon.source()?.data?.label }}</strong>
      } @else {
        Drag a card into another column
      }
    </div>

    <div class="board">
      @for (col of columns; track col) {
        <section
          class="col"
          mmDropTarget
          #zone="mmDropTarget"
          [accepts]="isItem"
          [class.over]="zone.isDragOver()"
          (dropped)="move(col, $event.data)"
        >
          <header>{{ col }}</header>
          @for (item of items()[col]; track item.id) {
            <div
              class="card"
              mmDraggable
              #d="mmDraggable"
              [data]="item"
              [class.dragging]="d.dragging()"
            >
              {{ item.label }}
            </div>
          } @empty {
            <div class="empty">drop here</div>
          }
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: block; padding: 1.5rem; font-family: system-ui, sans-serif; }
    h2 { margin: 0 0 .25rem; }
    .hint { color: #64748b; margin: 0 0 1rem; }
    code { background: #f1f5f9; padding: 0 .25rem; border-radius: 3px; }
    .status {
      padding: .5rem .75rem; border-radius: 6px; margin-bottom: 1rem;
      background: #f8fafc; color: #64748b; border: 1px dashed #cbd5e1;
    }
    .status.active { background: #eff6ff; color: #1d4ed8; border-color: #93c5fd; }
    .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; user-select: none; }
    .col {
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
      padding: .75rem; min-height: 220px; transition: background .15s, box-shadow .15s;
    }
    .col.over { background: #eff6ff; box-shadow: inset 0 0 0 2px #60a5fa; }
    .col header { text-transform: capitalize; font-weight: 600; color: #334155; margin-bottom: .5rem; }
    .card {
      background: white; border: 1px solid #e2e8f0; border-radius: 6px;
      padding: .5rem .75rem; margin-bottom: .5rem; cursor: grab;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .card.dragging { opacity: .4; }
    .empty { color: #94a3b8; font-size: .85rem; text-align: center; padding: 1rem 0; }
  `,
})
export class CoreExample {
  protected readonly isItem = isItem;
  protected readonly columns: Column[] = ['todo', 'doing', 'done'];

  protected readonly items = signal<Record<Column, Item[]>>({
    todo: [
      { id: 1, label: 'Design landing page' },
      { id: 2, label: 'Write copy' },
      { id: 3, label: 'Set up analytics' },
    ],
    doing: [{ id: 4, label: 'Build component library' }],
    done: [{ id: 5, label: 'Kickoff meeting' }],
  });

  protected readonly mon = monitor<Item>({ accepts: isItem });

  protected move(to: Column, item: Item): void {
    this.items.update((board) => {
      const next: Record<Column, Item[]> = {
        todo: board.todo.filter((i) => i.id !== item.id),
        doing: board.doing.filter((i) => i.id !== item.id),
        done: board.done.filter((i) => i.id !== item.id),
      };
      next[to] = [...next[to], item];
      return next;
    });
  }
}
