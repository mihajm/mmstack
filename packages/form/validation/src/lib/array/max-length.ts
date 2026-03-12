import { type Validator } from '../validator.type';

export function defaultMaxLengthMessageFactory(
  max: number,
  elementsLabel?: string,
) {
  return `Max ${max} ${elementsLabel}`;
}

export function createMaxLengthValidator(
  createMsg: (max: number, elementsLabel?: string) => string,
): <T extends string | any[] | null>(
  max: number,
  elementsLabel?: string,
) => Validator<T> {
  return (max, elementsLabel = 'items') => {
    const msg = createMsg(max, elementsLabel);
    return (value) => {
      const length = value?.length ?? 0;

      if (length > max) return msg;
      return '';
    };
  };
}
