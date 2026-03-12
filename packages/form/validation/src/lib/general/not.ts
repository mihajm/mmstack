import { type Validator } from '../validator.type';

export function defaultNotMessageFactory(valueLabel: string) {
  return `Cannot be ${valueLabel}`;
}

export function createNotValidator(
  createMessage: (valueLabel: string) => string,
) {
  return <T>(
    value: T,
    valueLabel = `${value}`,
    matcher: (a: T, b: T) => boolean = Object.is,
  ): Validator<T> => {
    const msg = createMessage(valueLabel);

    return (currentValue) => {
      if (matcher(value, currentValue)) return msg;
      return '';
    };
  };
}
