import { Validator } from '../validator.type';

export function defaultMaxMessageFactory(max: number) {
  return `Must be at most ${max}`;
}

export function createMaxValidator(
  createMsg: (max: number) => string,
): (max: number) => Validator<number | null> {
  return (max) => {
    const msg = createMsg(max);
    return (value) => {
      if (value === null || value === undefined) return '';
      if (value > max) return msg;
      return '';
    };
  };
}
