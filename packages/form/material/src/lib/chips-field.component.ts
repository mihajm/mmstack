import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  effect,
  inject,
  input,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import {
  MatAutocomplete,
  MatAutocompleteSelectedEvent,
  MatAutocompleteTrigger,
  MatOption,
} from '@angular/material/autocomplete';
import {
  MatChipGrid,
  MatChipInput,
  MatChipInputEvent,
  MatChipRemove,
  MatChipRow,
  MatChipsModule,
} from '@angular/material/chips';
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
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatTooltip } from '@angular/material/tooltip';
import { ChipsState, SignalErrorValidator } from './adapters';

@Component({
  selector: 'mm-chips-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    class: 'mm-chips-field',
  },
  imports: [
    FormsModule,
    MatFormField,
    MatLabel,
    MatHint,
    MatPrefix,
    MatSuffix,
    MatIcon,
    MatError,
    MatInput,
    MatTooltip,
    MatAutocomplete,
    MatAutocompleteTrigger,
    MatOption,
    SignalErrorValidator,
    MatChipGrid,
    MatChipRow,
    MatChipRemove,
    MatChipInput,
    MatChipsModule,
  ],
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

      <mat-chip-grid #chipGrid>
        @for (opt of state().labeledValue(); track opt.value) {
          <mat-chip-row (removed)="remove(opt)">
            {{ opt.label }}
            <button matChipRemove>
              <mat-icon>cancel</mat-icon>
            </button>
          </mat-chip-row>
        }
      </mat-chip-grid>

      <input
        matInput
        [(ngModel)]="state().query"
        [disabled]="state().disabled()"
        [readonly]="state().readonly()"
        [required]="state().required()"
        [placeholder]="state().placeholder()"
        [mmSignalError]="state().error()"
        [matAutocomplete]="auto"
        [matChipInputFor]="chipGrid"
        [matChipInputSeparatorKeyCodes]="state().separatorCodes()"
        (matChipInputTokenEnd)="add($event)"
        (blur)="state().markAsTouched()"
      />

      <mat-autocomplete
        #auto
        [panelWidth]="panelWidth()"
        (optionSelected)="selected($event)"
      >
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
    .mm-chips-field {
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
export class ChipsFieldComponent<TParent = undefined> {
  readonly state = input.required<ChipsState<TParent>>();

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
  private readonly announcer = inject(LiveAnnouncer);

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

  protected add(e: MatChipInputEvent) {
    console.log('hre');
    const value = e.value.trim();

    if (!value) return;
    const state = untracked(this.state);
    state.value.update((cur) => [...cur, value]);
    state.query.set('');
    state.markAsTouched();
  }

  protected remove({ value, label }: { value: string; label: string }) {
    const state = untracked(this.state);
    state.value.update((cur) => cur.filter((v) => v !== value));
    this.announcer.announce(`Removed ${label}`);
    state.markAsTouched();
  }

  protected selected(e: MatAutocompleteSelectedEvent) {
    console.log(e.option.viewValue);
    const state = untracked(this.state);
    state.value.update((cur) => [...cur, e.option.viewValue]);
    e.option.deselect();
    state.query.set('');
    state.markAsTouched();
  }
}
