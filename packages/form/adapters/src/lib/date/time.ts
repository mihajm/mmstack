import { computed, inject, LOCALE_ID } from '@angular/core';
import {
  defaultToDate,
  injectValidators,
  type Validators,
} from '@mmstack/form-validation';
import { type DerivedSignal } from '@mmstack/primitives';
import {
  createDateState,
  type DateState,
  type DateStateOptions,
  type InjectedDateStateOptions,
} from './base-date';

function setDay(date: Date | null, extractFrom: Date | null): Date | null {
  if (!date) return null;
  const next = new Date(extractFrom || Date.now());
  next.setHours(
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
  return next;
}

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
export type TimeState<TParent = undefined, TDate = Date> = Omit<
  DateState<TParent, TDate>,
  'type'
> & {
  type: 'time';
};

/**
 * @see DateStateOptions
 */
export type TimeStateOptions<TDate = Date> = DateStateOptions<TDate> & {
  /**
   * A function to convert the date value to a standard `Date` object.
   * Defaults to `defaultToDate`, which converts `TDate` to a `Date`.
   */
  toDate?: (date: TDate | null) => Date | null;
};

/**
 * @see InjectedDateStateOptions
 */
export type InjectedTimeStateOptions<TDate = Date> =
  InjectedDateStateOptions<TDate>;

/**
 * Creates the reactive state object (`TimeState`) for a time form control
 * without relying on Angular's dependency injection for validation or locale.
 * Includes computed signals for `min` and `max` date constraints based directly on the provided options.
 * If provided the day will shift to the current values date, in order to only validate the time part.
 * Angular defaults to today's date, but varies the time if no date is provided.
 *
 * Use this function directly only if creating state outside an injection context
 * or providing a fully custom `validator`, `locale`, `min`, and `max` manually via `opt`.
 * Prefer `injectCreateTimeState` for standard usage within Angular applications.
 *
 * Note: The `errorTooltip` signal returned by this function will initially be empty.
 * Enhanced tooltip generation based on multiple errors is handled by `injectCreateTimeState`.
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @template TDate The type used for date values. Defaults to `Date`.
 * @param value The initial date value (`TDate | null`), or a `DerivedSignal` linking it to a parent state.
 * @param opt Configuration options (`TimeStateOptions`), requires `locale`, optionally `validator`, `placeholder`, `min`, `max`.
 * @returns A `TimeState` instance managing the control's reactive state, including `min` and `max` signals.
 * @see injectCreateTimeState
 * @see createDateState
 */
export function createTimeState<TParent = undefined, TDate = Date>(
  value: TDate | null | DerivedSignal<TParent, TDate | null>,
  opt: TimeStateOptions<TDate>,
): TimeState<TParent, TDate> {
  const dateState = createDateState<TParent, TDate>(value, opt);

  const toDate = opt.toDate ?? defaultToDate;

  const dateValue = computed(() => toDate(dateState.value()), {
    equal: (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return a.getTime() === b.getTime();
    },
  });

  return {
    ...dateState,
    min: computed(() => setDay(dateState.min(), dateValue())),
    max: computed(() => setDay(dateState.max(), dateValue())),
    type: 'time',
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
  const v = injectValidators();
  const locale = inject(LOCALE_ID);

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
  return <TDate = Date, TParent = undefined>(
    value: TDate | null | DerivedSignal<TParent, TDate | null>,
    opt?: InjectedTimeStateOptions<TDate>,
  ) => {
    const validators = v as Validators<TDate>;
    const validationOptions = computed(() => ({
      messageOptions: {
        label: opt?.label?.(),
      },
      ...opt?.validation?.(),
    }));

    const validator = computed(() => validators.date.all(validationOptions()));

    const state = createTimeState(value, {
      ...opt,
      toDate: (value) => {
        if (!value) return null;
        return validators.date.util.toDate(value);
      },
      locale,
      min: computed(() => validationOptions().min ?? null),
      max: computed(() => validationOptions().max ?? null),
      required: computed(() => validationOptions().required ?? false),
      validator,
    });

    const resolvedError = computed(() => {
      const merger = validator();

      return merger.resolve(state.errorTooltip() || state.error());
    });

    return {
      ...state,
      error: computed(() => resolvedError().error),
      errorTooltip: computed(() => resolvedError().tooltip),
    };
  };
}
