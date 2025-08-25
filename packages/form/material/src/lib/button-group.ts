import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import {
  MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS,
  MatButtonToggleAppearance,
  MatButtonToggleModule,
} from '@angular/material/button-toggle';
import { MatTooltip } from '@angular/material/tooltip';

import { ButtonGroupState } from './adapters';

@Component({
  selector: 'mm-button-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    class: 'mm-button-group',
  },
  imports: [FormsModule, MatButtonToggleModule, MatTooltip],
  template: `
    <mat-button-toggle-group
      [appearance]="appearance()"
      [disabledInteractive]="disabledInteractive()"
      [hideSingleSelectionIndicator]="hideSingleSelectionIndicator()"
      [disabled]="state().disabled()"
      [vertical]="vertical()"
      [matTooltip]="state().hint()"
      [(ngModel)]="state().value"
      (ngModelChange)="state().markAsTouched()"
      [class.error]="state().error()"
    >
      @for (opt of state().options(); track opt.id) {
        <mat-button-toggle
          [value]="opt.value"
          [checked]="opt.value === state().value()"
          [disabled]="opt.disabled() || state().readonly()"
        >
          {{ opt.label() }}
        </mat-button-toggle>
      }
    </mat-button-toggle-group>
  `,
  styles: `
    .mm-button-group {
      display: contents;
    }
  `,
})
export class ButtonGroup<T, TParent = undefined> {
  readonly appearance = input<MatButtonToggleAppearance>(
    inject(MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS).appearance ?? 'standard',
  );

  readonly disabledInteractive = input(
    inject(MAT_BUTTON_TOGGLE_DEFAULT_OPTIONS).disabledInteractive ?? false,
    { transform: booleanAttribute },
  );

  readonly state = input.required<ButtonGroupState<T, TParent>>();

  private readonly model = viewChild.required(NgModel);

  protected readonly hideSingleSelectionIndicator = computed(
    () => this.state().hideSingleSelectionIndicator?.() ?? false,
  );

  protected readonly vertical = computed(
    () => this.state().vertical?.() ?? false,
  );

  constructor() {
    effect(() => {
      if (this.state().touched()) this.model().control.markAsTouched();
      else this.model().control.markAsUntouched();
    });
  }
}
