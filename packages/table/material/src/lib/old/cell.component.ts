// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { type Cell } from '@mmstack/table-core';

// @Component({
//   selector: 'mm-cell',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   template: `<span>{{ state().value() }}</span>`,
//   styles: `
//     :host {
//       padding: 0 16px;
//       background: inherit;
//       letter-spacing: var(--mat-table-row-item-label-text-tracking, 0.01625em);
//       line-height: inherit;
//       box-sizing: border-box;
//       text-align: left;
//       position: relative;
//       display: flex;
//       align-items: center;
//       justify-content: flex-start;
//       flex: 1;
//       min-width: 200px;

//       span {
//         text-overflow: ellipsis;
//         white-space: nowrap;
//         overflow: hidden;
//       }
//     }
//   `,
// })
// export class CellComponent<U, TColumnName extends string> {
//   readonly state = input.required<Cell<U, TColumnName>>();
// }
