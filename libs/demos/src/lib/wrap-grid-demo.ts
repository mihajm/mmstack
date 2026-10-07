import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableItem,
  reorderable,
} from '@mmstack/dnd';
import { DemoReset } from './demo-reset';

type Tile = { id: number; label: string; hue: number };

@Component({
  selector: 'demo-wrap-grid',
  imports: [Reorderable, ReorderableItem, DemoReset],
  template: `
    <demo-reset (restore)="data.set(seed())" />
    <p class="touch-hint">Hold a tile to drag it.</p>
    <ul class="gallery" [mmReorderable]="gallery">
      @for (t of gallery.items(); track t.id) {
        <li
          class="tile"
          [style.background]="'hsl(' + t.hue + ' 65% 46%)'"
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
      position: relative;
      width: 72px;
      height: 72px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      color: #fff;
      font-weight: 600;
      cursor: grab;
    }

    .touch-hint {
      display: none;
      margin: 0 0 0.5rem;
      color: var(--fg-muted, #6b7280);
      font-size: 0.8rem;
    }

    @media (pointer: coarse) {
      .touch-hint {
        display: block;
      }
    }

    .tile.mm-sortable-dragging {
      cursor: grabbing;
      opacity: 0.92;
      box-shadow: 0 8px 24px rgb(0 0 0 / 22%);
    }
  `,
})
export class WrapGridDemo {
  protected readonly seed = (): Tile[] =>
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      label: `T${i + 1}`,
      hue: (220 + i * 20) % 360,
    }));
  protected readonly data = signal<Tile[]>(this.seed());

  protected readonly gallery = reorderable(this.data, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'wrap',
    // touch: hold to drag, so a swipe over the tiles still scrolls the page
    touchActivation: { delay: 250 },
  });
}
