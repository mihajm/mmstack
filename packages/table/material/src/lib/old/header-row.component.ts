// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { HeaderRow, TableFeatures } from '@mmstack/table-core';
// import { HeaderCellComponent } from './header-cell.component';
// import { MatPseudoCheckbox } from '@angular/material/core';

// @Component({
//   selector: 'mm-header-row',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [HeaderCellComponent, MatPseudoCheckbox],
//   template: `
//     <div class="left-header-actions">
//       @if (!features().rowSelect.disabled()) {
//         <mat-pseudo-checkbox
//           [state]="features().rowSelect.state()[state().id] ? 'checked' : 'unchecked'"
//           (click)="$event.stopPropagation()"
//           (mousedown)="features().rowSelect.toggle(state().id)"
//         />
//       }
//     </div>
//     @for (cell of state().visibleCells(); track cell.name) {
//       <mm-header-cell [state]="cell" />
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
//       font-weight: var(--mat-sys-body-medium-weight, 500);
//       height: var(--mat-table-row-item-container-height, 52px);
//       min-height: var(--mat-table-row-item-container-height, 56px);
//       color: var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));
//       border-bottom-color: var(
//         --mat-sys-on-surface,
//         rgba(0, 0, 0, 0.12)
//       );
//       border-bottom-width: var(--mat-table-row-item-outline-width, 1px);
//       border-bottom-style: solid;

//       .left-header-actions {
//         padding: 15px;
//         display: flex;
//         align-items: center;
//         border-right-color: var(--mat-sys-on-surface, rgba(0, 0, 0, 0.12));
//         border-right-width: 1px;
//         border-right-style: solid;
//       }
//     }
//   `,
// })
// export class HeaderRowComponent<T, TColumnName extends string> {
//   readonly state = input.required<HeaderRow<TColumnName>>();
//   readonly features = input.required<TableFeatures<T, TColumnName>>();
// }
