import { Component, signal } from '@angular/core';
import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';
import { DemoReset } from './demo-reset';

type Tag = { id: number; label: string };

@Component({
  selector: 'demo-sortable-horizontal',
  imports: [Reorderable, ReorderableItem, DemoReset],
  template: `
    <demo-reset (restore)="tags.set(seed())" />
    <ul class="list" [mmReorderable]="list">
      @for (tag of list.items(); track tag.id) {
        <li class="chip" [mmReorderableItem]="tag">{{ tag.label }}</li>
      }
    </ul>
  `,
  styles: `
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      gap: 8px;
    }

    .chip {
      padding: 8px 14px;
      background: var(--bg, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      cursor: grab;
      white-space: nowrap;
      font-size: 0.9rem;
    }

    @media (max-width: 480px) {
      .list {
        gap: 6px;
      }

      .chip {
        padding: 6px 9px;
        font-size: 0.82rem;
      }
    }

    .chip.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: var(--accent, #c7d2fe);
    }
  `,
})
export class SortableHorizontalDemo {
  protected readonly seed = (): Tag[] => [
    { id: 1, label: 'urgent' },
    { id: 2, label: 'design' },
    { id: 3, label: 'backend' },
    { id: 4, label: 'docs' },
    { id: 5, label: 'wontfix' },
  ];
  protected readonly tags = signal<Tag[]>(this.seed());

  protected readonly list = reorderable(this.tags, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'x',
  });
}
