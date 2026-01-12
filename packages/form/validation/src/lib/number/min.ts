import { Validator } from '../validator.type';

export function defaultMinMessageFactory(min: number) {
  return `Must be at least ${min}`;
}

export function createMinValidator(
  createMsg: (min: number) => string,
): (min: number) => Validator<number | null> {
  return (min) => {
    const msg = createMsg(min);
    return (value) => {
      if (value === null || value === undefined) return '';
      if (value < min) return msg;
      return '';
    };
  };
}
