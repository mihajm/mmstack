import { Component, signal } from '@angular/core';
import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Tile = { id: number; label: string; hue: number };

@Component({
  selector: 'demo-wrap-grid',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul class="gallery" [mmReorderable]="gallery">
      @for (t of gallery.items(); track t.id) {
        <li
          class="tile"
          [style.background]="'hsl(' + t.hue + ' 65% 60%)'"
          [mmReorderableItem]="t"
        >
          {{ t.label }}
        </li>
      }
    </ul>
  `,
  styles: `
    .gallery {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      list-style: none;
      margin: 0;
      padding: 0;
      max-width: 26rem;
    }

    .tile {
      width: 72px;
      height: 72px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      color: #fff;
      font-weight: 600;
      cursor: grab;
    }

    .tile.mm-sortable-dragging {
      cursor: grabbing;
      opacity: 0.92;
      box-shadow: 0 8px 24px rgb(0 0 0 / 22%);
    }
  `,
})
export class WrapGridDemo {
  private readonly data = signal<Tile[]>(
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      label: `T${i + 1}`,
      hue: (i * 41) % 360,
    })),
  );

  protected readonly gallery = reorderable(this.data, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'wrap',
  });
}
