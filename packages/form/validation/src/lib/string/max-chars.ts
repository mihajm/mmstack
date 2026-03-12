import {
  createMaxLengthValidator as arrayCreateMaxValidator,
  defaultMaxLengthMessageFactory as arrayDefaultMessageFactory,
} from '../array/max-length';
import { type Validator } from '../validator.type';

export function defaultMaxLengthMessageFactory(max: number) {
  return arrayDefaultMessageFactory(max, 'characters');
}

export function createMaxLengthValidator(
  createMsg: (max: number) => string,
): (max: number) => Validator<string | null> {
  return arrayCreateMaxValidator((max) => createMsg(max));
}
