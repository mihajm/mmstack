import { type Validator } from '../validator.type';

export function defaultOneOfMessageFactory(values: string) {
  return `Must be one of: ${values}`;
}

function defaultToLabel<T>(value: T): string {
  return `${value}`;
}

export function createOneOfValidator(
  createMessage: (values: string) => string,
) {
  return <T>(
    values: T[],
    toLabel: (value: T) => string = defaultToLabel,
    identity: (a: T) => string = defaultToLabel,
    delimiter = ', ',
  ): Validator<T> => {
    const valuesLabel = values.map(toLabel).join(delimiter);
    const msg = createMessage(valuesLabel);

    const map = new Map(values.map((v) => [identity(v), v]));

    return (currentValue) => {
      if (!map.has(identity(currentValue))) return msg;
      return '';
    };
  };
}
