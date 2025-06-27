// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { FooterRow, TableFeatures } from '@mmstack/table-core';
// import { FooterCellComponent } from './footer-cell.component';

// @Component({
//   selector: 'mm-footer-row',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [FooterCellComponent],
//   template: `
//     @for (cell of state().visibleCells(); track cell.name) {
//       <mm-footer-cell [state]="cell" />
//     }
//   `,
//   styles: `
//     :host {
//       display: flex;
//       text-decoration: none;
//       background: inherit;
//       font-family: var(
//         --mat-sys-body-medium-font,
//         Roboto,
//         sans-serif
//       );
//       line-height: var(--mat-sys-body-medium-line-height, 1.25rem);
//       font-size: var(--mat-sys-body-medium-size, 14px);
//       height: var(--mat-table-row-item-container-height, 52px);
//       min-height: var(--mat-table-row-item-container-height, 56px);
//       color: var(--mat-table-row-item-label-text-color, rgba(0, 0, 0, 0.87));
//       border-top-color:  var(
//         --mat-sys-on-surface,
//         rgba(0, 0, 0, 0.12)
//       );
//       border-top-width: 2px;
//       border-top-style: solid;
//     }
//   `,
// })
// export class FooterRowComponent<TColumnName extends string> {
//   readonly state = input.required<FooterRow<TColumnName>>();
// }
