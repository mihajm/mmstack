import { Validator } from '../validator.type';

export function defaultMultipleOfMessageFactory(multipleOf: number) {
  return `Must be a multiple of ${multipleOf}`;
}

export function createMultipleOfValidator(
  createMsg: (multipleOf: number) => string,
): (multipleOf: number) => Validator<number | null> {
  return (multipleOf) => {
    const msg = createMsg(multipleOf);

    return (value) => {
      if (value === null || value === undefined) return '';
      if (value % multipleOf !== 0) return msg;
      return '';
    };
  };
}
