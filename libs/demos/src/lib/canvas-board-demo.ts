import { Component, computed, signal } from '@angular/core';
import {
  Canvas,
  CanvasItem,
  CanvasResizeHandle,
  injectCanvas,
  type CanvasFrame,
} from '@mmstack/dnd';

type Widget = { id: string; label: string; hue: number; frame: CanvasFrame };

@Component({
  selector: 'demo-canvas-board',
  imports: [Canvas, CanvasItem, CanvasResizeHandle],
  template: `
    <div class="board" [mmCanvas]="ctrl">
      @for (w of ctrl.items(); track w.id) {
        <div
          class="widget"
          [style.background]="'hsl(' + w.hue + ' 60% 58%)'"
          [mmCanvasItem]="w"
        >
          {{ w.label }}
          @if (solo() === w.id) {
            <i class="handle nw" mmCanvasResizeHandle="nw"></i>
            <i class="handle ne" mmCanvasResizeHandle="ne"></i>
            <i class="handle sw" mmCanvasResizeHandle="sw"></i>
            <i class="handle se" mmCanvasResizeHandle="se"></i>
          }
        </div>
      }
      <svg class="overlay">
        @for (g of ctrl.session.guides(); track $index) {
          @if (g.axis === 'x') {
            <line
              class="guide"
              [attr.x1]="g.position"
              [attr.x2]="g.position"
              [attr.y1]="g.from"
              [attr.y2]="g.to"
            />
          } @else {
            <line
              class="guide"
              [attr.x1]="g.from"
              [attr.x2]="g.to"
              [attr.y1]="g.position"
              [attr.y2]="g.position"
            />
          }
        }
        @if (ctrl.session.marqueeRect(); as r) {
          <rect
            class="marquee"
            [attr.x]="r.x"
            [attr.y]="r.y"
            [attr.width]="r.width"
            [attr.height]="r.height"
          />
        }
      </svg>
    </div>
  `,
  styles: `
    .board {
      height: 300px;
      border: 1px dashed var(--border, #e5e7eb);
      border-radius: 10px;
      overflow: hidden;
      background:
        radial-gradient(circle, var(--border, #e5e7eb) 1px, transparent 1px) 0 0 /
        20px 20px;
    }

    .widget {
      border-radius: 10px;
      color: #fff;
      font-weight: 600;
      display: grid;
      place-items: center;
      cursor: grab;
      box-sizing: border-box;
    }

    .widget.mm-canvas-selected {
      outline: 2px solid var(--accent, #6366f1);
      outline-offset: 1px;
    }

    .widget.mm-canvas-dragging {
      cursor: grabbing;
      box-shadow: 0 10px 30px rgb(0 0 0 / 25%);
    }

    .handle {
      position: absolute;
      width: 10px;
      height: 10px;
      background: var(--bg, #fff);
      border: 2px solid var(--accent, #6366f1);
      border-radius: 2px;
    }
    .handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
    .handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
    .handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
    .handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }

    .overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .guide {
      stroke: #f43f5e;
      stroke-width: 1;
    }

    .marquee {
      fill: rgb(99 102 241 / 8%);
      stroke: var(--accent, #6366f1);
      stroke-dasharray: 4 3;
    }
  `,
})
export class CanvasBoardDemo {
  private readonly data = signal<readonly Widget[]>([
    { id: 'a', label: 'Hero', hue: 222, frame: { x: 24, y: 24, width: 130, height: 74 } },
    { id: 'b', label: 'Card', hue: 262, frame: { x: 200, y: 48, width: 96, height: 96 } },
    { id: 'c', label: 'Note', hue: 320, frame: { x: 72, y: 160, width: 110, height: 64 } },
  ]);

  protected readonly ctrl = injectCanvas<Widget, string>(this.data, {
    key: (w) => w.id,
    frame: (w) => w.frame,
    patch: (w, frame) => ({ ...w, frame }),
    grid: { size: 4 },
  });

  protected readonly solo = computed(() => {
    const ids = this.ctrl.selection.ids();
    return ids.length === 1 ? ids[0] : null;
  });
}
