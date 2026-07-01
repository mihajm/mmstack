import { Component, Directive, input, output, signal } from '@angular/core';
import { draggable, dropTarget } from '@mmstack/dnd';

type Chip = { id: number; label: string };

const isChip = (d: unknown): d is Chip =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

/**
 * Demo-local directive: the lib `Draggable` directive doesn't take an `engine`
 * input yet (deferred reactive-input case), but a STATIC `engine:'pointer'` in a
 * composable call resolves fine at creation.
 */
@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: '[appDrag]',
  host: {
    '[class.dragging]': 'dnd.dragging()',
    '[style.touch-action]': "'none'",
    '[style.user-select]': "'none'",
  },
})
export class PointerDrag {
  readonly chip = input.required<Chip>();
  protected readonly dnd = draggable<Chip>({
    data: this.chip,
    engine: 'pointer',
  });
}

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: '[appDropZone]',
  host: { '[class.over]': 'zone.isDragOver()' },
})
export class PointerDropZone {
  readonly dropped = output<Chip>();
  protected readonly zone = dropTarget<Chip>({
    accepts: isChip,
    engine: 'pointer',
    onDrop: (e) => this.dropped.emit(e.data),
  });
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-pointer-engine-example',
  imports: [PointerDrag, PointerDropZone],
  template: `
    <main>
      <h1>Pointer engine — draggable / dropTarget</h1>
      <p class="hint">
        Drag a chip into the other bucket. Same primitives as native DnD, but
        <code>engine: 'pointer'</code> — driven by the pointer engine + unified
        session.
      </p>
      <div class="board">
        @for (bucket of buckets(); track bucket.id) {
          <div
            class="zone"
            appDropZone
            [attr.data-zone]="bucket.id"
            (dropped)="move($event, bucket.id)"
          >
            <h3>Bucket {{ bucket.id }}</h3>
            @for (chip of bucket.chips; track chip.id) {
              <div class="chip" appDrag [chip]="chip">{{ chip.label }}</div>
            }
          </div>
        }
      </div>
    </main>
  `,
  styles: `
    main {
      max-width: 32rem;
      margin: 2rem auto;
      font:
        14px/1.4 system-ui,
        sans-serif;
    }
    .hint {
      color: #6b7280;
    }
    .board {
      display: flex;
      gap: 16px;
      align-items: start;
    }
    .zone {
      flex: 1;
      min-height: 140px;
      padding: 10px;
      border-radius: 10px;
      background: #f9fafb;
      border: 2px solid transparent;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .zone.over {
      border-color: #6366f1;
      background: #eef2ff;
    }
    .chip {
      padding: 10px 14px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      cursor: grab;
    }
    .chip.dragging {
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: #c7d2fe;
      opacity: 0.95;
    }
  `,
})
export class PointerEngineExample {
  protected readonly buckets = signal<{ id: string; chips: Chip[] }[]>([
    {
      id: 'a',
      chips: [
        { id: 1, label: 'One' },
        { id: 2, label: 'Two' },
      ],
    },
    { id: 'b', chips: [{ id: 3, label: 'Three' }] },
  ]);

  protected move(chip: Chip, to: string): void {
    this.buckets.update((bs) =>
      bs.map((b) => ({
        ...b,
        chips:
          b.id === to
            ? b.chips.some((c) => c.id === chip.id)
              ? b.chips
              : [...b.chips, chip]
            : b.chips.filter((c) => c.id !== chip.id),
      })),
    );
  }
}
