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
  MatAutocomplete,
  MatAutocompleteTrigger,
  MatOption,
} from '@angular/material/autocomplete';
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
import { MatInput } from '@angular/material/input';
import { MatTooltip } from '@angular/material/tooltip';
import { AutocompleteState, SignalErrorValidator } from './adapters';

@Component({
  selector: 'mm-autocomplete-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MatFormField,
    MatLabel,
    MatHint,
    MatPrefix,
    MatSuffix,
    MatError,
    MatInput,
    MatTooltip,
    MatAutocomplete,
    MatAutocompleteTrigger,
    MatOption,
    SignalErrorValidator,
  ],
  host: {
    class: 'mm-autocomplete-field',
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

      <input
        matInput
        [(ngModel)]="state().value"
        [autocomplete]="state().autocomplete()"
        [disabled]="state().disabled()"
        [readonly]="state().readonly()"
        [required]="state().required()"
        [placeholder]="state().placeholder()"
        [mmSignalError]="state().error()"
        [matAutocomplete]="auto"
        (blur)="state().markAsTouched()"
      />

      <mat-autocomplete #auto [panelWidth]="panelWidth()">
        @for (opt of state().options(); track opt.value) {
          <mat-option [value]="opt.value">{{ opt.label() }}</mat-option>
        }
      </mat-autocomplete>

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
  `,
  styles: `
    .mm-autocomplete-field {
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
export class AutocompleteField<TParent = undefined> {
  readonly state = input.required<AutocompleteState<TParent>>();

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

  private readonly model = viewChild.required(NgModel);

  protected readonly panelWidth = computed(
    () => this.state().panelWidth?.() ?? 'auto',
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
