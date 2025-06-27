// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { type Row, TableFeatures } from '@mmstack/table-core';
// import { CellComponent } from './cell.component';
// import { MatPseudoCheckbox } from '@angular/material/core';

// @Component({
//   selector: 'mm-row',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [CellComponent, MatPseudoCheckbox],
//   template: `
//     <div class="left-row-actions">
//       @if (!features().rowSelect.disabled()) {
//         <mat-pseudo-checkbox
//           [state]="features().rowSelect.state()[state().id] ? 'checked' : 'unchecked'"
//           (click)="$event.stopPropagation()"
//           (mousedown)="features().rowSelect.toggle(state().id)"
//         />
//       }
//     </div>
//     @for (cell of state().visibleCells(); track cell.name) {
//       <mm-cell [state]="cell" />
//     }
//   `,
//   styles: `
//     :host {
//       display: flex;
//       text-decoration: none;
//       background: inherit;
//       font-family: var(--mat-sys-body-medium-font, Roboto, sans-serif);
//       line-height: var(--mat-sys-body-medium-line-height, 1.25rem);
//       font-size: var(--mat-sys-body-medium-size, 14px);
//       font-weight: var(--mat-sys-body-medium-weight, 400);
//       height: var(--mat-table-row-item-container-height, 52px);
//       min-height: var(--mat-table-row-item-container-height, 56px);
//       color: var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));

//       .left-row-actions {
//         display: flex;
//         align-items: center;
//         padding: 15px;
//         border-right-color: var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));
//         border-right-width: 1px;
//         border-right-style: solid;
//       }

//       &.odd {
//         --mat-table-background-color: var(
//           --mm-table-odd-row-background-color,
//           var(--mat-sys-surface-container, #efedf1)
//         );
//         background-color: var(
//           --mm-table-odd-row-background-color,
//           var(--mat-sys-surface-container, #efedf1)
//         );
//       }

//       &.border-bottom {
//         border-bottom-color: var(
//           --mat-sys-on-surface,
//           rgba(0, 0, 0, 0.12)
//         );
//         border-bottom-width: var(--mat-table-row-item-outline-width, 1px);
//         border-bottom-style: solid;
//       }
//     }
//   `,
// })
// export class RowComponent<T, TColumnName extends string> {
//   readonly state = input.required<Row<T, TColumnName>>();
//   readonly features = input.required<TableFeatures<T, TColumnName>>();
// }
