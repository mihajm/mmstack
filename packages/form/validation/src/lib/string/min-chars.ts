import {
  createMinLengthValidator as arrayCreateMinValidator,
  defaultMinLengthMessageFactory as arrayDefaultMessageFactory,
} from '../array/min-length';
import { type Validator } from '../validator.type';

export function defaultMinLengthMessageFactory(min: number) {
  return arrayDefaultMessageFactory(min, 'characters');
}

export function createMinLengthValidator(
  createMsg: (min: number) => string,
): (min: number) => Validator<string | null> {
  return arrayCreateMinValidator((min) => createMsg(min));
}
