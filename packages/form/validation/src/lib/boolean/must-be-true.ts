import { type Validator } from '../validator.type';

export function defaultMustBeTreFactory() {
  return `Must be true`;
}

export function createMustBeTrueValidator(
  createMsg: () => string,
): () => Validator<boolean> {
  return () => {
    const msg = createMsg();
    return (value) => {
      if (value !== true) return msg;
      return '';
    };
  };
}
