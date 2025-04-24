import { entries } from './entries';
import { UnknownObject } from './unknown-object.type';

type MappedValue<TOut, TKey extends keyof TOut> = {
  key: TKey;
  value: TOut[TKey] | undefined;
};

type DefinedMappedValue<TOut, TKey extends keyof TOut> = Omit<
  MappedValue<TOut, TKey>,
  'value'
> & {
  value: Exclude<MappedValue<TOut, TKey>['value'], undefined>;
};

export function remap<TIn extends UnknownObject, TOut extends UnknownObject>(
  value: TIn,
  mapper: (
    key: keyof TIn,
    value: TIn[keyof TIn],
  ) => MappedValue<TOut, keyof TOut> | DefinedMappedValue<TOut, keyof TOut>[],
): TOut {
  return entries(value).reduce((acc, [key, value]) => {
    const mapped = mapper(key, value);

    if (Array.isArray(mapped)) {
      mapped.forEach((m) => {
        acc[m.key] = m.value;
      });
    } else if (mapped.value !== undefined) {
      acc[mapped.key] = mapped.value;
    }

    return acc;
  }, {} as TOut);
}
