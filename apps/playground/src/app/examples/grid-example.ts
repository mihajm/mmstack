import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import {
  gridLayout,
  movable,
  type GridItem,
  type GridLayoutRef,
  type MovableRef,
  type Point,
} from '../canvas';

const GAP = 8;

const CELL = 84;
const COLS = 6;
const COLORS = ['#bfdbfe', '#bbf7d0', '#fde68a', '#fbcfe8', '#ddd6fe', '#fed7aa'];

type Cell = GridItem & { color: string; label: string };

@Component({
  selector: 'mm-grid-cell',
  template: `{{ cell().label }}`,
  host: {
    '[style.transform]': 'transform()',
    '[style.width.px]': 'cell().w * unit() - GAP',
    '[style.height.px]': 'cell().h * unit() - GAP',
    '[style.background]': 'cell().color',
    '[class.dragging]': 'moving()',
    tabindex: '0',
    role: 'button',
    '[attr.aria-label]': 'cell().label',
  },
  styles: `
    :host {
      position: absolute; top: 0; left: 0; border-radius: 8px;
      border: 1px solid rgba(0,0,0,.12); box-shadow: 0 1px 3px rgba(0,0,0,.12);
      display: flex; align-items: center; justify-content: center;
      font: 600 13px system-ui, sans-serif; color: #1e293b; cursor: grab;
      user-select: none; touch-action: none; transition: transform .13s ease;
    }
    :host.dragging { transition: none; cursor: grabbing; z-index: 10; box-shadow: 0 8px 20px rgba(0,0,0,.22); }
    :host:focus-visible { outline: 2px solid #2563eb; }
  `,
})
export class GridCell {
  readonly cell = input.required<Cell>();
  readonly grid = input.required<GridLayoutRef>();
  readonly unit = input.required<number>();

  protected readonly GAP = GAP;

  private readonly injector = inject(Injector);
  private readonly _ref = signal<MovableRef | undefined>(undefined);

  protected readonly moving = computed(() => this._ref()?.moving() ?? false);

  private readonly cellPx = computed<Point>(() => ({
    x: this.cell().x * this.unit() + GAP / 2,
    y: this.cell().y * this.unit() + GAP / 2,
  }));

  // movable writes this while dragging; idle cells render from `cellPx`.
  protected readonly pos = signal<Point>({ x: 0, y: 0 });

  protected readonly transform = computed(() => {
    const p = this.moving() ? this.pos() : this.cellPx();
    return `translate(${p.x}px, ${p.y}px)`;
  });

  constructor() {
    // Effect-free: `movable` owns the gesture, `from` seeds the start from the
    // rendered cell, and `onMove` (a callback) reflows the grid. No user effect.
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          movable(this.pos, {
            activationThreshold: 4,
            from: () => untracked(this.cellPx),
            onMove: ({ position }) => {
              const unit = untracked(this.unit);
              untracked(this.grid).move(
                untracked(this.cell).id,
                Math.round((position.x - GAP / 2) / unit),
                Math.round((position.y - GAP / 2) / unit),
              );
            },
          }),
        ),
      );
    });
  }
}

@Component({
  selector: 'mm-grid-example',
  imports: [GridCell],
  template: `
    <h2>Grid — collision reflow (Retool-style)</h2>
    <p class="hint">
      Drag a tile onto others and they <strong>push down &amp; reflow</strong>,
      compacting back up when there's room. Pure layout engine
      (<code>gridLayout</code> / <code>moveGridItem</code>) driven by pointer
      events.
    </p>

    <div class="toolbar">
      <button (click)="add()">+ Add tile</button>
    </div>

    <div
      class="grid"
      [style.width.px]="cols * CELL"
      [style.height.px]="(grid.rows() + 1) * CELL"
    >
      @for (c of cells(); track c.id) {
        <mm-grid-cell [cell]="c" [grid]="grid" [unit]="CELL" />
      }
    </div>
  `,
  styles: `
    :host { display: block; padding: 1.5rem; font-family: system-ui, sans-serif; }
    h2 { margin: 0 0 .25rem; }
    .hint { color: #64748b; margin: 0 0 1rem; max-width: 70ch; }
    code { background: #f1f5f9; padding: 0 .3rem; border-radius: 3px; }
    .toolbar { margin-bottom: .75rem; }
    button { padding: .4rem .8rem; border: 1px solid #cbd5e1; background: white; border-radius: 6px; cursor: pointer; font: inherit; }
    .grid {
      position: relative; transition: height .13s ease;
      background-color: #fafafa;
      background-image:
        linear-gradient(#eef2f7 1px, transparent 1px),
        linear-gradient(90deg, #eef2f7 1px, transparent 1px);
      background-size: ${CELL}px ${CELL}px;
      border: 1px solid #e2e8f0; border-radius: 10px;
    }
  `,
})
export class GridExample {
  protected readonly CELL = CELL;
  protected readonly cols = COLS;

  private readonly items = signal<Cell[]>([
    { id: 1, x: 0, y: 0, w: 2, h: 1, color: COLORS[0], label: 'Chart' },
    { id: 2, x: 2, y: 0, w: 2, h: 2, color: COLORS[1], label: 'Table' },
    { id: 3, x: 0, y: 1, w: 2, h: 1, color: COLORS[2], label: 'Stat' },
    { id: 4, x: 4, y: 0, w: 2, h: 1, color: COLORS[3], label: 'Filter' },
  ]);

  protected readonly grid = gridLayout(this.items, { cols: COLS });
  protected readonly cells = this.items.asReadonly();
  private nextId = 5;

  protected add(): void {
    const n = this.nextId++;
    this.grid.add({
      id: n,
      x: 0,
      y: 999,
      w: 2,
      h: 1,
      color: COLORS[n % COLORS.length],
      label: 'Tile ' + n,
    });
  }
}
