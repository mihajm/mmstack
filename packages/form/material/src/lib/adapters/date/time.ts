import { computed, isDevMode, type Signal } from '@angular/core';
import { type MatTimepickerOption } from '@angular/material/timepicker';
import {
  createTimeState as genericCreateTimeState,
  injectCreateTimeState as genericInjectCreateTimeState,
  type InjectedTimeStateOptions as GenericInjectedTimeStateOptions,
  type TimeState as GenericTimeState,
  type TimeStateOptions as GenericTimeStateOptions,
} from '@mmstack/form-adapters';
import { type DerivedSignal } from '@mmstack/primitives';

export type TimeState<TParent = undefined, TDate = Date> = GenericTimeState<
  TParent,
  TDate
> & {
  interval?: Signal<number | string | null>;
  options?: Signal<readonly MatTimepickerOption<TDate>[] | null>;
};

export type MaterialTimeOptionSpecifics<TDate = Date> = {
  /**
   * Interval between each option in the timepicker.
   * The value can either be an amount of seconds (e.g. 90) or a number with a unit (e.g. 45m).
   * Supported units are s for seconds, m for minutes or h for hours.
   * An dev time warning will be logged if both options and interval are specified. But options will take precedence.
   */
  interval?: () => number | string;
  /**
   * Array of pre-defined options that the user can select from, as an alternative to using the interval input.
   * An dev time warning will be logged if both options and interval are specified. But options will take precedence.
   */
  options?: () => MatTimepickerOption<TDate>[];
};

export type TimeStateOptions<TDate = Date> = GenericTimeStateOptions<TDate> &
  MaterialTimeOptionSpecifics<TDate>;

export type InjectedTimeStateOptions<TDate = Date> =
  GenericInjectedTimeStateOptions<TDate> & MaterialTimeOptionSpecifics<TDate>;

/**
 * Represents the reactive state for a time input form control.
 *
 * Extends the base `DateState` angular defaults to todays date, but varies the time if no date is provided
 * min and max values adapt automatically to the dates day
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @template TDate The type used for date values within the control (e.g., `Date`, Luxon `DateTime`, Moment). Defaults to `Date`.
 * @see DateState
 */
export function createTimeState<TParent = undefined, TDate = Date>(
  value: TDate | null | DerivedSignal<TParent, TDate | null>,
  opt: TimeStateOptions<TDate>,
): TimeState<TParent, TDate> {
  const base = genericCreateTimeState<TParent, TDate>(value, opt);

  const options = computed(() => {
    const options = opt?.options?.();
    if (!options?.length) return null;
    return options;
  });

  const interval = computed(() => {
    if (options()) {
      if (isDevMode())
        console.warn(
          'Both `options` and `interval` are provided in TimeState options. Using `options`.',
        );
      return null;
    }
    return opt?.interval?.() ?? null;
  });

  return {
    ...base,
    options,
    interval,
  };
}

/**
 * Creates and returns a factory function for generating `TimeState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`, `LOCALE_ID`)
 * to automatically handle:
 * - Validation configuration via `DateValidatorOptions` (passed to the `validation` option).
 * - Localization for default validation error messages.
 * - Enhanced error message formatting (splitting merged errors into `error` and `errorTooltip` signals).
 * - Populating the `min` and `max` signals on `TimeState` based on the constraints specified
 * within the `validation` options object.
 * - Configuration of date handling based on `provideValidatorConfig`.
 *
 * This is the **recommended** way to create `TimeState` within an Angular application.
 *
 * @returns A factory function: `(value: TDate | null | DerivedSignal<TParent, TDate | null>, opt?: InjectedTimeStateOptions<TDate>) => TimeState<TParent, TDate>`.
 * @template TDate The type used for date values passed to the factory (e.g., `Date`, Luxon `DateTime`).
 * Must match the `TDate` used during `provideValidatorConfig` if custom date handling is required. Defaults to `Date`.
 *
 * @example
 * // Within an injection context:
 * const createTime = injectCreateTimeState();
 * // If using Luxon: const createTime = injectCreateTimeState<DateTime>();
 *
 * const eventTimeState = createTime(null, {
 * label: () => 'Event Time',
 * placeholder: () => 'Select event time',
 * validation: () => ({ // Provide DateValidatorOptions here
 * required: true,
 * min: new Date(), // Sets min validation AND state.min() signal
 * })
 * });
 *
 * // Template can use min/max signals for datepicker limits:
 * // <mat-timepicker-toggle [for]="picker" [disabled]="eventTimeState.disabled()"></mat-datepicker-toggle>
 * // <input matInput [matTimepicker]="picker"
 * //        [min]="eventTimeState.min()"
 * //        [max]="eventTimeState.max()"
 * //        [(ngModel)]="eventTimeState.value" ... >
 * // <mat-timepicker #picker></mat-datepicker>
 * // <mat-error><span [matTooltip]="eventTimeState.errorTooltip()">{{ eventTimeState.error() }}</span></mat-error>
 */
export function injectCreateTimeState() {
  const factory = genericInjectCreateTimeState();

  /**
   * Factory function (returned by `injectCreateTimeState`) that creates `TimeState`.
   * Integrates with `@mmstack/form-validation` via DI for validation and localization.
   * Handles splitting of multiple validation errors into `error` and `errorTooltip`.
   * Derives `min`/`max` state signals from `validation` options.
   *
   * @template TDate The type for date values used by this control. Defaults to `Date`.
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial date value (`TDate | null`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedTimeStateOptions`), including the `validation` property
   * which accepts `DateValidatorOptions` (used for both validation rules and setting state's `min`/`max` signals).
   * @returns A `TimeState` instance managing the control's reactive state.
   */
  return <TParent = undefined, TDate = Date>(
    value: TDate | null | DerivedSignal<TParent, TDate | null>,
    opt?: InjectedTimeStateOptions<TDate>,
  ): TimeState<TParent, TDate> => {
    const state = factory(value, opt);

    const options = computed(() => {
      const options = opt?.options?.();
      if (!options?.length) return null;
      return options;
    });

    const interval = computed(() => {
      if (options()) {
        if (isDevMode())
          console.warn(
            'Both `options` and `interval` are provided in TimeState options. Using `options`.',
          );
        return null;
      }
      return opt?.interval?.() ?? null;
    });

    const oneOf = computed(() => {});

    return {
      ...state,
      options,
      interval,
    };
  };
}
