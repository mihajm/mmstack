import { entries } from '@mmstack/object';
import { UnknownStringKeyObject } from './types';

function isTranslationObject(t: unknown): t is UnknownStringKeyObject {
  return typeof t === 'object' && t !== null;
}

export const KEY_DELIM = '::T_DELIM::';

export function flattenTranslation<T extends UnknownStringKeyObject>(obj: T) {
  return Object.entries(obj).reduce(
    (acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = value;
      } else if (isTranslationObject(value)) {
        entries(flattenTranslation(value)).forEach(
          ([nestedKey, nestedValue]) => {
            acc[`${key}${KEY_DELIM}${nestedKey}`] = nestedValue;
          },
        );
      }

      return acc;
    },
    {} as Record<string, string>,
  );
}
