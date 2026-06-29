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
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { gridLayout, type GridItem, type GridLayoutRef } from './grid-layout';
import { movable, type MovableRef } from './movable';
import type { Point } from './geometry';

function pe(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

@Component({
  selector: 'mm-gint-cell',
  template: '',
  host: { '[style.transform]': 'transform()' },
})
class GIntCell {
  readonly cell = input.required<GridItem>();
  readonly grid = input.required<GridLayoutRef>();

  private readonly injector = inject(Injector);
  private readonly _ref = signal<MovableRef | undefined>(undefined);
  readonly moving = computed(() => this._ref()?.moving() ?? false);
  private readonly cellPx = computed<Point>(() => ({
    x: this.cell().x * 10,
    y: this.cell().y * 10,
  }));
  readonly pos = signal<Point>({ x: 0, y: 0 });
  protected readonly transform = computed(() => {
    const p = this.moving() ? this.pos() : this.cellPx();
    return `translate(${p.x}px, ${p.y}px)`;
  });

  constructor() {
    afterNextRender(() => {
      this._ref.set(
        runInInjectionContext(this.injector, () =>
          movable(this.pos, {
            activationThreshold: 3,
            from: () => untracked(this.cellPx),
            onMove: ({ position }) =>
              untracked(this.grid).move(
                untracked(this.cell).id,
                Math.round(position.x / 10),
                Math.round(position.y / 10),
              ),
          }),
        ),
      );
    });
  }
}

@Component({
  selector: 'mm-gint-host',
  imports: [GIntCell],
  template: `
    @for (c of items(); track c.id) {
      <mm-gint-cell [cell]="c" [grid]="grid" />
    }
  `,
})
class GIntHost {
  readonly items = signal<GridItem[]>([
    { id: 1, x: 0, y: 0, w: 1, h: 1 },
    { id: 2, x: 0, y: 1, w: 1, h: 1 },
    { id: 3, x: 0, y: 2, w: 1, h: 1 },
  ]);
  readonly grid = gridLayout(this.items, { cols: 4 });
}

describe('grid reflow integration (drag through @for + movable + grid.move)', () => {
  it('does not infinite-loop on drag', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(GIntHost);
    fixture.detectChanges();
    await fixture.whenStable();

    const cellEl = fixture.debugElement.queryAll(By.directive(GIntCell))[0]
      .nativeElement as HTMLElement;

    // drag the first cell down across the others (reflows the grid each move)
    cellEl.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    for (let y = 5; y <= 40; y += 5) {
      cellEl.dispatchEvent(pe('pointermove', 0, y));
      TestBed.tick();
      fixture.detectChanges();
    }
    cellEl.dispatchEvent(pe('pointerup', 0, 40));
    TestBed.tick();

    // reaching here means no infinite loop; the dragged item reflowed downward
    expect(fixture.componentInstance.items().length).toBe(3);
  });
});
