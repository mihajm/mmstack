import { Component, computed, inject, input, signal } from '@angular/core';
import {
  Draggable,
  DropTarget,
  monitorElements,
  type DropEvent,
} from '@mmstack/dnd';
import { indexArray } from '@mmstack/primitives';

type ChessPiece = {
  id: number;
  type: 'pawn' | 'king';
  color: 'white' | 'black';
  location: [number, number];
};

type Square = { position: [number, number] };

const isChessPiece = (d: unknown): d is ChessPiece =>
  !!d &&
  typeof d === 'object' &&
  'id' in d &&
  'type' in d &&
  'location' in d;

const isSquare = (d: unknown): d is Square =>
  !!d && typeof d === 'object' && 'position' in d;

const sameLoc = (a: [number, number], b: [number, number]) =>
  a[0] === b[0] && a[1] === b[1];

function isValidMove(piece: ChessPiece, target: [number, number]): boolean {
  if (sameLoc(piece.location, target)) return false;

  const [sr, sc] = piece.location;
  const [tr, tc] = target;
  const dr = tr - sr;
  const dc = tc - sc;

  if (piece.type === 'pawn') {
    const dir = piece.color === 'white' ? 1 : -1;
    return dc === 0 && dr === dir;
  }

  // king: any of the 8 adjacent squares
  return Math.abs(dr) <= 1 && Math.abs(dc) <= 1;
}

@Component({
  selector: 'mm-piece',
  template: `{{ symbol() }}`,
  host: {
    '[class.dark]': 'color() === "black"',
    '[class.dragging]': 'dir.dragging()',
  },
  hostDirectives: [{ directive: Draggable, inputs: ['data: state'] }],
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 3rem;
      width: 3rem;
      font-size: 3rem;
      border-radius: 5px;
      color: white;
      background: black;

      &:hover {
        cursor: pointer;
        background: grey;
      }

      &.dragging {
        opacity: 0.5;
      }

      &.dark {
        background: white;
        color: black;

        &:hover {
          background: lightgrey;
        }
      }
    }
  `,
})
export class Piece {
  protected readonly dir = inject(Draggable, { self: true });
  readonly state = input.required<ChessPiece>();

  protected readonly symbol = computed(() =>
    this.state().type === 'pawn' ? '♟' : '♚',
  );

  protected readonly color = computed(() =>
    this.state().color === 'white' ? 'white' : 'black',
  );
}

@Component({
  selector: 'mm-square',
  template: `<ng-content />`,
  host: {
    '[style.background-color]': 'isDark() ? "saddlebrown" : "beige"',
  },
  styles: `
    :host {
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: lightgrey;
    }
  `,
})
export class SquareCell {
  readonly position = input.required<[number, number]>();

  protected readonly isDark = computed(
    () => (this.position()[0] + this.position()[1]) % 2 === 1,
  );
}

@Component({
  selector: 'mm-board',
  imports: [SquareCell, Piece, DropTarget],
  template: `
    @for (row of board(); track $index) {
      @for (square of row(); track $index) {
        <mm-square
          [position]="square.square()"
          mmDropTarget
          #dt="mmDropTarget"
          [accepts]="acceptsPiece"
          [data]="{ position: square.square() }"
          [class.targetable]="square.targetable() && !dt.isDragOver()"
          [class.over-valid]="dt.isDragOver() && square.targetable()"
          [class.over-invalid]="dt.isDragOver() && !square.targetable()"
          (dropped)="onDrop($event)"
        >
          @if (square.piece(); as p) {
            <mm-piece [state]="p" />
          }
        </mm-square>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      grid-template-rows: repeat(8, 1fr);
      width: 500px;
      height: 500px;
      border: 3px solid lightgrey;
    }
    :host mm-square.targetable {
      background-color: #93c5fd !important;
    }
    :host mm-square.over-valid {
      background-color: #2563eb !important;
    }
    :host mm-square.over-invalid {
      background-color: #dc2626 !important;
    }
  `,
})
export class Board {
  protected readonly acceptsPiece = isChessPiece;

  protected readonly rows = computed(() =>
    Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 8 }, (_, col): [number, number] => [row, col]),
    ),
  );

  protected readonly state = signal<ChessPiece[]>([
    { id: 1, type: 'king', color: 'white', location: [0, 4] },
    { id: 2, type: 'pawn', color: 'white', location: [1, 3] },
    { id: 3, type: 'king', color: 'black', location: [7, 4] },
    { id: 4, type: 'pawn', color: 'black', location: [6, 3] },
  ]);

  private readonly monitor = monitorElements<ChessPiece>({
    accepts: isChessPiece,
  });

  protected readonly board = indexArray(this.rows, (row) =>
    indexArray(row, (square) => {
      const piece = computed(() =>
        this.state().find((p) => sameLoc(p.location, square())),
      );
      const targetable = computed(() => {
        const src = this.monitor.source()?.data;
        if (!src) return false;
        const target = square();
        const blockedBy = this.state().find(
          (p) => p.id !== src.id && sameLoc(p.location, target),
        );
        if (blockedBy) return false;
        return isValidMove(src, target);
      });
      return { square, piece, targetable };
    }),
  );

  protected onDrop(event: DropEvent<ChessPiece>) {
    const target = event.location.current[0]?.data;
    if (!isSquare(target)) return;
    const piece = event.data;
    const blockedBy = this.state().find(
      (p) => p.id !== piece.id && sameLoc(p.location, target.position),
    );
    if (blockedBy) return;
    if (!isValidMove(piece, target.position)) return;
    this.state.update((pieces) =>
      pieces.map((p) =>
        p.id === piece.id ? { ...p, location: target.position } : p,
      ),
    );
  }
}
