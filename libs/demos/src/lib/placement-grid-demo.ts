import { Component, signal } from '@angular/core';
import {
  PlacementGrid,
  PlacementGridItem,
  PlacementGridResizeHandle,
  placementGrid,
  type GridPlacement,
} from '@mmstack/dnd';
import { DemoReset } from './demo-reset';

type Widget = GridPlacement & { id: string; label: string; hue: number };

@Component({
  selector: 'demo-placement-grid',
  imports: [
    PlacementGrid,
    PlacementGridItem,
    PlacementGridResizeHandle,
    DemoReset,
  ],
  template: `
    <demo-reset (restore)="data.set(seed())" />
    <p class="touch-hint">Hold a widget to move it. Resize from the corner.</p>
    <div
      class="grid"
      [class.outside]="grid.dropOutside()"
      [mmPlacementGrid]="grid"
      #gridRef="mmPlacementGrid"
    >
      @if (home(); as cell) {
        <i
          class="home"
          [style.transform]="
            'translate(' +
            cell.x * (gridRef.units.unitX() + 8) +
            'px, ' +
            cell.y * (gridRef.units.unitY() + 8) +
            'px)'
          "
          [style.width.px]="cell.w * gridRef.units.unitX() + (cell.w - 1) * 8"
          [style.height.px]="cell.h * gridRef.units.unitY() + (cell.h - 1) * 8"
          >Release to cancel</i
        >
      }
      @if (target(); as cell) {
        <i
          class="target"
          [style.transform]="
            'translate(' +
            cell.x * (gridRef.units.unitX() + 8) +
            'px, ' +
            cell.y * (gridRef.units.unitY() + 8) +
            'px)'
          "
          [style.width.px]="cell.w * gridRef.units.unitX() + (cell.w - 1) * 8"
          [style.height.px]="cell.h * gridRef.units.unitY() + (cell.h - 1) * 8"
        ></i>
      }
      @for (w of grid.items(); track w.id) {
        <div class="widget" [mmPlacementGridItem]="w">
          <span class="body" [style.background]="'hsl(' + w.hue + ' 60% 50%)'">
            {{ w.label }}
            <i class="grip" mmPlacementGridResizeHandle="se"></i>
          </span>
        </div>
      }
    </div>
  `,
  styles: `
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

    .grid {
      border: 1px dashed var(--border, #e5e7eb);
      border-radius: 10px;
      min-height: 180px;
    }

    .grid.outside {
      border-color: var(--fg-muted, #6b7280);
    }

    .widget {
      cursor: grab;
    }

    .grid.outside .widget.mm-grid-dragging .body {
      opacity: 0.55;
    }

    .body {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      border-radius: 8px;
      color: #fff;
      font-weight: 600;
      box-sizing: border-box;
    }

    .widget.mm-grid-dragging {
      cursor: grabbing;
    }

    .widget.mm-grid-dragging .body {
      opacity: 0.92;
      box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    }

    .grip {
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 12px;
      height: 12px;
      cursor: nwse-resize;
      border-right: 3px solid rgb(255 255 255 / 80%);
      border-bottom: 3px solid rgb(255 255 255 / 80%);
      border-radius: 2px;
    }

    .home {
      position: absolute;
      top: 0;
      left: 0;
      display: grid;
      place-items: center;
      box-sizing: border-box;
      border: 2px dashed var(--fg-muted, #6b7280);
      border-radius: 8px;
      color: var(--fg-muted, #6b7280);
      font-style: normal;
      font-size: 0.8rem;
      font-weight: 600;
      text-align: center;
      pointer-events: none;
    }

    .target {
      position: absolute;
      top: 0;
      left: 0;
      background: rgb(99 102 241 / 14%);
      outline: 2px solid rgb(99 102 241 / 60%);
      border-radius: 8px;
      pointer-events: none;
    }
  `,
})
export class PlacementGridDemo {
  protected readonly seed = (): Widget[] => [
    { id: 'chart', label: 'Chart', x: 0, y: 0, w: 4, h: 2, hue: 222 },
    { id: 'kpis', label: 'KPIs', x: 4, y: 0, w: 2, h: 1, hue: 262 },
    { id: 'feed', label: 'Feed', x: 4, y: 1, w: 2, h: 2, hue: 320 },
    { id: 'table', label: 'Table', x: 0, y: 2, w: 4, h: 1, hue: 0 },
  ];
  protected readonly data = signal<Widget[]>(this.seed());

  protected readonly grid = placementGrid(this.data, {
    key: (w) => w.id,
    cols: 6,
    gap: 8,
    rowHeight: 52,
    // touch: hold to move, so a swipe over the widgets still scrolls the page
    touchActivation: { delay: 250 },
  });

  // While the pointer is outside the grid, outline the slot the widget goes back to.
  protected home(): GridPlacement | null {
    if (!this.grid.dropOutside()) return null;
    const key = this.grid.activeKey();
    return this.data().find((w) => w.id === key) ?? null;
  }

  protected target(): GridPlacement | null {
    const key = this.grid.activeKey();
    if (key === null) return null;
    const cell = this.grid.projectedCell();
    if (!cell) return null;
    const item = this.grid.previewLayout().find((w) => w.id === key);
    return item ? { x: cell.x, y: cell.y, w: item.w, h: item.h } : null;
  }
}
