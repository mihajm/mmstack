import { computed, type Signal } from '@angular/core';
import {
  formControl,
  type CreateFormControlOptions,
  type DerivedSignal,
  type FormControlSignal,
} from '@mmstack/form-core';
import { injectValidators } from '@mmstack/form-validation';
import { tooltip } from '../util';

/**
 * Represents the reactive state for a boolean form control (e.g., checkbox).
 * Extends the base `FormControlSignal<boolean>` and includes a `type` discriminator.
 * Intended for use with checkbox-like UI elements. For toggle switches, see `ToggleState`.
 *
 * @template TParent The type of the parent form group's value, if applicable.
 * @see ToggleState
 */
export type BooleanState<TParent = undefined> = FormControlSignal<
  boolean,
  TParent
> & {
  /** signal for error tooltip, default is shortened when error is longer than 40 chars */
  errorTooltip: Signal<string>;
  /** signal for hint tooltip, default is shortened when hint is longer than 40 chars */
  hintTooltip: Signal<string>;
  /** Type discriminator for boolean controls. */
  type: 'boolean';
};

/**
 * Configuration options for creating a `BooleanState`, used with `createBooleanState`.
 *
 * Inherits options from `CreateFormControlOptions<boolean>` but omits `required`,
 * as boolean "required" validation typically means "must be true", which is handled
 * via the `validation` option in `injectCreateBooleanState`.
 *
 * @see CreateFormControlOptions
 * @see injectCreateBooleanState
 */
export type BooleanStateOptions = Omit<
  CreateFormControlOptions<boolean, 'control'>,
  'required'
> & {
  /* shortens error/hint message & provides errorTooltip with full message, default 40 */
  maxErrorHintLength?: () => number;
};

/**
 * Creates the reactive state object (`BooleanState`) for a boolean form control
 * without relying on Angular's dependency injection for validation setup.
 *
 * Use this function directly if:
 * - You don't need validation or are providing a pre-built `validator` function manually.
 * - You are creating state outside of an Angular injection context.
 *
 * For easier integration with `@mmstack/form-validation`, prefer `injectCreateBooleanState`.
 *
 * @template TParent The type of the parent form group's value, if applicable.
 * @param value The initial boolean value, or a `DerivedSignal` linking it to a parent state.
 * @param opt Optional configuration (`BooleanStateOptions`), potentially including a `validator` function.
 * @returns A `BooleanState` instance managing the control's reactive state.
 * @see injectCreateBooleanState
 */
export function createBooleanState<TParent = undefined>(
  value: boolean | DerivedSignal<TParent, boolean>,
  opt?: BooleanStateOptions,
): BooleanState<TParent> {
  const state = formControl(value, opt);

  const { shortened: error, tooltip: errorTooltip } = tooltip(
    state.error,
    opt?.maxErrorHintLength,
  );

  const { shortened: hint, tooltip: hintTooltip } = tooltip(
    state.hint,
    opt?.maxErrorHintLength,
  );

  return {
    ...state,
    hint,
    hintTooltip,
    error,
    errorTooltip,
    type: 'boolean',
  };
}

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateBooleanState`.
 *
 * This type is derived from `BooleanStateOptions` but explicitly excludes the
 * `validator` property (as validation rules are configured via the `validation`
 * property below) and adds the `validation` configuration specific to boolean controls.
 *
 * @see injectCreateBooleanState
 * @see BooleanStateOptions
 */
export type InjectedBooleanStateOptions = Omit<
  BooleanStateOptions,
  'validator'
> & {
  /**
   * Optional configuration for boolean-specific validation rules.
   * The factory function uses the injected `validators` service based on this configuration.
   */
  validation?: () => {
    /**
     * If `true`, applies the `validators.boolean.mustBeTrue()` validator,
     * requiring the control's value to be `true` to be considered valid.
     */
    requireTrue?: boolean;
  };
};

/**
 * Factory function (returned by `injectCreateBooleanState`) that creates `BooleanState`.
 * Integrates with `@mmstack/form-validation` via DI to apply validation rules.
 *
 * @template TParent The type of the parent form group's value, if applicable.
 * @param value The initial boolean value, or a `DerivedSignal` linking it to a parent state.
 * @param opt Configuration options specific to this injected factory, defined by
 * the `InjectedBooleanStateOptions` type, including the `validation` property.
 * @returns A `BooleanState` instance managing the control's reactive state.
 */
export function injectCreateBooleanState() {
  const validators = injectValidators();

  /**
   * Factory function (returned by `injectCreateBooleanState`) that creates `BooleanState`.
   * Integrates with `@mmstack/form-validation` via DI.
   *
   * @template TParent The type of the parent form group's value, if applicable.
   * @param value The initial boolean value, or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options, excluding `validator` but adding a `validation` property.
   * @param opt.validation Optional configuration for boolean-specific validation rules.
   * @param opt.validation.requireTrue If `true`, applies the `validators.boolean.mustBeTrue()` validator.
   * @returns A `BooleanState` instance managing the control's reactive state.
   */
  return <TParent = undefined>(
    value: boolean | DerivedSignal<TParent, boolean>,
    opt?: InjectedBooleanStateOptions,
  ): BooleanState<TParent> => {
    const validation = computed(() => ({
      requireTrue: false,
      ...opt?.validation?.(),
    }));

    const validator = computed(() => {
      if (validation().requireTrue) return validators.boolean.mustBeTrue();
      return () => '';
    });

    return createBooleanState(value, { ...opt, validator });
  };
}
