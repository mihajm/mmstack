import { computed, Directive, effect, input } from '@angular/core';
import { NG_VALIDATORS, type Validator } from '@angular/forms';

/**
 * A standalone directive that integrates an external error string signal
 * (typically from an `@mmstack/form-core` control's `.error()` signal)
 * with Angular's standard `ngModel` validation mechanism.
 *
 * Apply this directive alongside `ngModel` to an input element and bind the
 * string error signal output (e.g., `myFormControl.error()`) to the `[mmSignalError]` input property.
 *
 * The directive provides itself via the `NG_VALIDATORS` multi-provider token.
 * When the bound `mmSignalError` input contains a non-empty string, this directive
 * reports a validation error to the `NgControl` associated with the `ngModel`.
 * The error object produced is `{ error: string }`, where `string` is the
 * value passed to `mmSignalError`.
 *
 * This allows standard Angular form validation consumers (like `<mat-error>`,
 * UI components checking `ngControl.invalid`, or CSS classes based on `ng-invalid`)
 * to react correctly to the validation status managed externally by your signal-based form control.
 *
 * @implements Validator
 *
 * @usageNotes
 * ```html
 * <mat-form-field>
 *   <mat-label>{{ nameControl.label() }}</mat-label>
 *   <input
 *   matInput
 *   [(ngModel)]="nameControl.value"
 *   [required]="nameControl.required()"
 *   [readOnly]="nameControl.readonly()"
 *   [disabled]="nameControl.disabled()"
 *   (blur)="nameControl.markAsTouched()"
 *   [mmSignalError]="nameControl.error()"
 *   />
 * </mat-form-field>
 * ```
 */
@Directive({
  selector: '[ngModel][mmSignalError]',
  standalone: true,
  providers: [
    {
      provide: NG_VALIDATORS,
      useExisting: SignalErrorValidator,
      multi: true,
    },
  ],
})
export class SignalErrorValidator implements Validator {
  /**
   * Input property to receive the external error message string.
   *
   * Bind the `.error()` signal result from an `@mmstack/form-core` control here.
   * - An **empty string (`''`)** indicates a **valid** state (no error reported).
   * - Any **non-empty string** indicates an **invalid** state, and its value
   * will be reported as the validation error message under the key `'error'`.
   */
  readonly mmSignalError = input('');
  /** @internal Callback registered by Angular Forms. */
  private onChange = (): void => {
    // No-op until registered by Angular Forms via registerOnValidatorChange
  };

  /** @internal Computes validity based on the error input signal. */
  private readonly valid = computed(() => !this.mmSignalError());

  constructor() {
    effect(() => {
      this.valid();
      this.onChange();
    });
  }

  /**
   * @internal
   * Method required by the `Validator` interface. Called by Angular Forms to perform validation.
   * @param control The `AbstractControl` associated with the `ngModel` (not used directly here).
   * @returns A `ValidationErrors` object `{ error: string }` if invalid (mmSignalError is non-empty),
   * otherwise `null` for valid.
   */
  validate() {
    return !this.valid() ? { error: this.mmSignalError() } : null;
  }

  /**
   * @internal
   * Method required by the `Validator` interface. Registers the callback function
   * provided by Angular Forms to be called when the validator's state changes.
   * @param fn The callback function to register.
   */
  registerOnValidatorChange(fn: () => void) {
    this.onChange = fn;
  }
}
