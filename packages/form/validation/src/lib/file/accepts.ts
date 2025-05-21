import { Validator } from '../validator.type';

export function defaultAcceptsMessage(accepts: string[]) {
  return `Must be: ${accepts.join(', ')}`;
}

export function createAcceptsValidator(
  createMsg: (accepts: string[]) => string,
): <T extends File | null>(accepts: string[]) => Validator<T> {
  return (accepts) => {
    const lcs = accepts.map((a) => a.toLowerCase());
    const wildcards = lcs
      .filter((a) => a.endsWith('/*'))
      .map((a) => a.slice(0, -1)); // image/* video/* -> image/ video/
    const nonWildcards = new Set(lcs.filter((a) => !a.endsWith('/*')));

    const msg = createMsg(accepts);

    return (value) => {
      if (!value) return '';
      const mimeType = value.type.toLowerCase();

      if (nonWildcards.has(mimeType)) return '';
      if (!wildcards.length) return msg;

      if (wildcards.some((a) => mimeType.startsWith(a))) return '';

      return msg;
    };
  };
}
