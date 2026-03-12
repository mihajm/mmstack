import { createGeneralValidators } from '../general';
import { createMergeValidators } from '../merge-validators';
import { type Validator } from '../validator.type';
import { createIsDateValidator, defaultIsDateMessageFactory } from './is-date';
import {
  createMaxDateValidator,
  defaultMaxDateMessageFactory,
} from './max-date';
import {
  createMinDateValidator,
  defaultMinDateMessageFactory,
} from './min-date';
import { defaultFormatDate, defaultToDate } from './util';

export type DateMessageFactories = {
  min: Parameters<typeof createMinDateValidator>[0];
  max: Parameters<typeof createMaxDateValidator>[0];
  isDate: Parameters<typeof createIsDateValidator>[0];
};

export const DEFAULT_DATE_MESSAGES: DateMessageFactories = {
  min: defaultMinDateMessageFactory,
  max: defaultMaxDateMessageFactory,
  isDate: defaultIsDateMessageFactory,
};

/**
 * Configuration options for creating a combined date validator using the `.all()`
 * method returned by `createDateValidators` (accessed via `injectValidators().date.all`).
 *
 * Pass an object of this type to `validators.date.all({...})` to specify which
 * date-related validations should be included in the resulting validator function.
 * The `toDate` function provided via `provideValidatorConfig` will be used internally
 * to handle comparisons if `string` or custom date object types are used for the options
 * or the control's value.
 *
 * The validation function returned by `.all()` expects an input value of type `TDate | null`,
 * where `TDate` matches the type configured via `provideValidatorConfig`.
 */
export type DateValidatorOptions = {
  /**
   * If `true`, the date value must not be `null` or `undefined`.
   * Uses the configured 'required' validation message.
   * @see Validators.general.required
   * @example
   * { required: true }
   */
  required?: boolean;

  /**
   * Specifies the minimum allowed date (inclusive).
   * Validation fails if the input date is earlier than this date.
   * Accepts a `Date` object or a date string parseable by the configured `toDate` function.
   * Uses the configured 'min date' validation message.
   * @example
   * { min: new Date('2024-01-01') }
   * { min: '2024-01-01T00:00:00.000Z' }
   * @see Validators.date.min
   */
  min?: Date | string; // Accepts string or Date for config, internal `toDate` handles it

  /**
   * Specifies the maximum allowed date (inclusive).
   * Validation fails if the input date is later than this date.
   * Accepts a `Date` object or a date string parseable by the configured `toDate` function.
   * Uses the configured 'max date' validation message.
   * @example
   * { max: '2025-12-31' }
   * @see Validators.date.max
   */
  max?: Date | string;

  /**
   * The date value must be exactly equal to the specified value (which can be `null`).
   * Uses the configured `mustBe` validation message.
   * Date comparison uses the configured `toDate` function internally.
   * @example
   * { mustBe: new Date('2024-07-04') } // Must be exactly July 4th, 2024
   * { mustBe: null }                 // Must be exactly null
   * @see Validators.general.mustBe
   * @see Validators.general.mustBeNull
   */
  mustBe?: Date | string | null;

  /**
   * The date value must *not* be equal to the specified value (which can be `null`).
   * Uses the configured `not` validation message.
   * Date comparison uses the configured `toDate` function internally.
   * @example
   * { not: new Date('2000-01-01') } // Cannot be the start of the millennium
   * @see Validators.general.not
   */
  not?: Date | string | null;

  /**
   * The date value must be one of the dates (or `null`) included in the specified array.
   * Uses the configured `oneOf` validation message.
   * Date comparison uses the configured `toDate` function internally.
   * @example
   * { oneOf: [new Date('2024-12-25'), null] } // Must be Christmas 2024 or null
   * @see Validators.general.oneOf
   */
  oneOf?: (Date | string | null)[];

  /**
   * The date value must *not* be any of the dates (or `null`) included in the specified array.
   * Uses the configured `notOneOf` validation message.
   * Date comparison uses the configured `toDate` function internally.
   * @example
   * { notOneOf: [new Date('2024-04-01')] } // Cannot be April Fool's Day 2024
   * @see Validators.general.notOneOf
   */
  notOneOf?: (Date | string | null)[];

  /**
   * Optional configuration passed down to specific message factories.
   * Currently primarily used by the `required` validator's message factory.
   */
  messageOptions?: {
    /**
     * An optional label for the field (e.g., 'Start Date', 'End Date').
     * This can be incorporated into the 'required' error message by its factory
     * (e.g., "Start Date is required" instead of just "Field is required").
     * @example
     * { required: true, messageOptions: { label: 'Start Date' } }
     */
    label?: string;
  };
};

export function createDateValidators<TDate = Date>(
  factories?: Partial<DateMessageFactories>,
  toDate = defaultToDate<TDate>,
  formatDate = defaultFormatDate,
  locale = 'en-US',
  generalValidators = createGeneralValidators(),
  merger = createMergeValidators(),
) {
  const t = { ...DEFAULT_DATE_MESSAGES, ...factories };
  const base = {
    min: createMinDateValidator(t.min, toDate, formatDate, locale),
    max: createMaxDateValidator(t.max, toDate, formatDate, locale),
    isDate: createIsDateValidator(t.isDate, toDate),
  };

  const toLabel = (d: TDate | null) =>
    d ? formatDate(toDate(d), locale) : 'null';

  return {
    ...base,
    all: (opt: DateValidatorOptions) => {
      const validators: Validator<TDate | null>[] = [];

      if (opt.required)
        validators.push(generalValidators.required(opt.messageOptions?.label));

      validators.push(base.isDate());

      if (opt.mustBe !== undefined) {
        if (opt.mustBe === null)
          validators.push(generalValidators.mustBeNull<TDate | null>());
        else {
          const d = toDate(opt.mustBe as TDate | string);
          const formatted = formatDate(d, locale);
          validators.push(
            generalValidators.mustBe<TDate | null>(
              d as TDate,
              formatted,
              (a, b) => {
                if (!a && !b) return true;
                if (!a || !b) return false;

                return toDate(a).getTime() === toDate(b).getTime();
              },
            ),
          );
        }
      }

      if (opt.not !== undefined) {
        if (opt.not === null)
          validators.push(generalValidators.not<TDate | null>(null));
        else {
          const d = toDate(opt.not as TDate);
          const formatted = formatDate(d, locale);
          validators.push(
            generalValidators.not<TDate | null>(
              d as TDate,
              formatted,
              (a, b) => {
                if (!a && !b) return true;
                if (!a || !b) return false;

                return toDate(a).getTime() === toDate(b).getTime();
              },
            ),
          );
        }
      }

      if (opt.min !== undefined) validators.push(base.min(opt.min as TDate));
      if (opt.max !== undefined) validators.push(base.max(opt.max as TDate));

      if (opt.oneOf) {
        const dates = opt.oneOf.map((d) => (d ? toDate(d as TDate) : null));

        validators.push(
          generalValidators.oneOf<TDate | null>(
            dates as TDate[],
            toLabel,
            (a) =>
              a === null || a === undefined
                ? 'null'
                : toDate(a).getTime().toString(),
          ),
        );
      }

      if (opt.notOneOf) {
        const dates = opt.notOneOf.map((d) => (d ? toDate(d as TDate) : null));
        validators.push(
          generalValidators.notOneOf<TDate | null>(
            dates as TDate[],
            toLabel,
            (a) =>
              a === null || a === undefined
                ? 'null'
                : toDate(a).getTime().toString(),
          ),
        );
      }

      return merger(validators as Validator<TDate | null>[]);
    },
    util: {
      toDate,
      formatDate,
    },
  };
}
