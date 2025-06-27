// import {
//   ChangeDetectionStrategy,
//   Component,
//   computed,
//   input,
// } from '@angular/core';
// import { HeaderCell } from '@mmstack/table-core';
// import { MatIconButton } from '@angular/material/button';
// import { MatIcon } from '@angular/material/icon';
// import { MatFormField, MatInput, MatLabel } from '@angular/material/input';
// import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';

// @Component({
//   selector: 'mm-header-cell',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [
//     MatIconButton,
//     MatIcon,
//     MatFormField,
//     MatInput,
//     MatLabel,
//     MatMenuTrigger,
//     MatMenu,
//     MatMenuItem,
//   ],
//   template: `
//     <mat-form-field appearance="outline" subscriptSizing="dynamic">
//       <mat-label>{{ state().value() }}</mat-label>
//       <input matInput />
//     </mat-form-field>
//     <button type="button" mat-icon-button [matMenuTriggerFor]="actionMenu" class="header-actions">
//       <mat-icon>more_vert</mat-icon>
//     </button>

//     <mat-menu #actionMenu="matMenu">
//       <button mat-menu-item type="button" (click)="state().features.hide()">
//         <mat-icon>visibility_off</mat-icon>
//         <span>Hide</span>
//       </button>
//       <button type="button" mat-menu-item [matMenuTriggerFor]="sortMenu">
//         <mat-icon>sort</mat-icon>
//         <span>Sorting</span>
//       </button>
//       <button type="button" mat-menu-item [matMenuTriggerFor]="orderMenu">
//         <mat-icon>compare_arrows</mat-icon>
//         <span>Order</span>
//       </button>
//     </mat-menu>

//     <mat-menu #orderMenu="matMenu">
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.columnOrder.left()"
//         [disabled]="state().features.columnOrder.left.disabled()"
//       >
//         <mat-icon>chevron_left</mat-icon>
//         <span>Move left</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.columnOrder.right()"
//         [disabled]="state().features.columnOrder.right.disabled()"
//       >
//         <mat-icon>chevron_right</mat-icon>
//         <span>Move right</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.columnOrder.first()"
//         [disabled]="state().features.columnOrder.first.disabled()"
//       >
//         <mat-icon>keyboard_double_arrow_left</mat-icon>
//         <span>First</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.columnOrder.last()"
//         [disabled]="state().features.columnOrder.last.disabled()"
//       >
//         <mat-icon>keyboard_double_arrow_right</mat-icon>
//         <span>Last</span>
//       </button>
//     </mat-menu>

//     <mat-menu #sortMenu="matMenu">
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.sort.toggleSort(); $event.stopPropagation()"
//         [class.asc-sort]="state().features.sort.direction() === 'asc'"
//       >
//         <mat-icon>{{ sortIcon() }}</mat-icon>
//         <span>Sort toggle</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.sort.sort('asc')"
//         class="asc-sort"
//         [disabled]="state().features.sort.direction() === 'asc'"
//       >
//         <mat-icon>sort</mat-icon>
//         <span>Sort by direction ascending</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.sort.sort('desc')"
//         [disabled]="state().features.sort.direction() === 'desc'"
//       >
//         <mat-icon>sort</mat-icon>
//         <span>Sort by direction descending</span>
//       </button>
//       <button
//         type="button"
//         mat-menu-item
//         (click)="state().features.sort.clear()"
//         [disabled]="!state().features.sort.direction()"
//       >
//         <mat-icon>format_line_spacing</mat-icon>
//         <span>Clear sort</span>
//       </button>
//     </mat-menu>
//   `,
//   styles: `
//     :host {
//       background: inherit;
//       letter-spacing: var(--mat-sys-title-small-tracking, 0.01625em);
//       line-height: inherit;
//       box-sizing: border-box;
//       text-align: left;
//       position: relative;
//       display: flex;
//       align-items: center;
//       justify-content: space-between;
//       flex: 1;
//       min-width: 200px;

//       mat-form-field {
//         width: 100%;
//       }
//     }

//     .asc-sort mat-icon {
//       transform: rotate(180deg) scale(-1, 1);
//     }
//   `,
// })
// export class HeaderCellComponent<TColumnName extends string> {
//   readonly state = input.required<HeaderCell<TColumnName>>();

//   protected readonly sortIcon = computed(() => {
//     switch (this.state().features.sort.direction()) {
//       case 'asc':
//         return 'sort';
//       case 'desc':
//         return 'sort';
//       default:
//         return 'format_line_spacing';
//     }
//   });
// }
