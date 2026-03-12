import { type Validator } from '../validator.type';

const URI_REGEXP = /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/;

export function defaultURIMessageFactory() {
  return `Must be a valid URI`;
}

export function createURIValidator(
  createMsg: () => string,
): () => Validator<string | null> {
  return () => {
    const msg = createMsg();

    return (value) => {
      if (value === null) return '';
      if (!URI_REGEXP.test(value)) return msg;
      return '';
    };
  };
}
