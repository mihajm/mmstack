import { isSignal } from '@angular/core';
import { toFakeDerivation, type DerivedSignal } from '@mmstack/primitives';
import {
  createDateState,
  injectCreateDateState,
  InjectedDateStateOptions,
  type DateState,
  type DateStateOptions,
} from './base-date';
import {
  createTimeState,
  injectCreateTimeState,
  InjectedTimeStateOptions,
  TimeStateOptions,
  type TimeState,
} from './time';

/**
 * Represents the reactive state for a time input form control.
 *
 * Extends the base `DateState` to include both date and time components, exposes them as separate controls.
 * The base controls uses the date control's min/max & other values
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @template TDate The type used for date values within the control (e.g., `Date`, Luxon `DateTime`, Moment). Defaults to `Date`.
 * @see DateState
 * @see TimeState
 */
export type DateTimeState<TParent = undefined, TDate = Date> = Omit<
  DateState<TParent, TDate>,
  'type'
> & {
  type: 'datetime';
  /**
   * The date control managing the date part of the datetime input.
   * It uses the same `min` and `max` constraints as the time control.
   */

  dateControl: DateState<TParent, TDate>;
  /**
   * The time control managing the time part of the datetime input.
   * It uses the same `min` and `max` constraints as the date control. But only the time part is validatied
   */
  timeControl: TimeState<TParent, TDate>;
};

/**
 * @see TimeStateOptions
 * @see DateStateOptions
 */
export type DateTimeStateOptions<TDate = Date> = TimeStateOptions<TDate> & {
  timeLabel?: () => string;
  timeHint?: () => string;
  timePlaceholder?: () => string;
};

/**
 * @see InjectedTimeStateOptions
 * @see InjectedDateStateOptions
 */
export type InjectedDateTimeStateOptions<TDate = Date> =
  InjectedTimeStateOptions<TDate> & {
    timeLabel?: () => string;
    timeHint?: () => string;
    timePlaceholder?: () => string;
  };

/**
 * Creates the reactive state object (`DateTimeState`) for a time form control
 * without relying on Angular's dependency injection for validation or locale.
 * Includes computed signals for `min` and `max` date constraints based directly on the provided options.
 * If provided the day will shift to the current values date, in order to only validate the time part.
 * Angular defaults to today's date, but varies the time if no date is provided.
 *
 * Use this function directly only if creating state outside an injection context
 * or providing a fully custom `validator`, `locale`, `min`, and `max` manually via `opt`.
 * Prefer `injectCreateDateTimeState` for standard usage within Angular applications.
 *
 * Note: The `errorTooltip` signal returned by this function will initially be empty.
 * Enhanced tooltip generation based on multiple errors is handled by `injectCreateDateTimeState`.
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @template TDate The type used for date values. Defaults to `Date`.
 * @param value The initial date value (`TDate | null`), or a `DerivedSignal` linking it to a parent state.
 * @param opt Configuration options (`DateTimeStateOptions`), requires `locale`, optionally `validator`, `placeholder`, `min`, `max`.
 * @returns A `DateTimeState` instance managing the control's reactive state, including `min` and `max` signals.
 * @see injectCreateDateTimeState
 * @see createDateState
 */
export function createDateTimeState<TParent = undefined, TDate = Date>(
  initial: TDate | null | DerivedSignal<TParent, TDate | null>,
  opt: DateTimeStateOptions<TDate>,
): DateTimeState<TParent, TDate> {
  const value = isSignal(initial)
    ? initial
    : toFakeDerivation<TParent, TDate | null>(initial);
  const dateState = createDateState<TParent, TDate>(value, opt);

  const timeState = createTimeState<TParent, TDate>(value, {
    ...opt,
    label: opt?.timeLabel,
    hint: opt?.timeHint,
    placeholder: opt?.timePlaceholder,
  });

  return {
    ...dateState,
    dateControl: dateState,
    timeControl: timeState,
    type: 'datetime',
  };
}

/**
 * Creates and returns a factory function for generating `DateTimeState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`, `LOCALE_ID`)
 * to automatically handle:
 * - Validation configuration via `DateValidatorOptions` (passed to the `validation` option).
 * - Localization for default validation error messages.
 * - Enhanced error message formatting (splitting merged errors into `error` and `errorTooltip` signals).
 * - Populating the `min` and `max` signals on `DateTimeState` based on the constraints specified
 * within the `validation` options object.
 * - Configuration of date handling based on `provideValidatorConfig`.
 *
 * This is the **recommended** way to create `DateTimeState` within an Angular application.
 *
 * @returns A factory function: `(value: TDate | null | DerivedSignal<TParent, TDate | null>, opt?: InjectedDateTimeStateOptions<TDate>) => DateTimeState<TParent, TDate>`.
 * @template TDate The type used for date values passed to the factory (e.g., `Date`, Luxon `DateTime`).
 * Must match the `TDate` used during `provideValidatorConfig` if custom date handling is required. Defaults to `Date`.
 *
 */
export function injectCreateDateTimeState() {
  const d = injectCreateDateState();
  const t = injectCreateTimeState();

  /**
   * Factory function (returned by `injectCreateDateTimeState`) that creates `DateTimeState`.
   * Integrates with `@mmstack/form-validation` via DI for validation and localization.
   * Handles splitting of multiple validation errors into `error` and `errorTooltip`.
   * Derives `min`/`max` state signals from `validation` options.
   *
   * @template TDate The type for date values used by this control. Defaults to `Date`.
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial date value (`TDate | null`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedDateTimeStateOptions`), including the `validation` property
   * which accepts `DateValidatorOptions` (used for both validation rules and setting state's `min`/`max` signals).
   * @returns A `DateTimeState` instance managing the control's reactive state.
   */
  return <TDate = Date, TParent = undefined>(
    initial: TDate | null | DerivedSignal<TParent, TDate | null>,
    opt?: InjectedDateTimeStateOptions<TDate>,
  ): DateTimeState<TParent, TDate> => {
    const value = isSignal(initial)
      ? initial
      : toFakeDerivation<TParent, TDate | null>(initial);
    const dateState = d(value, opt);
    const timeState = t(value, {
      ...opt,
      label: opt?.timeLabel,
      hint: opt?.timeHint,
      placeholder: opt?.timePlaceholder,
    });

    return {
      ...dateState,
      dateControl: dateState,
      timeControl: timeState,
      type: 'datetime',
    };
  };
}
