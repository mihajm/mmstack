import { Component, signal, type WritableSignal } from '@angular/core';
import {
  Reorderable,
  ReorderableHandle,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';

type Step = { id: number; label: string };

@Component({
  selector: 'demo-sortable-nested',
  imports: [Reorderable, ReorderableItem, ReorderableHandle],
  template: `
    <ul class="list" [mmReorderable]="outer">
      @for (card of outer.items(); track card.id) {
        <li class="card" [mmReorderableItem]="card">
          <strong class="card-header" mmReorderableHandle>
            <span class="grip" aria-hidden="true">⠿</span>{{ card.title }}
          </strong>
          <ul class="list nested" [mmReorderable]="card.list">
            @for (step of card.list.items(); track step.id) {
              <li class="item" [mmReorderableItem]="step">{{ step.label }}</li>
            }
          </ul>
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

    .card {
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 8px;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 6px;
      border-radius: 6px;
      background: var(--bg-soft, #f3f4f6);
      font-weight: 600;
      cursor: grab;
    }

    .grip {
      color: var(--fg-muted, #9ca3af);
    }

    .nested {
      margin-left: 14px;
      padding: 4px;
      min-height: 44px;
      border-left: 2px solid var(--border, #eceef1);
      padding-bottom: calc(4px + var(--mm-sortable-reserved, 0px));
    }

    .item {
      padding: 8px 10px;
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      cursor: grab;
    }

    .item.mm-sortable-dragging,
    .card.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: var(--accent, #c7d2fe);
      opacity: 0.95;
    }
  `,
})
export class SortableNestedDemo {
  private readonly checkGroup = sortableGroup<Step>();

  private card(id: number, title: string, items: Step[]) {
    const sig: WritableSignal<Step[]> = signal(items);
    return {
      id,
      title,
      list: reorderable(sig, {
        engine: 'pointer',
        key: (s) => s.id,
        group: this.checkGroup,
      }),
    };
  }

  private readonly cards = signal([
    this.card(1, 'Backlog', [
      { id: 11, label: 'Step A' },
      { id: 12, label: 'Step B' },
    ]),
    this.card(2, 'In progress', [{ id: 21, label: 'Step C' }]),
    this.card(3, 'Done', [
      { id: 31, label: 'Step D' },
      { id: 32, label: 'Step E' },
    ]),
  ]);

  protected readonly outer = reorderable(this.cards, {
    engine: 'pointer',
    key: (c) => c.id,
  });
}
