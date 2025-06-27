// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { Table } from '@mmstack/table-core';
// import { FooterRowComponent } from './footer-row.component';
// import { HeaderRowComponent } from './header-row.component';
// import { PaginatorComponent } from './paginator.component';
// import { RowComponent } from './row.component';
// import { ToolbarComponent } from './toolbar.component';

// @Component({
//   selector: 'mm-table',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [
//     HeaderRowComponent,
//     RowComponent,
//     FooterRowComponent,
//     PaginatorComponent,
//     ToolbarComponent,
//   ],
//   template: `
//     <header>
//       <mm-toolbar  [features]="state().features" [state]="state().header.rows()"/>
//     </header>
//     <div class="table-container">
//       <div class="table">
//         <div class="thead">
//           @for (row of state().header.rows(); track row.id) {
//             <mm-header-row [features]="state().features" [state]="row" />
//           }
//         </div>
//         <div class="tbody">
//           @for (row of state().body.rows(); track row.id; let odd = $odd; let last = $last) {
//             <mm-row [class.border-bottom]="!last" [class.odd]="odd" [features]="state().features" [state]="row" />
//           }
//         </div>
//         <div class="tfoot">
//           @for (row of state().footer.rows(); track row.id) {
//             <mm-footer-row [state]="row" />
//           }
//         </div>
//       </div>
//     </div>
//     <footer>
//       <mm-paginator [state]="state().features.pagination" />
//     </footer>
//   `,
//   styles: `
//     :host {
//       position: relative;
//       display: grid;
//       grid-template-columns: 1fr;
//       grid-template-rows: auto 1fr auto;
//       width: 100%;
//       height: 100%;
//       overflow: hidden;

//       header {
//         background: var(--mat-table-background-color, var(--mat-sys-surface, #fdfbff));
//         padding: var(--mm-table-header-padding, 8px 0);
//       }

//       div.table-container {
//         flex: 1;
//         display: flex;
//         flex-direction: column;
//         overflow: auto;

//         div.table {
//           display: flex;
//           flex-direction: column;
//           background: var(--mat-table-background-color, var(--mat-sys-surface, #fdfbff));
//           table-layout: auto;
//           white-space: normal;
//           min-width: 100%;
//           border: 0;
//           border-spacing: 0;
//           border-collapse: collapse;
//           width: fit-content;

//           div.tfoot {
//             position: sticky;
//             bottom: 0;
//             z-index: 500;
//             background: inherit;
//           }
//           div.thead {
//             z-index: 500;
//             padding-top: 10px;
//             position: sticky;
//             top: 0;

//             display: flex;
//             flex-direction: column;

//             background: inherit;

//             --mdc-outlined-text-field-label-text-font: var(
//               --mat-table-header-headline-font,
//               Roboto,
//               sans-serif
//             );
//             --mdc-outlined-text-field-label-text-color: var(
//               --mat-table-header-headline-color,
//               rgba(0, 0, 0, 0.87)
//             );
//             --mdc-outlined-text-field-disabled-label-text-color: var(
//               --mat-table-header-headline-color,
//               rgba(0, 0, 0, 0.87)
//             );
//             --mdc-outlined-text-field-disabled-outline-color: transparent;
//             --mdc-outlined-text-field-label-text-weight: var(
//               --mat-table-header-headline-weight,
//               500
//             );
//             --mdc-outlined-text-field-outline-width: 0;
//             --mdc-outlined-text-field-focus-outline-width: 0;
//           }

//           div.tbody {
//             display: contents;

//             background: inherit;
//             -moz-osx-font-smoothing: grayscale;
//             -webkit-font-smoothing: antialiased;
//             font-family: var(
//               --mat-table-row-item-label-text-font,
//               Roboto,
//               sans-serif
//             );
//             font-size: var(--mat-table-row-item-label-text-size, 14px);
//             line-height: var(
//               --mat-table-row-item-label-text-line-height,
//               1.25rem
//             );
//             font-size: var(--mat-table-row-item-label-text-size, 14px);
//             font-weight: var(--mat-table-row-item-label-text-weight, 400);
//           }
//         }
//       }
//     }
//   `,
// })
// export class TableComponent<T, TColumnName extends string = string> {
//   readonly state = input.required<Table<T, TColumnName>>();
// }
