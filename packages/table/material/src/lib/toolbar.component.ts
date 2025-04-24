import { DragDropModule } from '@angular/cdk/drag-drop';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconButton } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import {
  MatMenu,
  MatMenuContent,
  MatMenuItem,
  MatMenuTrigger,
} from '@angular/material/menu';
import { HeaderRow, TableFeatures } from '@mmstack/table-core';

@Component({
  selector: 'mm-column-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    MatMenu,
    MatMenuTrigger,
    MatIconButton,
    MatIcon,
    MatMenuItem,
    MatFormFieldModule,
    MatInput,
    FormsModule,
    MatMenuContent,
    DragDropModule,
  ],
  template: `
    <button type="button" mat-icon-button [matMenuTriggerFor]="menu">
      <mat-icon>view_column</mat-icon>
    </button>
    <mat-menu #menu xPosition="before" class="mm-table-column-menu">
      <ng-template matMenuContent>
        <div class="mm-column-menu-list-container" cdkScrollable>
          <div cdkDropList>
            <mat-form-field
              appearance="fill"
              (click)="$event.stopPropagation()"
            >
              <mat-icon matPrefix>search</mat-icon>
              <mat-label>Search</mat-label>
              <input
                matInput
                [(ngModel)]="filter"
                (keydown)="$event.stopPropagation()"
                (click)="$event.stopPropagation()"
              />
            </mat-form-field>
            @for (column of filteredColumns(); track column.name) {
              <button
                class="mm-table-column-menu-item column"
                type="button"
                cdkDrag
                cdkDragPreviewClass="mm-table-column-drag-preview"
                reverse
                mat-menu-item
                (click)="$event.stopPropagation()"
                (cdkDragDropped)="
                  droppedColumn(column.name, $event.currentIndex)
                "
                disableRipple
              >
                <mat-icon
                  class="mm-table-column-menu-item-drag-handle"
                  cdkDragHandle
                  matMenuItemIcon
                  >drag_handle
                </mat-icon>
                <button
                  type="button"
                  mat-icon-button
                  matMenuItemIcon
                  (click)="
                    $event.stopPropagation();
                    features().columnVisibility.toggle(column.name)
                  "
                >
                  <mat-icon
                    >{{ column.isVisible() ? 'visibility' : 'visibility_off' }}
                  </mat-icon>
                </button>
                {{ column.label() }}
              </button>
            }
          </div>
        </div>
      </ng-template>
    </mat-menu>
  `,
  styles: `
    button[mat-menu-item][reverse]:has(*[matMenuItemIcon]) {
      flex-direction: row-reverse;

      .mat-mdc-menu-item-text {
        padding-left: 0.5rem;
      }
    }

    .mm-table-column-menu div.mat-mdc-menu-content {
      padding-top: 0 !important;
    }

    .mm-column-menu-list-container {
      overflow: auto;
      max-height: 28rem;

      .mat-mdc-menu-item:not([disabled]):hover {
        background-color: unset;
      }
    }

    .mm-table-column-menu-item {
      cursor: auto;

      &:hover {
        background-color: unset !important;
      }
    }

    .mm-table-column-menu-item-drag-handle {
      cursor: grab;
      --mat-menu-item-spacing: 0;
    }

    .mm-table-column-drag-preview {
      box-sizing: border-box;
      border-radius: 4px;
      box-shadow:
        0 5px 5px -3px rgba(0, 0, 0, 0.2),
        0 8px 10px 1px rgba(0, 0, 0, 0.14),
        0 3px 14px 2px rgba(0, 0, 0, 0.12);
      display: flex;
      position: relative;
      justify-content: flex-start;
      overflow: hidden;
      padding-left: 12px;
      padding-right: 12px;
      min-height: 48px;
      width: 100%;

      .mat-mdc-menu-item-text {
        flex: 1;
        font-family: var(--mat-sys-label-large-font);
        line-height: var(--mat-sys-label-large-line-height);
        font-size: var(--mat-sys-label-large-size);
        letter-spacing: var(--mat-sys-label-large-tracking);
        font-weight: var(--mat-sys-label-large-weight);
      }
    }

    [cdkdragpreviewclass='mm-table-column-drag-preview'].cdk-drag-placeholder {
      opacity: 0;
    }

    div.menuList.cdk-drop-list-dragging .column:not(.cdk-drag-placeholder) {
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
    }
  `,
})
export class ColumnMenuComponent<T, TColumnName extends string> {
  readonly features = input.required<TableFeatures<T, TColumnName>>();
  readonly state = input.required<HeaderRow<TColumnName>[]>();

  protected readonly filter = signal('');

  private readonly columns = computed(() =>
    this.state().flatMap((r) =>
      r.cells().map((c) => {
        const label = computed(() => c.value());
        const lcsLabel = computed(() => label().toLowerCase().trim());

        return {
          name: c.name,
          label: computed(() => c.value()),
          isVisible: computed(
            () => this.features().columnVisibility.state()[c.name] !== false,
          ),
          show: computed(() => {
            const sq = this.searchQuery();
            if (!sq) return true;
            return lcsLabel().includes(sq);
          }),
        };
      }),
    ),
  );

  private readonly searchQuery = computed(() =>
    this.filter().toLowerCase().trim(),
  );

  protected readonly filteredColumns = computed(() =>
    this.columns().filter((c) => c.show()),
  );

  protected droppedColumn(columnName: TColumnName, index: number) {
    this.features().columnOrder.set(columnName, index);
  }
}

@Component({
  selector: 'mm-view-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatMenu, MatMenuTrigger, MatIconButton, MatIcon],
  template: `
    <button type="button" mat-icon-button [matMenuTriggerFor]="menu">
      <mat-icon>save</mat-icon>
    </button>
    <mat-menu #menu> yay</mat-menu>
  `,
})
export class ViewMenuComponent<T, TColumnName extends string> {
  readonly features = input.required<TableFeatures<T, TColumnName>>();
}

@Component({
  selector: 'mm-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconButton,
    MatIcon,
    ColumnMenuComponent,
    ViewMenuComponent,
    MatFormFieldModule,
    FormsModule,
    MatInput,
  ],
  template: `
    <mat-form-field appearance="outline" subscriptSizing="dynamic">
      <mat-label>Search</mat-label>
      <input
        matInput
        [(ngModel)]="features().globalFilter.value"
        (blur)="features().globalFilter.markAsTouched()"
      />
      <mat-icon matSuffix>search</mat-icon>
    </mat-form-field>
    <div class="actions">
      @if (features().globalFilter.value()) {
        <button
          type="button"
          mat-icon-button
          (click)="features().globalFilter.clear()"
        >
          <mat-icon>filter_alt_off</mat-icon>
        </button>
      }
      <mm-column-menu [features]="features()" [state]="state()" />
      <mm-view-menu [features]="features()" />
    </div>
  `,
  styles: `
    :host {
      background: inherit;

      display: grid;
      align-items: center;
      justify-content: space-between;
      grid-template-columns: 40% auto;
      grid-template-rows: 1fr;
      gap: 1rem;

      .actions {
        display: flex;
        align-items: center;
        gap: 0.2rem;
      }
    }
  `,
})
export class ToolbarComponent<T, TColumnName extends string> {
  readonly features = input.required<TableFeatures<T, TColumnName>>();
  readonly state = input.required<HeaderRow<TColumnName>[]>();
}
