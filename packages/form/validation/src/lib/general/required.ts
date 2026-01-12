import { Validator } from '../validator.type';

export function defaultRequiredMessageFactory(label = 'Field') {
  return `${label} is required`;
}

function noNumber(value: number) {
  return value === null || value === undefined;
}

export function createRequiredValidator(
  createMsg: (label?: string) => string,
): <T>(label?: string) => Validator<T> {
  return (label = 'Field') => {
    const msg = createMsg(label);

    return (value) => {
      if (typeof value === 'number' && noNumber(value)) return msg;
      if (!value) return msg;
      return '';
    };
  };
}
