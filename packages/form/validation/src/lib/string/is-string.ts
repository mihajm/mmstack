import { type Validator } from '../validator.type';

export function defaultIsStringMessageFactory() {
  return `Must be a string`;
}

export function createIsStringValidator(
  createMsg: () => string,
): () => Validator<string | null> {
  return () => {
    const msg = createMsg();
    return (value) => {
      if (value === null) return '';
      if (typeof value !== 'string') return msg;
      return '';
    };
  };
}
