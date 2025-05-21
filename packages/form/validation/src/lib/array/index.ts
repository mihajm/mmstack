import { createMergeValidators } from '../merge-validators';
import { Validator } from '../validator.type';
import {
  createMaxLengthValidator,
  defaultMaxLengthMessageFactory,
} from './max-length';
import {
  createMinLengthValidator,
  defaultMinLengthMessageFactory,
} from './min-length';

export type ArrayMessageFactories = {
  minLength: Parameters<typeof createMinLengthValidator>[0];
  maxLength: Parameters<typeof createMaxLengthValidator>[0];
};

const DEFAULT_MESSAGES: ArrayMessageFactories = {
  minLength: defaultMinLengthMessageFactory,
  maxLength: defaultMaxLengthMessageFactory,
};

/**
 * Configuration options for creating a combined array validator using the
 * `.all()` method returned by `createArrayValidators` (accessed via `injectValidators().array.all`).
 */
export type ArrayValidatorOptions = {
  /**
   * Minimum allowed array length.
   * Validation fails if the array has fewer elements than this number.
   * @example { minLength: 1 } // Array must not be empty
   */
  minLength?: number;

  /**
   * Maximum allowed array length.
   * Validation fails if the array has more elements than this number.
   * @example { maxLength: 5 } // Array can have at most 5 items
   */
  maxLength?: number;

  /**
   * Optional label for the array elements used in generated error messages
   * (e.g., 'items', 'users', 'tags'). Defaults typically to 'items'.
   * @example { minLength: 2, elementsLabel: 'tags' } // Error might be "Min 2 tags"
   */
  elementsLabel?: string | ((num: number) => string);
};

export function createArrayValidators(
  factories?: Partial<ArrayMessageFactories>,
  merger = createMergeValidators(),
) {
  const t = { ...DEFAULT_MESSAGES, ...factories };
  const base = {
    minLength: createMinLengthValidator(t.minLength),
    maxLength: createMaxLengthValidator(t.maxLength),
  };

  return {
    ...base,
    all: <T extends any[]>(opt: ArrayValidatorOptions) => {
      const validators: Validator<T>[] = [];

      if (opt.minLength !== undefined)
        validators.push(
          base.minLength(
            opt.minLength,
            typeof opt.elementsLabel === 'function'
              ? opt.elementsLabel(opt.minLength)
              : opt.elementsLabel,
          ),
        );
      if (opt.maxLength !== undefined)
        validators.push(
          base.maxLength(
            opt.maxLength,
            typeof opt.elementsLabel === 'function'
              ? opt.elementsLabel(opt.maxLength)
              : opt.elementsLabel,
          ),
        );

      return merger(validators);
    },
  };
}
