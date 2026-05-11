import { Component, computed, inject, input, signal } from '@angular/core';
import { Draggable, DropTarget } from '@mmstack/dnd';
import { indexArray } from '@mmstack/primitives';

type ChessPiece = {
  type: 'pawn' | 'king';
  color: 'white' | 'black';
  location: [number, number];
};

@Component({
  selector: 'mm-piece',
  template: `{{ symbol() }}`,
  host: {
    '[class.dark]': 'color() === "black"',
    '[class.dragging]': 'dir.dragging()',
  },
  hostDirectives: [Draggable],
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
  protected readonly dir = inject(Draggable, {
    self: true,
  });
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
export class Square {
  readonly position = input.required<[number, number]>();

  protected readonly isDark = computed(
    () => (this.position()[0] + this.position()[1]) % 2 === 1,
  );
}

@Component({
  selector: 'mm-board',
  imports: [Square, Piece, DropTarget],
  template: `
    @for (row of board(); track $index) {
      @for (square of row(); track $index) {
        <mm-square
          [position]="square.square()"
          mmDropTarget
          #dir="mmDropTarget"
          [dropDisabled]="!!square.piece()"
          [class.dragOver]="dir.isDragOver()"
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

      mm-square.dragOver {
        background: skyblue !important;
      }
    }
  `,
})
export class Board {
  protected readonly rows = computed(() =>
    Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 8 }, (_, col): [number, number] => [row, col]),
    ),
  );

  protected readonly state = signal<ChessPiece[]>([
    {
      type: 'king',
      color: 'white',
      location: [0, 4],
    },
  ]);

  protected readonly board = indexArray(this.rows, (row) =>
    indexArray(row, (square) => {
      return {
        square,
        piece: computed(() =>
          this.state().find((p) => {
            const [r, c] = p.location;
            const [sr, sc] = square();
            return r === sr && c === sc;
          }),
        ),
      };
    }),
  );
}
