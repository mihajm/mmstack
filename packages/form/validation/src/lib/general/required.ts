import { type Validator } from '../validator.type';

export function defaultRequiredMessageFactory(label = 'Field') {
  return `${label} is required`;
}

export function createRequiredValidator(
  createMsg: (label?: string) => string,
): <T>(label?: string) => Validator<T> {
  return (label = 'Field') => {
    const msg = createMsg(label);

    return (value) => {
      if (typeof value === 'number' || typeof value === 'boolean') return '';
      if (!value) return msg;
      return '';
    };
  };
}
