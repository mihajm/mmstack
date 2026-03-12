import { type Validator } from '../validator.type';

const EMAIL_REGEXP =
  /^(?=.{1,254}$)(?=.{1,64}@)[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function defaultEmailMessageFactory() {
  return `Must be a valid email`;
}

export function createEmailValidator(
  createMsg: () => string,
): () => Validator<string | null> {
  return () => {
    const msg = createMsg();

    return (value) => {
      if (value === null) return '';
      if (!EMAIL_REGEXP.test(value)) return msg;
      return '';
    };
  };
}
