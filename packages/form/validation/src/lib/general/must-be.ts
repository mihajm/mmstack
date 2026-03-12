import { type Validator } from '../validator.type';

export function defaultMustBeMessageFactory(valueLabel: string) {
  return `Must be ${valueLabel}`;
}

export function createMustBeValidator(
  createMessage: (valueLabel: string) => string,
) {
  return <T>(
    value: T,
    valueLabel = `${value}`,
    matcher: (a: T, b: T) => boolean = Object.is,
  ): Validator<T> => {
    const msg = createMessage(valueLabel);

    return (currentValue) => {
      if (!matcher(value, currentValue)) return msg;
      return '';
    };
  };
}

export function defaultMustBeEmptyMessageFactory() {
  return defaultMustBeMessageFactory('empty');
}

export function createMustBeEmptyValidator(createMessage: () => string) {
  return <T>() => createMustBeValidator(createMessage)<T>(null as T);
}
