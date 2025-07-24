import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule, NgModel } from '@angular/forms';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { SignalErrorValidator, ToggleState } from './adapters';

@Component({
  selector: 'mm-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule, MatSlideToggle, SignalErrorValidator, MatTooltip],
  host: {
    class: 'mm-toggle',
  },
  template: `
    <div class="mm-toggle-container">
      <mat-slide-toggle
        class="mm-toggle"
        [class.readonly]="state().readonly()"
        [class.error]="!!state().error()"
        [labelPosition]="labelPosition()"
        [disabled]="state().disabled()"
        [required]="state().required()"
        [(ngModel)]="state().value"
        (ngModelChange)="state().markAsTouched()"
        [mmSignalError]="state().error()"
        >{{ state().label() }}</mat-slide-toggle
      >

      @let showError = state().error() && state().touched();

      @if (state().hint() && !showError) {
        <span
          class="mm-toggle-hint"
          [matTooltip]="state().hintTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          >{{ state().hint() }}</span
        >
      }

      @if (showError) {
        <span
          class="mm-toggle-error"
          [matTooltip]="state().errorTooltip()"
          matTooltipPositionAtOrigin
          matTooltipClass="mm-multiline-tooltip"
          >{{ state().error() }}</span
        >
      }
    </div>
  `,
  styles: `
    .mm-toggle {
      display: contents;

      .mm-toggle-container {
        display: contents;

        &:has(span.mm-toggle-hint),
        &:has(span.mm-toggle-error) {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }

        span.mm-toggle-error,
        span.mm-toggle-hint {
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

        span.mm-toggle-error {
          color: var(--mat-sys-error);
        }

        .mm-toggle {
          &.readonly {
            pointer-events: none;
            user-select: none;
            touch-action: none;
          }
          &.error {
            --mat-slide-toggle-bar-error-color: var(--mat-sys-error);
            --mat-slide-toggle-thumb-error-color: var(--mat-sys-error);
          }
        }
      }
    }
  `,
})
export class ToggleField<TParent = undefined> {
  readonly state = input.required<ToggleState<TParent>>();

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
