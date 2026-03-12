import { type Validator } from '../validator.type';

export function defaultMinLengthMessageFactory(
  min: number,
  elementsLabel?: string,
) {
  return `Min ${min} ${elementsLabel}`;
}

export function createMinLengthValidator(
  createMsg: (min: number, elementsLabel?: string) => string,
): <T extends string | any[] | null>(
  min: number,
  elementsLabel?: string,
) => Validator<T> {
  return (min, elementsLabel = 'items') => {
    const msg = createMsg(min, elementsLabel);
    return (value) => {
      const length = value?.length ?? 0;

      if (length < min) return msg;
      return '';
    };
  };
}
