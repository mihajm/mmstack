import {
  type DateMessageFactories,
  type DateValidatorOptions,
  DEFAULT_DATE_MESSAGES,
} from '.';
import { createGeneralValidators } from '../general';
import { createMergeValidators } from '../merge-validators';
import { type Validator } from '../validator.type';
import { createIsDateValidator } from './is-date';
import { createMaxDateValidator } from './max-date';
import { createMinDateValidator } from './min-date';
import { defaultFormatDate, defaultToDate } from './util';

/**
 * Represents a date range with two date values: `from` and `to`.
 * Both values can be `null` to indicate an empty range.
 * @template TDate The type of the date values (e.g., `Date`, Luxon `DateTime`, Moment).
 */
export type DateRange<TDate = Date> = {
  /** The start date of the range. Can be `null` if not set. */
  start: TDate | null;
  /** The end date of the range. Can be `null` if not set. */
  end: TDate | null;
};

export function createDateRangeValidators<TDate = Date>(
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

  return {
    ...base,
    all: (
      opt: Pick<
        DateValidatorOptions,
        'required' | 'min' | 'max' | 'messageOptions'
      >,
    ) => {
      const validators: Validator<DateRange<TDate>>[] = [];

      if (opt.required) {
        const val = generalValidators.required(opt.messageOptions?.label);

        validators.push((value) => val(value.start) || val(value.end));
      }

      const isDateValidator = base.isDate();

      validators.push(
        (value) => isDateValidator(value.start) || isDateValidator(value.end),
      );

      if (opt.min !== undefined) {
        const minVal = base.min(opt.min as TDate);
        validators.push((value) => minVal(value.start));
      }

      if (opt.max !== undefined) {
        const maxVal = base.max(opt.max as TDate);
        validators.push((value) => maxVal(value.end));
      }

      validators.push((value) => {
        if (value.start === null || value.end === null) return '';

        const minVal = base.min(value.start);
        const maxVal = base.max(value.end);

        return minVal(value.end) || maxVal(value.start);
      });

      return merger(validators);
    },
    util: {
      toDate,
      formatDate,
    },
  };
}
