import { type Validator } from '../validator.type';
import {
  createMustBeEmptyValidator,
  createMustBeValidator,
  defaultMustBeEmptyMessageFactory,
  defaultMustBeMessageFactory,
} from './must-be';
import { createNotValidator, defaultNotMessageFactory } from './not';
import {
  createNotOneOfValidator,
  defaultNotOneOfMessageFactory,
} from './not-one-of';
import { createOneOfValidator, defaultOneOfMessageFactory } from './one-of';
import {
  createRequiredValidator,
  defaultRequiredMessageFactory,
} from './required';

export type GeneralMessageFactories = {
  required: Parameters<typeof createRequiredValidator>[0];
  mustBe: Parameters<typeof createMustBeValidator>[0];
  mustBeNull: Parameters<typeof createMustBeEmptyValidator>[0];
  not: Parameters<typeof createNotValidator>[0];
  oneOf: Parameters<typeof createOneOfValidator>[0];
  notOneOf: Parameters<typeof createNotOneOfValidator>[0];
};

const DEFAULT_MESSAGES: GeneralMessageFactories = {
  required: defaultRequiredMessageFactory,
  mustBe: defaultMustBeMessageFactory,
  mustBeNull: defaultMustBeEmptyMessageFactory,
  not: defaultNotMessageFactory,
  oneOf: defaultOneOfMessageFactory,
  notOneOf: defaultNotOneOfMessageFactory,
};

/**
 * Represents the consolidated object containing all available validator generators,
 * configured with appropriate localization and date handling for the specified `TDate` type.
 *
 * Obtain this object using `injectValidators()` within an Angular injection context.
 * Use the nested `.all()` methods (e.g., `validators.string.all({...})`) with their
 * corresponding options types (e.g., `StringValidatorOptions`) to create combined
 * validator functions for your form controls.
 *
 * Individual validators (e.g., `validators.general.required()`) are also available.
 *
 * @template TDate The type used for date values (e.g., Date, Luxon DateTime). Defaults to `Date`.
 */
export function createGeneralValidators(
  factories?: Partial<GeneralMessageFactories>,
) {
  const t = { ...DEFAULT_MESSAGES, ...factories };

  const mustBeNull = createMustBeEmptyValidator(t.mustBeNull);

  return {
    required: createRequiredValidator(t.required),
    mustBe: createMustBeValidator(t.mustBe),
    mustBeNull: createMustBeEmptyValidator(t.mustBeNull),
    not: createNotValidator(t.not),
    oneOf: <T>(
      values: T[],
      toLabel?: (value: T) => string,
      identity?: (a: T) => string,
      delimiter?: string,
    ): Validator<T> => {
      if (!values.length) return mustBeNull<T>();

      return createOneOfValidator(t.oneOf)(
        values,
        toLabel,
        identity,
        delimiter,
      );
    },
    notOneOf: createNotOneOfValidator(t.notOneOf),
  };
}
