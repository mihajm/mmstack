import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatTooltip } from '@angular/material/tooltip';
import { BooleanState, SignalErrorValidator } from './adapters';

@Component({
  selector: 'mm-boolean-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MatCheckbox, SignalErrorValidator, MatTooltip],
  host: {
    class: 'mm-boolean-field',
  },
  template: `
    <div class="mm-checkbox-field-container" (click)="containerClicked.emit()">
      <mat-checkbox
        class="mm-checkbox-field"
        [class.readonly]="state().readonly()"
        [class.error]="!!state().error()"
        [disabled]="state().disabled()"
        [required]="state().required()"
        [labelPosition]="labelPosition()"
        [(ngModel)]="state().value"
        (ngModelChange)="state().markAsTouched()"
        [mmSignalError]="state().error()"
        (click)="$event.stopPropagation()"
        >{{ state().label() }}</mat-checkbox
      >

      @let showError = state().error() && state().touched();

      @if (state().hint() && !showError) {
        <span
          class="mm-checkbox-field-hint"
          [matTooltip]="state().hintTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          (click)="$event.stopPropagation()"
          >{{ state().hint() }}</span
        >
      }

      @if (showError) {
        <span
          class="mm-checkbox-field-error"
          [matTooltip]="state().errorTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          (click)="$event.stopPropagation()"
          >{{ state().error() }}</span
        >
      }
    </div>
  `,
  styles: `
    .mm-boolean-field {
      display: contents;

      .mm-checkbox-field-container {
        display: contents;

        &:has(span.mm-checkbox-field-hint),
        &:has(span.mm-checkbox-field-error) {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }

        span.mm-checkbox-field-error,
        span.mm-checkbox-field-hint {
          font-family: var(
            --mat-form-field-subscript-text-font,
            var(--mat-sys-body-small-font)
          );
          line-height: var(
            --mat-form-field-subscript-text-line-height,
            var(--mat-sys-body-small-line-height)
          );
          font-size: var(
            --mat-form-field-subscript-text-size,
            var(--mat-sys-body-small-size)
          );
          letter-spacing: var(
            --mat-form-field-subscript-text-tracking,
            var(--mat-sys-body-small-tracking)
          );
          font-weight: var(
            --mat-form-field-subscript-text-weight,
            var(--mat-sys-body-small-weight)
          );
        }

        span.mm-checkbox-field-error {
          color: var(--mat-sys-error);
        }

        .mm-checkbox-field {
          &.readonly {
            pointer-events: none;
            user-select: none;
            touch-action: none;
          }
          &.error {
            --mdc-checkbox-selected-icon-color: var(--mat-sys-error);
          }
        }
      }
    }
  `,
})
export class BooleanFieldComponent<TParent = undefined> {
  readonly state = input.required<BooleanState<TParent>>();
  readonly containerClicked = output<void>();

  private readonly model = viewChild.required(NgModel);

  protected readonly labelPosition = computed(
    () => this.state().labelPosition?.() ?? 'after',
  );

  constructor() {
    effect(() => {
      if (this.state().touched()) this.model().control.markAsTouched();
      else this.model().control.markAsUntouched();
    });
  }
}
