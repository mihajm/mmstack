import { createGeneralValidators } from '../general';
import { createMergeValidators } from '../merge-validators';
import { Validator } from '../validator.type';
import { createEmailValidator, defaultEmailMessageFactory } from './email';
import {
  createIsStringValidator,
  defaultIsStringMessageFactory,
} from './is-string';
import {
  createMaxLengthValidator,
  defaultMaxLengthMessageFactory,
} from './max-chars';
import {
  createMinLengthValidator,
  defaultMinLengthMessageFactory,
} from './min-chars';
import {
  createPatternValidator,
  defaultPatternMessageFactory,
} from './pattern';
import {
  createTrimmedValidator,
  defaultTrimmedMessageFactory,
} from './trimmed';
import { createURIValidator, defaultURIMessageFactory } from './uri';

export type StringMessageFactories = {
  email: Parameters<typeof createEmailValidator>[0];
  uri: Parameters<typeof createURIValidator>[0];
  pattern: Parameters<typeof createPatternValidator>[0];
  trimmed: Parameters<typeof createTrimmedValidator>[0];
  isString: Parameters<typeof createIsStringValidator>[0];
  minLength: Parameters<typeof createMinLengthValidator>[0];
  maxLength: Parameters<typeof createMaxLengthValidator>[0];
};

const DEFAULT_MESSAGES: StringMessageFactories = {
  email: defaultEmailMessageFactory,
  uri: defaultURIMessageFactory,
  pattern: defaultPatternMessageFactory,
  trimmed: defaultTrimmedMessageFactory,
  isString: defaultIsStringMessageFactory,
  minLength: defaultMinLengthMessageFactory,
  maxLength: defaultMaxLengthMessageFactory,
};

/**
 * Configuration options for creating a combined string validator using the `.all()`
 * method returned by `createStringValidators` (accessed via `injectValidators().string.all`).
 *
 * Pass an object of this type to `validators.string.all({...})` to specify which
 * string-related validations should be included in the resulting validator function.
 * The validation function returned by `.all()` expects an input value of type `string | null`.
 */
export type StringValidatorOptions = {
  /**
   * If `true`, the string value must not be `null`, `undefined`, or an empty string (`''`).
   * Uses the configured 'required' validation message.
   * Note: This behavior (checking for empty string) might differ from a generic `required`
   * check on other types.
   * @see Validators.general.required
   * @example { required: true }
   */
  required?: boolean;

  /**
   * Specifies the minimum allowed length of the string (inclusive).
   * Validation fails if `value.length < minLength`.
   * Note: Behavior with leading/trailing whitespace depends on whether `trimmed` is also used
   * or if the underlying implementation trims by default. Assumed to operate on raw length unless specified otherwise.
   * Uses the configured 'minLength' validation message.
   * @example { minLength: 3 } // Must be at least 3 characters long
   * @see Validators.string.minLength
   */
  minLength?: number;

  /**
   * Specifies the maximum allowed length of the string (inclusive).
   * Validation fails if `value.length > maxLength`.
   * Uses the configured 'maxLength' validation message.
   * @example { maxLength: 50 } // Cannot exceed 50 characters
   * @see Validators.string.maxLength
   */
  maxLength?: number;

  /**
   * If `true`, the string value must not have leading or trailing whitespace.
   * Validation fails if `value !== value.trim()`.
   * Uses the configured 'trimmed' validation message.
   * @example { trimmed: true } // Value like " test " would be invalid
   * @see Validators.string.trimmed
   */
  trimmed?: boolean;

  /**
   * Requires the string to match a specific pattern. Accepts:
   * - A `RegExp` object for custom patterns (e.g., `/^[a-z]+$/i`).
   * - The string literal `'email'` to use a built-in email format validator.
   * - The string literal `'uri'` to use a built-in URI/URL format validator.
   * - Potentially other string representations of regex patterns (implementation dependent).
   * Uses the configured 'pattern', 'email', or 'uri' validation message.
   * @example { pattern: /^\d{3}-\d{2}-\d{4}$/ } // SSN format
   * @example { pattern: 'email' }             // Standard email format
   * @example { pattern: 'uri' }               // Standard URI format
   * @see Validators.string.pattern
   * @see Validators.string.email
   * @see Validators.string.uri
   */
  pattern?: RegExp | 'email' | 'uri' | Omit<string, 'email' | 'uri'>;

  /**
   * The string value must be exactly equal to the specified string (or `null`).
   * Case-sensitive comparison.
   * Uses the configured `mustBe` validation message.
   * @example { mustBe: "CONFIRMED" }
   * @example { mustBe: null }
   * @see Validators.general.mustBe
   * @see Validators.general.mustBeNull
   */
  mustBe?: string | null;

  /**
   * The string value must *not* be equal to the specified string (or `null`).
   * Case-sensitive comparison.
   * Uses the configured `not` validation message.
   * @example { not: "password" } // Cannot be the literal string "password"
   * @see Validators.general.not
   */
  not?: string | null;

  /**
   * The string value must be one of the strings (or `null`) included in the specified array.
   * Case-sensitive comparison.
   * Uses the configured `oneOf` validation message.
   * @example { oneOf: ["PENDING", "APPROVED", "REJECTED", null] }
   * @see Validators.general.oneOf
   */
  oneOf?: (string | null)[];

  /**
   * The string value must *not* be any of the strings (or `null`) included in the specified array.
   * Case-sensitive comparison.
   * Uses the configured `notOneOf` validation message.
   * @example { notOneOf: ["admin", "root"] }
   * @see Validators.general.notOneOf
   */
  notOneOf?: (string | null)[];

  /**
   * Optional custom validation function
   */
  custom?: (value: string | null) => string;

  /**
   * Optional configuration passed down to specific message factories.
   * Primarily used by the `required` validator's message factory.
   */
  messageOptions?: {
    /**
     * An optional label for the field (e.g., 'Username', 'Email Address')
     * which can be incorporated into the 'required' error message by its factory.
     * @example { required: true, messageOptions: { label: 'Email Address' } } // Error might be "Email Address is required"
     */
    label?: string;
  };
};

export function createStringValidators(
  factories?: Partial<StringMessageFactories>,
  generalValidators = createGeneralValidators(),
  merger = createMergeValidators(),
) {
  const t = { ...DEFAULT_MESSAGES, ...factories };

  const base = {
    email: createEmailValidator(t.email),
    uri: createURIValidator(t.uri),
    pattern: createPatternValidator(t.pattern),
    trimmed: createTrimmedValidator(t.trimmed),
    isString: createIsStringValidator(t.isString),
    minLength: createMinLengthValidator(t.minLength),
    maxLength: createMaxLengthValidator(t.maxLength),
  };

  return {
    ...base,
    all: (opt: StringValidatorOptions) => {
      const validators: Validator<string | null>[] = [];

      if (opt.required)
        validators.push(generalValidators.required(opt?.messageOptions?.label));

      validators.push(base.isString());

      if (opt.mustBe !== undefined)
        validators.push(generalValidators.mustBe(opt.mustBe));

      if (opt.not !== undefined)
        validators.push(generalValidators.not(opt.not));

      if (opt.trimmed) validators.push(base.trimmed());

      if (opt.minLength !== undefined)
        validators.push(base.minLength(opt.minLength));

      if (opt.maxLength) validators.push(base.maxLength(opt.maxLength));

      if (opt.pattern) {
        switch (opt.pattern) {
          case 'email':
            validators.push(base.email());
            break;
          case 'uri':
            validators.push(base.uri());
            break;
          default:
            validators.push(base.pattern(opt.pattern as RegExp | string));
            break;
        }
      }

      if (opt.oneOf) validators.push(generalValidators.oneOf(opt.oneOf));

      if (opt.notOneOf)
        validators.push(generalValidators.notOneOf(opt.notOneOf));

      if (opt.custom) validators.push(opt.custom);

      return merger(validators);
    },
  };
}
