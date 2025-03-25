import { Validator } from '../validator.type';

export function defaultIsDateMessageFactory() {
  return `Must be a valid date`;
}

export function createIsDateValidator<TDate = Date>(
  createMsg: () => string,
  toDate: (date: TDate | string) => Date,
): () => Validator<TDate | string | null> {
  return () => {
    const msg = createMsg();
    return (value) => {
      if (value === null) return '';

      const date = toDate(value);
      if (isNaN(date.getTime())) return msg;

      return '';
    };
  };
}
