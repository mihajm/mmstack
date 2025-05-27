import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  viewChildren,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import {
  MatDatepicker,
  MatDatepickerInput,
  MatDatepickerToggle,
} from '@angular/material/datepicker';
import {
  FloatLabelType,
  MAT_FORM_FIELD_DEFAULT_OPTIONS,
  MatError,
  MatFormField,
  MatFormFieldAppearance,
  MatHint,
  MatLabel,
  MatSuffix,
  SubscriptSizing,
} from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import {
  MatTimepicker,
  MatTimepickerInput,
  MatTimepickerToggle,
} from '@angular/material/timepicker';
import { MatTooltip } from '@angular/material/tooltip';
import { DateTimeState, SignalErrorValidator } from './adapters';

@Component({
  selector: 'mm-date-time-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    MatFormField,
    MatLabel,
    MatHint,
    MatError,
    MatInput,
    MatSuffix,
    MatTimepicker,
    MatTimepickerToggle,
    MatTimepickerInput,
    MatDatepicker,
    MatDatepickerToggle,
    MatDatepickerInput,
    MatTooltip,
    SignalErrorValidator,
  ],
  host: {
    class: 'mm-date-time-field',
  },
  template: `
    <mat-form-field
      [appearance]="appearance()"
      [floatLabel]="floatLabel()"
      [subscriptSizing]="subscriptSizing()"
      [hideRequiredMarker]="hideRequiredMarker()"
    >
      <mat-label>{{ state().label() }}</mat-label>

      <input
        matInput
        [(ngModel)]="state().value"
        [disabled]="state().disabled()"
        [readonly]="state().readonly()"
        [required]="state().required()"
        [placeholder]="state().placeholder()"
        [matDatepicker]="datepicker"
        [min]="state().min()"
        [max]="state().max()"
        [mmSignalError]="state().error()"
        (blur)="state().markAsTouched()"
      />

      <mat-datepicker-toggle
        matIconSuffix
        [for]="datepicker"
        [disabled]="state().disabled() || state().readonly()"
      />
      <mat-datepicker #datepicker (closed)="state().markAsTouched()" />

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
    </mat-form-field>
    <mat-form-field
      [appearance]="appearance()"
      [floatLabel]="floatLabel()"
      [subscriptSizing]="subscriptSizing()"
      [hideRequiredMarker]="hideRequiredMarker()"
    >
      <mat-label>{{ state().timeControl.label() }}</mat-label>

      <input
        matInput
        [(ngModel)]="state().value"
        [disabled]="state().disabled()"
        [readonly]="state().readonly()"
        [required]="state().required()"
        [placeholder]="state().timeControl.placeholder()"
        [matTimepicker]="timepicker"
        [min]="state().min()"
        [max]="state().max()"
        [mmSignalError]="state().error()"
        (blur)="state().markAsTouched()"
      />

      <mat-timepicker-toggle
        matIconSuffix
        [for]="timepicker"
        [disabled]="state().disabled() || state().readonly()"
      />
      <mat-timepicker
        #timepicker
        [interval]="interval()"
        [options]="options()"
        (closed)="state().markAsTouched()"
      />

      <mat-error
        [matTooltip]="state().timeControl.errorTooltip()"
        matTooltipPositionAtOrigin
        matTooltipClass="mm-multiline-tooltip"
        >{{ state().timeControl.error() }}</mat-error
      >

      @if (state().timeControl.hint()) {
        <mat-hint
          [matTooltip]="state().timeControl.hintTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          >{{ state().timeControl.hint() }}</mat-hint
        >
      }
    </mat-form-field>
  `,
  styles: `
    .mm-date-time-field {
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
export class DateTimeFieldComponent<TParent = undefined, TDate = Date> {
  readonly state = input.required<DateTimeState<TParent, TDate>>();

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

  private readonly models = viewChildren(NgModel);

  protected readonly interval = computed(
    () => this.state().timeControl.interval?.() ?? null,
  );
  protected readonly options = computed(
    () => this.state().timeControl.options?.() ?? null,
  );

  constructor() {
    effect(() => {
      if (this.state().touched())
        this.models().forEach((m) => m.control.markAsTouched());
      else this.models().forEach((m) => m.control.markAsUntouched());
    });
  }
}
