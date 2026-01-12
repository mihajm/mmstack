import { Validator } from '../validator.type';

export function defaultIsNumberMessageFactory() {
  return `Must be a number`;
}

export function createIsNumberValidator(
  createMsg: () => string,
): () => Validator<number | null> {
  return () => {
    const msg = createMsg();
    return (value) => {
      if (value === null || value === undefined) return '';
      if (typeof value !== 'number' || isNaN(value)) return msg;
      return '';
    };
  };
}
