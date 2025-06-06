import { createGeneralValidators } from '../general';
import { createMergeValidators } from '../merge-validators';
import { Validator } from '../validator.type';
import { createAcceptsValidator, defaultAcceptsMessage } from './accepts';
import {
  createMaxSizeValidator,
  defaultMaxSizeMessageFactory,
  KnownSizeType,
} from './max-size';
import { createRejectsValidator, defaultRejectsMessage } from './rejects';

export type FileMessageFactories = {
  accepts: Parameters<typeof createAcceptsValidator>[0];
  rejects: Parameters<typeof createRejectsValidator>[0];
  maxSize: Parameters<typeof createMaxSizeValidator>[0];
};

const DEFAULT_MESSAGES: FileMessageFactories = {
  accepts: defaultAcceptsMessage,
  rejects: defaultRejectsMessage,
  maxSize: defaultMaxSizeMessageFactory,
};

/**
 * Configuration options for creating a combined file validator using the
 * `.all()` method returned by `createFileValidators` (accessed via `injectValidators().file.all`).
 */
export type FileValidatorOptions = {
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
   * The file type(s) that are accepted.
   * Validation fails if the file type is not in this list.
   * Accepts a string or an array of strings.
   * Supports MIME types and generic file types (e.g., 'image/*').
   * @example { accepts: 'image/*' } // Accepts all image types
   * @example { accepts: ['image/png', 'image/jpeg'] } // Accepts PNG and JPEG
   */
  accepts?: string | string[];
  /**
   * The file type(s) that are rejected.
   * Validation fails if the file type is in this list.
   * Accepts a string or an array of strings.
   * Supports MIME types and generic file types (e.g., 'image/*').
   * @example { rejects: 'image/*' } // Rejects all image types
   * @example { rejects: ['image/png', 'image/jpeg'] } // Rejects PNG and JPEG
   */
  rejects?: string | string[];
  /**
   * The maximum allowed file size.
   * Validation fails if the file size exceeds this limit.
   * Accepts a number (in bytes) or an object with `size` and `type` properties.
   * The `type` property can be one of the known size types (e.g., 'MB', 'GB').
   * @example { maxSize: 5 * 1024 * 1024 } // Max size 5 MB
   * @example { maxSize: { size: 1, type: 'GB' } } // Max size 1 GB
   */
  maxSize?:
    | number
    | {
        size: number;
        type: KnownSizeType;
      };

  /**
   * Optional custom validation function
   */
  custom?: (value: File | null) => string;

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

export function createFileValidators(
  factories?: Partial<FileMessageFactories>,
  generalValidators = createGeneralValidators(),
  merger = createMergeValidators(),
) {
  const t = { ...DEFAULT_MESSAGES, ...factories };

  const base = {
    accepts: createAcceptsValidator(t.accepts),
    rejects: createRejectsValidator(t.rejects),
    maxSize: createMaxSizeValidator(t.maxSize),
  };

  return {
    ...base,
    all: (opt: FileValidatorOptions) => {
      const validators: Validator<File | null>[] = [];

      if (opt.required)
        validators.push(generalValidators.required(opt?.messageOptions?.label));

      if (opt.accepts)
        validators.push(
          base.accepts(
            typeof opt.accepts === 'string' ? [opt.accepts] : opt.accepts,
          ),
        );

      if (opt.rejects)
        validators.push(
          base.rejects(
            typeof opt.rejects === 'string' ? [opt.rejects] : opt.rejects,
          ),
        );

      if (opt.maxSize !== undefined) {
        validators.push(
          base.maxSize(
            typeof opt.maxSize === 'number' ? opt.maxSize : opt.maxSize.size,
            typeof opt.maxSize === 'number' ? undefined : opt.maxSize.type,
          ),
        );
      }

      if (opt.custom) validators.push(opt.custom);

      return merger(validators);
    },
  };
}
