import { createGeneralValidators } from '../general';
import { createMergeValidators } from '../merge-validators';
import { Validator } from '../validator.type';
import {
  createIntegerValidator,
  defaultIntegerMessageFactory,
} from './integer';
import {
  createIsNumberValidator,
  defaultIsNumberMessageFactory,
} from './is-number';
import { createMaxValidator, defaultMaxMessageFactory } from './max';
import { createMinValidator, defaultMinMessageFactory } from './min';
import {
  createMultipleOfValidator,
  defaultMultipleOfMessageFactory,
} from './multiple-of';

export type NumberMessageFactories = {
  min: Parameters<typeof createMinValidator>[0];
  max: Parameters<typeof createMaxValidator>[0];
  isNumber: Parameters<typeof createIsNumberValidator>[0];
  multipleOf: Parameters<typeof createMultipleOfValidator>[0];
  integer: Parameters<typeof createIntegerValidator>[0];
};

const DEFAULT_MESSAGES: NumberMessageFactories = {
  min: defaultMinMessageFactory,
  max: defaultMaxMessageFactory,
  isNumber: defaultIsNumberMessageFactory,
  multipleOf: defaultMultipleOfMessageFactory,
  integer: defaultIntegerMessageFactory,
};

/**
 * Configuration options for creating a combined number validator using the `.all()`
 * method returned by `createNumberValidators` (accessed via `injectValidators().number.all`).
 *
 * Pass an object of this type to `validators.number.all({...})` to specify which
 * number-related validations should be included in the resulting validator function.
 * The validation function returned by `.all()` expects an input value of type `number | null`.
 */
export type NumberValidatorOptions = {
  /**
   * If `true`, the number value must not be `null` or `undefined`.
   * Uses the configured 'required' validation message.
   * @see Validators.general.required
   * @example { required: true }
   */
  required?: boolean;

  /**
   * Specifies the minimum allowed value (inclusive).
   * Validation fails if the input number is strictly less than `min`.
   * Uses the configured 'min number' validation message.
   * @example { min: 0 } // Number must be 0 or greater
   * @see Validators.number.min
   */
  min?: number;

  /**
   * Specifies the maximum allowed value (inclusive).
   * Validation fails if the input number is strictly greater than `max`.
   * Uses the configured 'max number' validation message.
   * @example { max: 100 } // Number must be 100 or less
   * @see Validators.number.max
   */
  max?: number;

  /**
   * If `true`, the number value must be an integer (i.e., have no fractional part).
   * Uses the configured 'integer' validation message.
   * Note: `null` or `undefined` values typically pass this check; combine with `required: true` if needed.
   * @example { integer: true }
   * @see Validators.number.integer
   */
  integer?: boolean;

  /**
   * The number value must be a multiple of the specified number (`multipleOf`).
   * For example, if `multipleOf` is 5, valid numbers are 0, 5, 10, -5, etc.
   * Uses the configured 'multipleOf' validation message.
   * Note: `null` or `undefined` values typically pass this check.
   * @example { multipleOf: 5 } // Must be a multiple of 5
   * @example { multipleOf: 0.01 } // Useful for currency (max 2 decimal places)
   * @see Validators.number.multipleOf
   */
  multipleOf?: number;

  /**
   * The number value must be exactly equal to the specified value (or `null`).
   * Uses the configured `mustBe` validation message.
   * @example { mustBe: 42 } // Must be exactly 42
   * @example { mustBe: null } // Must be exactly null
   * @see Validators.general.mustBe
   * @see Validators.general.mustBeNull
   */
  mustBe?: number | null;

  /**
   * The number value must *not* be equal to the specified value (or `null`).
   * Uses the configured `not` validation message.
   * @example { not: 0 } // Cannot be zero
   * @see Validators.general.not
   */
  not?: number | null;

  /**
   * The number value must be one of the numbers (or `null`) included in the specified array.
   * Uses the configured `oneOf` validation message.
   * @example { oneOf: [1, 3, 5, null] } // Must be 1, 3, 5, or null
   * @see Validators.general.oneOf
   */
  oneOf?: (number | null)[];

  /**
   * The number value must *not* be any of the numbers (or `null`) included in the specified array.
   * Uses the configured `notOneOf` validation message.
   * @example { notOneOf: [0, 13] } // Cannot be 0 or 13
   * @see Validators.general.notOneOf
   */
  notOneOf?: (number | null)[];

  /**
   * Optional custom validation function
   */
  custom?: (value: number | null) => string;

  /**
   * Optional configuration passed down to specific message factories.
   * Primarily used by the `required` validator's message factory.
   */
  messageOptions?: {
    /**
     * An optional label for the field (e.g., 'Age', 'Quantity')
     * which can be incorporated into the 'required' error message by its factory.
     * @example { required: true, messageOptions: { label: 'Quantity' } } // Error might be "Quantity is required"
     */
    label?: string;
  };
};

export function createNumberValidators(
  factories?: Partial<NumberMessageFactories>,
  generalValidators = createGeneralValidators(),
  merger = createMergeValidators(),
) {
  const t = { ...DEFAULT_MESSAGES, ...factories };

  const base = {
    min: createMinValidator(t.min),
    max: createMaxValidator(t.max),
    isNumber: createIsNumberValidator(t.isNumber),
    multipleOf: createMultipleOfValidator(t.multipleOf),
    integer: createIntegerValidator(t.integer),
  };

  return {
    ...base,
    all: (opt: NumberValidatorOptions) => {
      const validators: Validator<number | null>[] = [];

      if (opt.required)
        validators.push(generalValidators.required(opt.messageOptions?.label));

      validators.push(base.isNumber());

      if (opt.mustBe !== undefined)
        validators.push(generalValidators.mustBe(opt.mustBe));

      if (opt.not !== undefined)
        validators.push(generalValidators.not(opt.not));

      if (opt.integer) validators.push(base.integer());

      if (opt.min !== undefined) validators.push(base.min(opt.min));

      if (opt.max !== undefined) validators.push(base.max(opt.max));

      if (opt.multipleOf !== undefined)
        validators.push(base.multipleOf(opt.multipleOf));

      if (opt.oneOf) validators.push(generalValidators.oneOf(opt.oneOf));

      if (opt.notOneOf)
        validators.push(generalValidators.notOneOf(opt.notOneOf));

      if (opt.custom) validators.push(opt.custom);

      return merger(validators);
    },
  };
}
