import { Validator } from '../validator.type';

export function defaultRejectsMessage(rejects: string[]) {
  return `Must not be: ${rejects.join(', ')}`;
}

export function createRejectsValidator(
  createMsg: (rejects: string[]) => string,
): <T extends File | null>(rejects: string[]) => Validator<T> {
  return (rejects) => {
    const lcs = rejects.map((a) => a.toLowerCase());
    const wildcards = lcs
      .filter((a) => a.endsWith('/*'))
      .map((a) => a.slice(0, -1)); // image/* video/* -> image/ video/
    const nonWildcards = new Set(lcs.filter((a) => !a.endsWith('/*')));

    const msg = createMsg(rejects);

    return (value) => {
      if (!value) return '';
      const mimeType = value.type.toLowerCase();

      if (nonWildcards.has(mimeType)) return msg;
      if (wildcards.length && wildcards.some((a) => mimeType.startsWith(a)))
        return msg;

      return '';
    };
  };
}
