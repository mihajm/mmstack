import { Component, signal } from '@angular/core';
import { Draggable, DropTarget } from '@mmstack/dnd';

type Column = 'todo' | 'done';
type Card = { id: number; title: string };

const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

@Component({
  selector: 'demo-drag-drop',
  imports: [Draggable, DropTarget],
  template: `
    @for (col of columns; track col) {
      <section
        mmDropTarget
        #zone="mmDropTarget"
        [accepts]="isCard"
        [class.over]="zone.isDragOver()"
        (dropped)="move(col, $event.data)"
      >
        <h3>{{ col }}</h3>
        @for (card of board()[col]; track card.id) {
          <article
            mmDraggable
            #d="mmDraggable"
            [data]="card"
            [class.dragging]="d.dragging()"
          >
            {{ card.title }}
          </article>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      gap: 1rem;
      max-width: 30rem;
    }

    section {
      flex: 1;
      min-height: 120px;
      padding: 0.75rem;
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 8px;
    }

    section.over {
      border-color: var(--accent, #2563eb);
      background: var(--bg-soft, #eff6ff);
    }

    h3 {
      margin: 0 0 0.5rem;
      text-transform: capitalize;
      font-size: 0.9rem;
    }

    article {
      margin-bottom: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e2e8f0);
      border-radius: 6px;
      cursor: grab;
      user-select: none;
    }

    article.dragging {
      opacity: 0.4;
    }
  `,
})
export class DragDropDemo {
  protected readonly isCard = isCard;
  protected readonly columns: Column[] = ['todo', 'done'];

  protected readonly board = signal<Record<Column, Card[]>>({
    todo: [
      { id: 1, title: 'Design' },
      { id: 2, title: 'Build' },
    ],
    done: [{ id: 3, title: 'Kickoff' }],
  });

  protected move(to: Column, card: Card): void {
    this.board.update((b) => {
      const next: Record<Column, Card[]> = {
        todo: b.todo.filter((c) => c.id !== card.id),
        done: b.done.filter((c) => c.id !== card.id),
      };
      next[to] = [...next[to], card];
      return next;
    });
  }
}
