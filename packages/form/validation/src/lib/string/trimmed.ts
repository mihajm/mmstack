import { type Validator } from '../validator.type';

export function defaultTrimmedMessageFactory() {
  return `Cannot contain leading or trailing whitespace`;
}

export function createTrimmedValidator(
  createMsg: () => string,
): () => Validator<string | null> {
  return () => {
    const msg = createMsg();

    return (value) => {
      if (value === null) return '';
      if (value.trim().length !== value.length) return msg;
      return '';
    };
  };
}
