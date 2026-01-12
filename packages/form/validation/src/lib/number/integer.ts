import { Validator } from '../validator.type';

export function defaultIntegerMessageFactory() {
  return `Must be an integer`;
}

export function createIntegerValidator(
  createMsg: () => string,
): () => Validator<number | null> {
  return () => {
    const msg = createMsg();
    return (value) => {
      if (value === null || value === undefined) return '';
      if (!Number.isInteger(value)) return msg;
      return '';
    };
  };
}
