import { Component, computed, signal, viewChild, type ElementRef } from '@angular/core';
import {
  Canvas,
  CanvasItem,
  CanvasResizeHandle,
  CanvasRotateHandle,
  injectCanvas,
  panZoom,
  type CanvasFrame,
} from '@mmstack/dnd';

type Widget = { id: string; label: string; hue: number; frame: CanvasFrame };

let seq = 1;
const w_ = (
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  hue: number,
): Widget => ({
  id: `w${seq++}`,
  label,
  hue,
  frame: { x, y, width, height },
});

function seedWidgets(): Widget[] {
  const n =
    typeof location !== 'undefined'
      ? Number(new URLSearchParams(location.search).get('n')) || 0
      : 0;
  if (n > 4) {
    return Array.from({ length: n }, (_, i) =>
      w_(
        `W${i + 1}`,
        16 + (i % 16) * 52,
        16 + Math.floor(i / 16) * 40,
        44,
        32,
        (i * 23) % 360,
      ),
    );
  }
  return [
    w_('Hero', 40, 40, 160, 90, 210),
    w_('Card', 260, 60, 120, 120, 260),
    w_('Note', 90, 220, 140, 80, 330),
    w_('Badge', 320, 260, 90, 60, 160),
  ];
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-canvas-controller-example',
  imports: [Canvas, CanvasItem, CanvasResizeHandle, CanvasRotateHandle],
  template: `
    <main>
      <h1>Canvas — free-form move / resize / rotate / marquee</h1>
      <p class="hint">
        Drag widgets (Shift locks the axis, Ctrl bypasses snapping); drag empty
        space to marquee-select; Shift-click adds to the selection. Resize by
        the corner handles (Shift keeps the ratio, Alt resizes from center),
        rotate by the top handle. Wheel zooms around the cursor, middle-drag
        pans. Arrows nudge, Cmd/Ctrl+arrows resize.
      </p>

      <div class="viewport" data-canvas="main" #viewport [mmCanvas]="ctrl">
        <div class="space" [style.transform]="spaceCss()">
          @for (w of ctrl.items(); track w.id) {
            <div
              class="widget"
              [style.background]="'hsl(' + w.hue + ' 65% 60%)'"
              [attr.data-widget]="w.id"
              [mmCanvasItem]="w"
            >
              {{ w.label }}
              @if (soloSelected() === w.id) {
                <i class="rotate" mmCanvasRotateHandle></i>
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
      </div>
      <p class="hint">
        Selected: <span data-testid="selected">{{ selectedLabel() }}</span>
        · zoom {{ zoomLabel() }}
      </p>
    </main>
  `,
  styles: `
    main {
      max-width: 900px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    .hint {
      color: #666;
      font-size: 0.9rem;
    }
    .viewport {
      height: 460px;
      border: 1px solid #ddd;
      border-radius: 10px;
      overflow: hidden;
      background:
        radial-gradient(circle, #e8e8e8 1px, transparent 1px) 0 0 / 24px 24px;
    }
    .space {
      position: absolute;
      inset: 0;
      transform-origin: 0 0;
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
      outline: 2px solid #1971ff;
      outline-offset: 1px;
    }
    .widget.mm-canvas-dragging {
      cursor: grabbing;
      box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
    }
    .handle {
      position: absolute;
      width: 10px;
      height: 10px;
      background: #fff;
      border: 2px solid #1971ff;
      border-radius: 2px;
    }
    .handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
    .handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
    .handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
    .handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
    .rotate {
      position: absolute;
      top: -26px;
      left: calc(50% - 6px);
      width: 12px;
      height: 12px;
      border: 2px solid #1971ff;
      border-radius: 50%;
      background: #fff;
      cursor: grab;
    }
    .overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }
    .guide {
      stroke: #ff4081;
      stroke-width: 1;
    }
    .marquee {
      fill: rgb(25 113 255 / 0.08);
      stroke: #1971ff;
      stroke-dasharray: 4 3;
    }
  `,
})
export class CanvasControllerExample {
  private readonly widgets = signal<readonly Widget[]>(seedWidgets());

  private readonly viewport =
    viewChild<ElementRef<HTMLElement>>('viewport');
  readonly zoom = panZoom(this.viewport);
  readonly ctrl = injectCanvas<Widget, string>(this.widgets, {
    key: (w) => w.id,
    frame: (w) => w.frame,
    patch: (w, frame) => ({ ...w, frame }),
    grid: { size: 8 },
    rotate: { snap: 15 },
    space: this.zoom,
    autoScroll: false,
  });

  readonly spaceCss = computed(() => {
    const t = this.zoom.transform();
    return `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
  });
  readonly zoomLabel = computed(
    () => `${Math.round(this.zoom.transform().scale * 100)}%`,
  );
  readonly soloSelected = computed(() => {
    const ids = this.ctrl.selection.ids();
    return ids.length === 1 ? ids[0] : null;
  });
  readonly selectedLabel = computed(
    () => this.ctrl.selection.ids().join(', ') || 'none',
  );
}
