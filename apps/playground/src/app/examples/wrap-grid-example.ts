import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';

type Tile = { id: number; label: string; hue: number };

let nextId = 100;
const tile = (label: string, hue: number): Tile => ({
  id: nextId++,
  label,
  hue,
});

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-wrap-grid-example',
  imports: [Reorderable, ReorderableItem],
  template: `
    <main>
      <h1>Wrap grid — 2D sortable flow</h1>
      <p class="hint">
        Drag a tile anywhere in the grid: collision is 2D (nearest slot),
        siblings glide across row boundaries. Keyboard: focus a tile, arrows
        move it a step, Up/Down jump rows.
      </p>

      <ul class="gallery" data-list="gallery" [mmReorderable]="gallery">
        @for (t of gallery.items(); track t.id) {
          <li
            class="tile"
            [style.background]="'hsl(' + t.hue + ' 70% 62%)'"
            [mmReorderableItem]="t"
          >
            {{ t.label }}
          </li>
        }
      </ul>

      <h2>List ↔ wrap grid (one group)</h2>
      <p class="hint">
        Drag a row from the tray into the grid (it lands at the nearest slot,
        appending included) or pull a tile out into the tray.
      </p>
      <div class="split">
        <ul class="tray" data-list="tray" [mmReorderable]="tray">
          @for (t of tray.items(); track t.id) {
            <li class="row" [mmReorderableItem]="t">{{ t.label }}</li>
          }
        </ul>
        <ul class="gallery grouped" data-list="mini" [mmReorderable]="mini">
          @for (t of mini.items(); track t.id) {
            <li
              class="tile"
              [style.background]="'hsl(' + t.hue + ' 70% 62%)'"
              [mmReorderableItem]="t"
            >
              {{ t.label }}
            </li>
          }
        </ul>
      </div>
    </main>
  `,
  styles: `
    main {
      max-width: 720px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    .hint {
      color: #666;
      font-size: 0.9rem;
    }
    .gallery {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      list-style: none;
      padding: 12px;
      margin: 0;
      border: 1px solid #ddd;
      border-radius: 10px;
      min-height: 92px;
    }
    .tile {
      width: 92px;
      height: 92px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: #fff;
      font-weight: 600;
      cursor: grab;
    }
    .tile.mm-sortable-dragging {
      opacity: 0.85;
      cursor: grabbing;
    }
    .split {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 16px;
      align-items: start;
    }
    .tray {
      list-style: none;
      padding: 8px;
      margin: 0;
      border: 1px solid #ddd;
      border-radius: 10px;
      display: grid;
      gap: 8px;
      min-height: 60px;
    }
    .row {
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 8px;
      background: #fafafa;
      cursor: grab;
    }
    .gallery.grouped .tile {
      width: 72px;
      height: 72px;
    }
  `,
})
export class WrapGridExample {
  private readonly tiles = signal<Tile[]>(
    Array.from({ length: 9 }, (_, i) => tile(`T${i + 1}`, (i * 36) % 360)),
  );
  readonly gallery = reorderable(this.tiles, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'wrap',
  });

  readonly group = sortableGroup<Tile>();
  private readonly trayData = signal<Tile[]>([
    tile('New A', 200),
    tile('New B', 260),
  ]);
  private readonly miniData = signal<Tile[]>(
    Array.from({ length: 5 }, (_, i) => tile(`G${i + 1}`, 120 + i * 24)),
  );
  readonly tray = reorderable(this.trayData, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'y',
    group: this.group,
  });
  readonly mini = reorderable(this.miniData, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'wrap',
    group: this.group,
  });
}
