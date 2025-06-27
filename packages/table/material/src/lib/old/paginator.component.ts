// import { ChangeDetectionStrategy, Component, input } from '@angular/core';
// import { MatIconButton } from '@angular/material/button';
// import { MatIcon } from '@angular/material/icon';
// import { SelectFieldComponent } from '@mmstack/form-material';
// import { PaginationFeature } from '@mmstack/table-core';

// @Component({
//   selector: 'mm-paginator',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [SelectFieldComponent, MatIcon, MatIconButton],
//   template: `
//     <div class="outer-container">
//       <div class="container">
//         <div class="page-size">
//           <div class="label">{{ state().perPage() }}</div>
//           <mm-select-field
//             appearance="outline"
//             subscriptSizing="dynamic"
//             [state]="state().pageSize"
//           />
//         </div>
//         <div class="range-actions">
//           <div aria-live="polite" class="range-label">
//             {{ state().fromTo() }}
//           </div>
//           @if (state().showFirstLast()) {
//             <button
//               type="button"
//               class="first-page-btn"
//               mat-icon-button
//               (click)="state().first()"
//               [disabled]="!state().canPrevious()"
//             >
//               <mat-icon>first_page</mat-icon>
//             </button>
//           }
//           <button
//             type="button"
//             class="previous-page-btn"
//             mat-icon-button
//             (click)="state().previous()"
//             [disabled]="!state().canPrevious()"
//           >
//             <mat-icon>chevron_left</mat-icon>
//           </button>
//           <button
//             type="button"
//             class="next-page-btn"
//             mat-icon-button
//             (click)="state().next()"
//             [disabled]="!state().canNext()"
//           >
//             <mat-icon>chevron_right</mat-icon>
//           </button>
//           @if (state().showFirstLast()) {
//             <button
//               type="button"
//               class="last-page-btn"
//               mat-icon-button
//               (click)="state().last()"
//               [disabled]="!state().canNext()"
//             >
//               <mat-icon>last_page</mat-icon>
//             </button>
//           }
//         </div>
//       </div>
//     </div>
//   `,
//   styles: `
//     :host {
//       display: block;
//       -moz-osx-font-smoothing: grayscale;
//       -webkit-font-smoothing: antialiased;
//       color: var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));
//       background: var(--mat-sys-surface, #fdfbff);
//       font-family: var(--mat-sys-body-small-font, Roboto, sans-serif);
//       line-height: var(--mat-sys-body-small-line-height, 1rem);
//       font-size: var(--mat-sys-body-small-size, 0.75rem);
//       font-weight: var(--mat-sys-body-small-weight, 400);
//       letter-spacing: var(--mat-sys-body-small-tracking, 0.025rem);
//       --mat-form-field-container-height: var(
//         --mat-paginator-form-field-container-height,
//         40px
//       );
//       --mat-form-field-container-vertical-padding: var(
//         --mat-paginator-form-field-container-vertical-padding,
//         8px
//       );

//       --mat-select-disabled-trigger-text-color: var(
//         --mat-select-enabled-trigger-text-color,
//         #1a1b1f
//       );

//       div.outer-container {
//         display: flex;

//         align-items: center;
//         justify-content: flex-end;

//         div.container {
//           display: flex;
//           gap: 16px;
//           align-items: center;
//           justify-content: flex-end;
//           padding-left: var(--mm-paginator-padding-left, 8px);
//           padding-right: var(--mm-paginator-padding-right, 0);
//           padding-top: var(--mm-paginator-padding-top, 16px);
//           padding-bottom: var(--mm-paginator-padding-bottom, 0);
//           flex-wrap: nowrap;
//           width: 100%;
//           min-height: var(--mat-paginator-container-size, 56px);

//           div.page-size {
//             display: flex;
//             align-items: baseline;

//             div.label {
//               margin: 0 4px;
//               white-space: nowrap;
//             }

//             ::ng-deep mat-form-field {
//               margin: 0 4px;
//               width: 84px;

//               mat-select-trigger {
//                 font-size: var(
//                   --mat-sys-body-small-size,
//                   0.75rem
//                 );
//               }
//             }
//           }
//         }

//         div.range-actions {
//           display: flex;
//           align-items: center;
//           flex-wrap: nowrap;

//           div.range-label {
//             margin: 0 16px 0 8px;
//             white-space: nowrap;
//           }
//         }
//       }
//     }
//   `,
// })
// export class PaginatorComponent {
//   readonly state = input.required<PaginationFeature>();
// }
