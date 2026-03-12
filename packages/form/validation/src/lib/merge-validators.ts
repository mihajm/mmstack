import { type Validator } from './validator.type';

const INTERNAL_ERROR_MERGE_DELIM = '::INTERNAL_MMSTACK_MERGE_DELIM::';

export function defaultMergeMessage(errors: string[]): {
  error: string;
  tooltip: string;
} {
  const first = errors.at(0);

  if (!first)
    return {
      error: '',
      tooltip: '',
    };

  if (errors.length === 1) {
    if (first.length > 60) {
      return {
        error: `${first.slice(0, 60)}...`,
        tooltip: first,
      };
    }

    return {
      error: first,
      tooltip: '',
    };
  }

  if (first.length > 40) {
    return {
      error: `${first.slice(0, 40)}..., +${errors.length - 1} issues`,
      tooltip: errors.join('\n'),
    };
  }

  return {
    error: `${first}, +${errors.length - 1} issues`,
    tooltip: errors.join('\n'),
  };
}

function toTooltipFn(
  merge: (errors: string[]) => string | { tooltip: string; error: string },
) {
  return (errors: string[]) => {
    const result = merge(errors);
    if (typeof result === 'string') {
      return {
        error: result,
        tooltip: '',
        merged: errors.join(INTERNAL_ERROR_MERGE_DELIM),
      };
    }

    return result;
  };
}

export function mergeValidators<T>(
  ...validators: Validator<T>[]
): (value: T) => string[] {
  if (!validators.length) return () => [];

  return (value) => validators.map((val) => val(value)).filter(Boolean);
}

type MergeFn<T> = ((value: T) => string) & {
  resolve: (mergedError: string) => {
    error: string;
    tooltip: string;
  };
};

export function createMergeValidators(
  merge?: (errors: string[]) =>
    | string
    | {
        tooltip: string;
        error: string;
      },
) {
  const mergeFn = merge ? toTooltipFn(merge) : defaultMergeMessage;

  return <T>(validators: Validator<T>[]) => {
    const validate = mergeValidators(...validators);

    const fn = ((value: T) =>
      validate(value).join(INTERNAL_ERROR_MERGE_DELIM)) as MergeFn<T>;

    fn.resolve = (mergedError: string) => {
      return mergeFn(mergedError.split(INTERNAL_ERROR_MERGE_DELIM));
    };

    return fn;
  };
}
