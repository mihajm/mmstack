import { type Validator } from '../validator.type';

export function defaultPatternMessageFactory(patternLabel: string) {
  return `Must match pattern ${patternLabel}`;
}

export function createPatternValidator(
  createMsg: (patternLabel: string) => string,
): (pattern: string | RegExp) => Validator<string | null> {
  return (pattern: string | RegExp) => {
    const regex = new RegExp(pattern);
    const msg = createMsg(regex.source);

    return (value) => {
      if (value === null) return '';
      if (!regex.test(value)) return msg;
      return '';
    };
  };
}
