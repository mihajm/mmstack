import { Component, computed, signal } from '@angular/core';
import {
  opLog,
  store,
  storeHistory,
  type OpBatch,
  type StoreOp,
} from '@mmstack/primitives';
import {
  Canvas,
  CanvasItem,
  CanvasResizeHandle,
  injectCanvas,
  type CanvasFrame,
} from '@mmstack/dnd';

type Widget = { id: string; label: string; hue: number; frame: CanvasFrame };
type Doc = { widgets: Widget[] };

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-canvas-store-example',
  imports: [Canvas, CanvasItem, CanvasResizeHandle],
  template: `
    <main>
      <h1>Canvas × store — one gesture, one op batch</h1>
      <p class="hint">
        The document lives in an @mmstack/primitives store. A whole drag
        commits as ONE batch of per-property ops (watch the trace), so
        undo/redo and mesh collaboration get gesture-grained history for free.
      </p>

      <p class="toolbar">
        <button data-testid="undo" (click)="history.undo()" [disabled]="!history.canUndo()">
          Undo
        </button>
        <button data-testid="redo" (click)="history.redo()" [disabled]="!history.canRedo()">
          Redo
        </button>
        <span data-testid="batch-count">{{ batches().length }} batches</span>
      </p>

      <div class="viewport" data-canvas="store" [mmCanvas]="ctrl">
        @for (w of ctrl.items(); track w.id) {
          <div
            class="widget"
            [style.background]="'hsl(' + w.hue + ' 65% 60%)'"
            [attr.data-widget]="w.id"
            [mmCanvasItem]="w"
          >
            {{ w.label }}
            @if (soloSelected() === w.id) {
              <i class="handle se" mmCanvasResizeHandle="se"></i>
            }
          </div>
        }
      </div>

      <h2>Op trace</h2>
      <ol class="trace" data-testid="trace">
        @for (b of batches(); track $index) {
          <li>
            @for (op of b.ops; track $index) {
              <code>{{ fmt(op) }}</code>
            }
          </li>
        }
      </ol>
    </main>
  `,
  styles: `
    main {
      max-width: 760px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    .hint {
      color: #666;
      font-size: 0.9rem;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .viewport {
      height: 320px;
      border: 1px solid #ddd;
      border-radius: 10px;
      overflow: hidden;
      background:
        radial-gradient(circle, #e8e8e8 1px, transparent 1px) 0 0 / 24px 24px;
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
    .handle {
      position: absolute;
      width: 10px;
      height: 10px;
      background: #fff;
      border: 2px solid #1971ff;
      border-radius: 2px;
    }
    .handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
    .trace {
      max-height: 180px;
      overflow: auto;
      font-size: 0.8rem;
      border: 1px solid #eee;
      border-radius: 8px;
      padding: 8px 8px 8px 28px;
    }
    .trace code {
      display: block;
    }
  `,
})
export class CanvasStoreExample {
  readonly doc = store<Doc>({
    widgets: [
      { id: 'a', label: 'Alpha', hue: 210, frame: { x: 40, y: 40, width: 140, height: 90 } },
      { id: 'b', label: 'Beta', hue: 300, frame: { x: 240, y: 90, width: 120, height: 120 } },
      { id: 'c', label: 'Gamma', hue: 150, frame: { x: 120, y: 200, width: 130, height: 70 } },
    ],
  });
  readonly history = storeHistory(this.doc);
  readonly batches = signal<readonly OpBatch[]>([]);

  readonly ctrl = injectCanvas<Widget, string>(this.doc.widgets, {
    key: (w) => w.id,
    frame: (w) => w.frame,
    patch: (w, frame) => ({ ...w, frame }),
    grid: { size: 8 },
  });

  readonly soloSelected = computed(() => {
    const ids = this.ctrl.selection.ids();
    return ids.length === 1 ? ids[0] : null;
  });

  fmt(op: StoreOp): string {
    const path = op.path.join('.');
    return op.kind === 'set'
      ? `set ${path} → ${JSON.stringify(op.next)}`
      : `delete ${path}`;
  }

  constructor() {
    opLog(this.doc, { origin: 'playground' }).subscribe((b) =>
      this.batches.update((all) => [...all, b]),
    );
  }
}
