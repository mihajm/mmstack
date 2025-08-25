import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  effect,
  inject,
  input,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import {
  FloatLabelType,
  MAT_FORM_FIELD_DEFAULT_OPTIONS,
  MatError,
  MatFormField,
  MatFormFieldAppearance,
  MatHint,
  MatLabel,
  MatPrefix,
  MatSuffix,
  SubscriptSizing,
} from '@angular/material/form-field';
import {
  MatOption,
  MatSelect,
  MatSelectTrigger,
} from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';
import { MultiSelectState, SignalErrorValidator } from './adapters';
import { SelectOptionContent } from './select-field';

@Component({
  selector: 'mm-multi-select-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MatFormField,
    MatLabel,
    MatHint,
    MatError,
    MatPrefix,
    MatSuffix,
    MatSelect,
    MatOption,
    MatSelectTrigger,
    MatTooltip,
    SignalErrorValidator,
    NgTemplateOutlet,
  ],
  host: {
    class: 'mm-multi-select-field',
  },
  template: `
    <mat-form-field
      [appearance]="appearance()"
      [floatLabel]="floatLabel()"
      [subscriptSizing]="subscriptSizing()"
      [hideRequiredMarker]="hideRequiredMarker()"
    >
      <mat-label>{{ state().label() }}</mat-label>

      @if (prefix()) {
        <ng-container matPrefix>
          <ng-content select="[matPrefix]" />
        </ng-container>
      }

      <mat-select
        multiple
        [class.readonly]="state().readonly()"
        [(ngModel)]="state().value"
        [required]="state().required()"
        [mmSignalError]="state().error()"
        [panelWidth]="panelWidth()"
        [disabled]="state().disabled()"
        [compareWith]="state().equal"
        [placeholder]="state().placeholder()"
        [disableOptionCentering]="disableOptionCentering()"
        [hideSingleSelectionIndicator]="hideSingleSelectionIndicator()"
        (blur)="state().markAsTouched()"
        (closed)="state().markAsTouched()"
      >
        <mat-select-trigger>{{ state().valueLabel() }}</mat-select-trigger>

        @for (opt of state().options(); track opt.id) {
          <mat-option [value]="opt.value" [disabled]="opt.disabled()">
            <ng-container
              [ngTemplateOutlet]="optionTemplate()?.template ?? fallback"
              [ngTemplateOutletContext]="{ $implicit: opt }"
            />
          </mat-option>
        }
      </mat-select>

      <mat-error
        [matTooltip]="state().errorTooltip()"
        matTooltipPositionAtOrigin
        matTooltipClass="mm-multiline-tooltip"
        >{{ state().error() }}</mat-error
      >

      @if (state().hint()) {
        <mat-hint
          [matTooltip]="state().hintTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          >{{ state().hint() }}</mat-hint
        >
      }

      @if (suffix()) {
        <ng-container matSuffix>
          <ng-content select="[matSuffix]" />
        </ng-container>
      }
    </mat-form-field>

    <ng-template #fallback let-opt>{{ opt.label() }}</ng-template>
  `,
  styles: `
    .mm-multi-select-field {
      display: contents;

      mat-form-field {
        width: 100%;

        .mat-mdc-notch-piece.mdc-notched-outline__notch:has(mat-label:empty) {
          display: none;
        }
      }
    }
  `,
})
export class MultiSelectFieldComponent<T extends any[], TParent = undefined> {
  readonly state = input.required<MultiSelectState<T, TParent>>();

  readonly appearance = input<MatFormFieldAppearance>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })?.appearance ??
      'fill',
  );
  readonly floatLabel = input<FloatLabelType>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })?.floatLabel ??
      'auto',
  );
  readonly subscriptSizing = input<SubscriptSizing>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })
      ?.subscriptSizing ?? 'fixed',
  );
  readonly hideRequiredMarker = input<boolean>(
    inject(MAT_FORM_FIELD_DEFAULT_OPTIONS, { optional: true })
      ?.hideRequiredMarker ?? false,
  );

  protected readonly optionTemplate = contentChild(SelectOptionContent);

  private readonly model = viewChild.required(NgModel);

  protected readonly panelWidth = computed(
    () => this.state().panelWidth?.() ?? 'auto',
  );

  protected readonly disableOptionCentering = computed(
    () => this.state().disableOptionCentering?.() ?? false,
  );

  protected readonly hideSingleSelectionIndicator = computed(
    () => this.state().hideSingleSelectionIndicator?.() ?? false,
  );

  protected readonly prefix = contentChild(MatPrefix);

  protected readonly suffix = contentChild(MatSuffix);

  constructor() {
    effect(() => {
      if (this.state().touched()) this.model().control.markAsTouched();
      else this.model().control.markAsUntouched();
    });
  }
}
