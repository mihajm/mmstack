import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  runInInjectionContext,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { injectAnnounce } from '@mmstack/dnd';
import { toWritable } from '@mmstack/primitives';
import {
  marquee,
  movable,
  ResizeHandle,
  RotateHandle,
  selection,
  type Box,
  type Guide,
  type MovableRef,
  type Point,
  type SelectionRef,
} from '../canvas';

const GRID = 20;
const SURFACE: Box = { x: 0, y: 0, width: 1600, height: 1000 };

type Widget = {
  id: number;
  pos: WritableSignal<Point>;
  size: WritableSignal<{ width: number; height: number }>;
  angle: WritableSignal<number>;
  color: string;
  label: string;
};

function makeWidget(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  label: string,
): Widget {
  return {
    id,
    pos: signal<Point>({ x, y }),
    size: signal({ width, height }),
    angle: signal(0),
    color,
    label,
  };
}

const COLORS = ['#bfdbfe', '#bbf7d0', '#fde68a', '#fbcfe8', '#ddd6fe'];

@Component({
  selector: 'mm-canvas-widget',
  imports: [ResizeHandle, RotateHandle],
  template: `
    <span class="label">{{ widget().label }}</span>
    <div
      class="rotate"
      [mmRotateHandle]="widget().angle"
      [center]="center"
      [snap]="15"
      (pointerdown)="$event.stopPropagation()"
    ></div>
    <div
      class="handle"
      [mmResizeHandle]="box"
      direction="se"
      [min]="MIN"
      [bounds]="bounds()"
      [snapTargets]="siblings()"
      [snapToCanvas]="true"
      (pointerdown)="$event.stopPropagation()"
    ></div>
  `,
  host: {
    '[style.left.px]': 'widget().pos().x',
    '[style.top.px]': 'widget().pos().y',
    '[style.width.px]': 'widget().size().width',
    '[style.height.px]': 'widget().size().height',
    '[style.transform]': '"rotate(" + widget().angle() + "deg)"',
    '[style.background]': 'widget().color',
    '[class.selected]': 'isSelected()',
    '[class.moving]': 'moving()',
    tabindex: '0',
    role: 'button',
    '[attr.aria-label]': 'widget().label',
    '[attr.aria-pressed]': 'isSelected()',
    '(pointerdown)': 'onDown($event)',
    '(focus)': 'onFocus()',
    '(keydown)': 'onKeydown($event)',
  },
  styles: `
    :host {
      position: absolute;
      border-radius: 8px;
      box-sizing: border-box;
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      font:
        600 13px system-ui,
        sans-serif;
      color: #1e293b;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    :host.selected {
      outline: 2px solid #2563eb;
      outline-offset: 1px;
    }
    :host.moving {
      cursor: grabbing;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    }
    :host:focus-visible {
      outline: 2px solid #2563eb;
    }
    .handle {
      position: absolute;
      right: -5px;
      bottom: -5px;
      width: 12px;
      height: 12px;
      background: #2563eb;
      border: 2px solid white;
      border-radius: 3px;
      cursor: nwse-resize;
      touch-action: none;
    }
    .rotate {
      position: absolute;
      left: 50%;
      top: -24px;
      transform: translateX(-50%);
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ec4899;
      border: 2px solid white;
      cursor: grab;
      touch-action: none;
    }
  `,
})
export class CanvasWidget {
  readonly widget = input.required<Widget>();
  readonly all = input.required<readonly Widget[]>();
  readonly sel = input.required<SelectionRef<number>>();
  readonly bounds = input.required<Box>();
  readonly guidesSink = input.required<WritableSignal<readonly Guide[]>>();
  readonly scrollEl = input<HTMLElement>();

  private readonly injector = inject(Injector);
  private readonly announcer = injectAnnounce();
  private readonly hostEl =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly _ref = signal<MovableRef | undefined>(undefined);

  // client-space pivot for rotation (read at gesture start)
  protected readonly center = (): Point => {
    const r = this.hostEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  protected readonly MIN = { width: 60, height: 40 };
  protected readonly moving = computed(() => this._ref()?.moving() ?? false);
  protected readonly isSelected = computed(() =>
    this.sel().has(this.widget().id),
  );

  // a writable Box over pos+size, for the resize handle
  protected readonly box = toWritable<Box>(
    computed(() => ({ ...this.widget().pos(), ...this.widget().size() })),
    (b) => {
      this.widget().pos.set({ x: b.x, y: b.y });
      this.widget().size.set({ width: b.width, height: b.height });
    },
  );

  protected readonly siblings = computed<Box[]>(() =>
    this.all()
      .filter((w) => w.id !== this.widget().id)
      .map((w) => ({ ...w.pos(), ...w.size() })),
  );

  private readonly resizer = viewChild(ResizeHandle);

  constructor() {
    afterNextRender(() => {
      const w = this.widget();
      runInInjectionContext(this.injector, () => {
        const ref = movable(w.pos, {
          grid: { size: GRID },
          bounds: this.bounds,
          size: () => w.size(),
          snapTargets: this.siblings,
          snapToCanvas: true,
          scroll: this.scrollEl(),
          keyboard: true,
          group: () =>
            this.sel().has(w.id)
              ? this.all()
                  .filter((x) => x.id !== w.id && this.sel().has(x.id))
                  .map((x) => x.pos)
              : [],
          onMoveEnd: ({ position }) =>
            this.announcer(
              `${w.label} moved to ${Math.round(position.x)}, ${Math.round(position.y)}`,
            ),
        });
        this._ref.set(ref);

        // surface the active widget's guides (move OR resize) up to the board
        let mine = false;
        effect(() => {
          const rz = this.resizer();
          const active = ref.moving() || (rz?.resizing() ?? false);
          if (active) {
            mine = true;
            this.guidesSink().set(
              ref.moving() ? ref.guides() : (rz?.guides() ?? []),
            );
          } else if (mine) {
            mine = false;
            this.guidesSink().set([]);
          }
        });
      });
    });
  }

  protected onDown(e: PointerEvent): void {
    e.stopPropagation(); // don't start a marquee on the surface
    const id = this.widget().id;
    const sel = this.sel();
    if (e.shiftKey) sel.toggle(id);
    else if (!sel.has(id)) sel.set([id]);
  }

  // Tabbing to a widget selects it (keeps selection ↔ focus in sync), unless it's
  // already part of a multi-selection (so you can Tab within a group).
  protected onFocus(): void {
    const sel = this.sel();
    if (!sel.has(this.widget().id)) sel.set([this.widget().id]);
  }

  // Space/Enter toggles selection — keyboard multi-select (arrows are movable's).
  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.sel().toggle(this.widget().id);
    }
  }
}

@Component({
  selector: 'mm-canvas-board',
  imports: [CanvasWidget],
  template: `
    @for (g of guides(); track $index) {
      <div
        class="guide"
        [style.left.px]="g.axis === 'x' ? g.position : g.from"
        [style.top.px]="g.axis === 'y' ? g.position : g.from"
        [style.width.px]="g.axis === 'x' ? 0 : g.to - g.from"
        [style.height.px]="g.axis === 'y' ? 0 : g.to - g.from"
      ></div>
    }
    @if (band.rect(); as r) {
      <div
        class="marquee"
        [style.left.px]="r.x"
        [style.top.px]="r.y"
        [style.width.px]="r.width"
        [style.height.px]="r.height"
      ></div>
    }
    @for (w of widgets(); track w.id) {
      <mm-canvas-widget
        [widget]="w"
        [all]="widgets()"
        [sel]="sel"
        [bounds]="bounds"
        [guidesSink]="guides"
        [scrollEl]="scrollEl()"
      />
    }
  `,
  host: {
    '[style.width.px]': 'bounds.width',
    '[style.height.px]': 'bounds.height',
    '(keydown)': 'onKey($event)',
    '(pointerdown)': 'onSurfaceDown($event)',
  },
  styles: `
    :host {
      position: relative;
      display: block;
      touch-action: none;
      background-color: #fafafa;
      background-image:
        linear-gradient(#eef2f7 1px, transparent 1px),
        linear-gradient(90deg, #eef2f7 1px, transparent 1px);
      background-size: ${GRID}px ${GRID}px;
    }
    .guide {
      position: absolute;
      background: #ec4899;
      pointer-events: none;
      z-index: 50;
    }
    .guide[style*='width: 0'] {
      width: 1px !important;
    }
    .guide[style*='height: 0'] {
      height: 1px !important;
    }
    .marquee {
      position: absolute;
      background: rgba(37, 99, 235, 0.12);
      border: 1px solid #2563eb;
      pointer-events: none;
      z-index: 40;
    }
  `,
})
export class CanvasBoard {
  readonly scrollEl = input<HTMLElement>();

  protected readonly bounds = SURFACE;
  protected readonly sel = selection<number>();
  protected readonly guides = signal<readonly Guide[]>([]);
  protected readonly widgets = signal<Widget[]>([
    makeWidget(1, 60, 60, 160, 100, COLORS[0], 'Header'),
    makeWidget(2, 280, 60, 120, 100, COLORS[1], 'Card'),
    makeWidget(3, 60, 220, 160, 80, COLORS[2], 'Button'),
  ]);

  readonly selectedCount = this.sel.size;
  private nextId = 4;

  protected readonly items = computed(() =>
    this.widgets().map((w) => ({
      id: w.id,
      box: { ...w.pos(), ...w.size() } as Box,
      value: w.id,
    })),
  );
  protected readonly band = marquee<number>(this.items);

  private readonly hostEl =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly announcer = injectAnnounce();

  constructor() {
    let selecting = false;
    effect(() => {
      if (this.band.selecting()) {
        selecting = true;
        this.sel.set(this.band.selected());
      } else if (selecting) {
        selecting = false; // keep the final selection
      }
    });
  }

  // Click on empty canvas clears the selection (Shift keeps it for marquee-add).
  protected onSurfaceDown(e: PointerEvent): void {
    if (e.target === this.hostEl && !e.shiftKey) this.sel.clear();
  }

  add(): void {
    const n = this.nextId++;
    const offset = ((n - 1) % 6) * GRID;
    this.widgets.update((ws) => [
      ...ws,
      makeWidget(
        n,
        100 + offset,
        100 + offset,
        140,
        90,
        COLORS[n % COLORS.length],
        'Widget ' + n,
      ),
    ]);
    this.announcer('Added Widget ' + n);
  }

  removeSelected(): void {
    const count = this.selectedCount();
    this.widgets.update((ws) => ws.filter((w) => !this.sel.has(w.id)));
    this.sel.clear();
    this.announcer(
      `Deleted ${count} widget${count === 1 ? '' : 's'}`,
      'assertive',
    );
  }

  clearSelection(): void {
    this.sel.clear();
  }

  protected onKey(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedCount()) {
      e.preventDefault();
      this.removeSelected();
    }
  }
}

@Component({
  selector: 'mm-canvas-example',
  imports: [CanvasBoard],
  template: `
    <h2>Canvas — Figma-style layout builder</h2>
    <p class="hint">
      Drag to move (snaps to grid &amp; to other widgets — pink guides). Drag
      the corner to resize (also snaps), the top dot to rotate (<kbd>Shift</kbd>
      = 15° steps). Click to select, <kbd>Shift</kbd>+click for multi, drag
      empty space to marquee, click empty space to clear. With a selection:
      arrows nudge (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> = ×10),
      <kbd>Shift</kbd> while dragging locks the axis, <kbd>⌫</kbd> deletes. Drag
      near an edge to auto-scroll. Actions are announced to screen readers.
    </p>

    <div class="toolbar">
      <button (click)="board.add()">+ Add widget</button>
      <button
        [disabled]="!board.selectedCount()"
        (click)="board.removeSelected()"
      >
        Delete ({{ board.selectedCount() }})
      </button>
      <button
        [disabled]="!board.selectedCount()"
        (click)="board.clearSelection()"
      >
        Clear selection
      </button>
    </div>

    <div class="viewport" #vp>
      <mm-canvas-board #board [scrollEl]="vp"></mm-canvas-board>
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: 1.5rem;
      font-family: system-ui, sans-serif;
    }
    h2 {
      margin: 0 0 0.25rem;
    }
    .hint {
      color: #64748b;
      margin: 0 0 1rem;
      max-width: 80ch;
      line-height: 1.5;
    }
    kbd {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 3px;
      padding: 0 0.3rem;
      font-size: 0.8em;
    }
    .toolbar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    button {
      padding: 0.4rem 0.8rem;
      border: 1px solid #cbd5e1;
      background: white;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .viewport {
      width: 100%;
      height: 70vh;
      overflow: auto;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #f1f5f9;
    }
  `,
})
export class CanvasExample {}
