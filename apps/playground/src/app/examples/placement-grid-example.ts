import { Component, signal } from '@angular/core';
import {
  PlacementGrid,
  PlacementGridItem,
  PlacementGridResizeHandle,
  Reorderable,
  ReorderableItem,
  placementGrid,
  reorderable,
  sortableGroup,
  type GridPlacement,
  type PlacementGridController,
} from '@mmstack/dnd';

type Widget = GridPlacement & { id: string; label: string; hue: number };

let seq = 1;
const w_ = (
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  hue: number,
): Widget => ({ id: `w${seq++}`, label, x, y, w, h, hue });

type CellRect = { x: number; y: number; w: number; h: number };

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-placement-grid-example',
  imports: [
    PlacementGrid,
    PlacementGridItem,
    PlacementGridResizeHandle,
    Reorderable,
    ReorderableItem,
  ],
  template: `
    <main>
      <h1>Placement grid — spanning dashboard</h1>
      <p class="hint">
        Drag widgets between cells (neighbours push aside, gravity compacts).
        Resize by the corner grip. Keyboard: arrows move a cell, Shift+arrows
        resize. Drag cards between the tray and the grid — a widget dragged
        over the tray previews as the row it will become.
      </p>

      <div class="split">
        <ul class="tray" data-list="widget-tray" [mmReorderable]="tray">
          @for (t of tray.items(); track t.id) {
            <li class="row" [mmReorderableItem]="t">{{ t.label }}</li>
          }
        </ul>

        <div
          class="grid"
          data-grid="dashboard"
          [mmPlacementGrid]="dashboard"
          #dashGrid="mmPlacementGrid"
        >
          @if (targetCell(dashboard); as cell) {
            <i
              class="target-cell"
              [style.transform]="cellTransform(cell, dashGrid.units.unitX(), dashGrid.units.unitY(), 8)"
              [style.width.px]="cellSpanPx(cell.w, dashGrid.units.unitX(), 8)"
              [style.height.px]="cellSpanPx(cell.h, dashGrid.units.unitY(), 8)"
            ></i>
          }
          @for (w of dashboard.items(); track w.id) {
            <div
              class="widget"
              [class.as-row]="
                dashboard.crossTarget() && dashboard.activeKey() === w.id
              "
              [mmPlacementGridItem]="w"
            >
              <span
                class="widget-body"
                [style.background]="'hsl(' + w.hue + ' 65% 60%)'"
              >
                {{ w.label }}
                <i class="grip" mmPlacementGridResizeHandle="se"></i>
              </span>
            </div>
          }
        </div>
      </div>

      <h2>compact: 'none' — validity-masked (form-builder mode)</h2>
      <p class="hint">
        Nothing reflows: a widget lands only on free cells. Valid targets light
        up while dragging and the drop cell highlights.
      </p>
      <div
        class="grid masked"
        data-grid="masked"
        [mmPlacementGrid]="masked"
        #maskedGrid="mmPlacementGrid"
      >
        @if (maskCells(maskedGrid.units.unitX()); as cells) {
          @for (cell of cells; track cell.i) {
            <i
              class="mask-cell"
              [style.transform]="cell.transform"
              [style.width.px]="maskedGrid.units.unitX()"
              [style.height.px]="maskedGrid.units.unitY()"
            ></i>
          }
        }
        @if (targetCell(masked); as cell) {
          <i
            class="target-cell"
            [style.transform]="cellTransform(cell, maskedGrid.units.unitX(), maskedGrid.units.unitY(), 8)"
            [style.width.px]="cellSpanPx(cell.w, maskedGrid.units.unitX(), 8)"
            [style.height.px]="cellSpanPx(cell.h, maskedGrid.units.unitY(), 8)"
          ></i>
        }
        @for (w of masked.items(); track w.id) {
          <div class="widget" [mmPlacementGridItem]="w">
            <span
              class="widget-body"
              [style.background]="'hsl(' + w.hue + ' 65% 60%)'"
            >
              {{ w.label }}
            </span>
          </div>
        }
      </div>
    </main>
  `,
  styles: `
    main {
      max-width: 860px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    .hint {
      color: #666;
      font-size: 0.9rem;
    }
    .split {
      display: grid;
      grid-template-columns: 170px 1fr;
      gap: 16px;
      align-items: start;
    }
    .tray {
      list-style: none;
      padding: 8px;
      padding-bottom: calc(8px + var(--mm-sortable-reserved, 0px));
      margin: 0;
      border: 1px solid #ddd;
      border-radius: 10px;
      display: grid;
      gap: 8px;
      min-height: 60px;
      align-content: start;
    }
    .row {
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 8px;
      background: #fafafa;
      cursor: grab;
      box-sizing: border-box;
      height: 42px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .grid {
      border: 1px solid #ddd;
      border-radius: 10px;
      background:
        repeating-linear-gradient(
          to right,
          transparent 0,
          transparent calc(100% / 12 - 1px),
          #f0f0f0 calc(100% / 12 - 1px),
          #f0f0f0 calc(100% / 12)
        );
      min-height: 240px;
    }
    .widget {
      cursor: grab;
    }
    .widget-body {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      border-radius: 8px;
      color: #fff;
      font-weight: 600;
      box-sizing: border-box;
      overflow: hidden;
      transition:
        width 160ms ease,
        height 160ms ease;
    }
    .widget.mm-grid-dragging {
      cursor: grabbing;
    }
    .widget.mm-grid-dragging .widget-body {
      opacity: 0.92;
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
    }
    /* over the tray, the dragged widget previews as the row it will become */
    .widget.as-row {
      display: grid;
      place-items: center;
    }
    .widget.as-row .widget-body {
      width: 150px;
      height: 42px;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.85rem;
    }
    .widget.as-row .grip {
      display: none;
    }
    .grip {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      border-right: 3px solid rgb(255 255 255 / 0.8);
      border-bottom: 3px solid rgb(255 255 255 / 0.8);
      border-radius: 2px;
    }
    .mask-cell {
      position: absolute;
      top: 0;
      left: 0;
      background: rgb(46 160 67 / 0.15);
      outline: 1px dashed rgb(46 160 67 / 0.5);
      border-radius: 4px;
      pointer-events: none;
    }
    .target-cell {
      position: absolute;
      top: 0;
      left: 0;
      background: rgb(25 113 255 / 0.14);
      outline: 2px solid rgb(25 113 255 / 0.65);
      border-radius: 6px;
      pointer-events: none;
    }
  `,
})
export class PlacementGridExample {
  readonly group = sortableGroup<Widget>();

  private readonly widgets = signal<Widget[]>([
    w_('Chart', 0, 0, 6, 2, 210),
    w_('KPIs', 6, 0, 3, 2, 260),
    w_('Feed', 9, 0, 3, 4, 330),
    w_('Table', 0, 2, 9, 3, 160),
  ]);
  readonly dashboard = placementGrid(this.widgets, {
    key: (w) => w.id,
    cols: 12,
    gap: 8,
    rowHeight: 56,
    group: this.group,
    autoScroll: { edge: 48, speed: 14 },
  });

  private readonly trayData = signal<Widget[]>([
    w_('Notes', 0, 0, 3, 2, 20),
    w_('Map', 0, 0, 4, 3, 100),
  ]);
  readonly tray = reorderable(this.trayData, {
    key: (t) => t.id,
    engine: 'pointer',
    axis: 'y',
    group: this.group,
    insertSize: 50, // arrivals render as 42px rows here (+ 8px list gap)
  });

  private readonly maskedData = signal<Widget[]>([
    w_('A', 0, 0, 2, 2, 210),
    w_('B', 4, 0, 2, 2, 260),
    w_('C', 2, 2, 2, 2, 330),
  ]);
  readonly masked = placementGrid(this.maskedData, {
    key: (w) => w.id,
    cols: 8,
    gap: 8,
    rowHeight: 48,
    compact: 'none',
  });

  /** The active drag's projected drop rect (cells), or null. */
  targetCell(grid: PlacementGridController<Widget, string>): CellRect | null {
    const key = grid.activeKey();
    if (key === null || grid.crossTarget()) return null;
    const cell = grid.projectedCell();
    if (!cell) return null;
    const item = grid.previewLayout().find((w) => w.id === key);
    if (!item) return null;
    return { x: cell.x, y: cell.y, w: item.w, h: item.h };
  }

  cellTransform(
    cell: CellRect,
    unitX: number,
    unitY: number,
    gap: number,
  ): string {
    return `translate(${cell.x * (unitX + gap)}px, ${cell.y * (unitY + gap)}px)`;
  }

  cellSpanPx(span: number, unit: number, gap: number): number {
    return span * unit + (span - 1) * gap;
  }

  maskCells(unitX: number): { i: number; transform: string }[] | null {
    const mask = this.masked.targetMask();
    if (!mask || unitX <= 0) return null;
    const cols = 8;
    const gap = 8;
    const rowH = 48;
    const out: { i: number; transform: string }[] = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = (i % cols) * (unitX + gap);
      const y = Math.floor(i / cols) * (rowH + gap);
      out.push({ i, transform: `translate(${x}px, ${y}px)` });
    }
    return out;
  }
}
