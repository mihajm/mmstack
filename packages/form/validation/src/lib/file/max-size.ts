import { isDevMode } from '@angular/core';
import { Validator } from '../validator.type';

const KNOWN_SIZE_TYPES = [
  'b',
  'kb',
  'mb',
  'gb',
  'B',
  'KB',
  'MB',
  'GB',
] as const;

export type KnownSizeType = (typeof KNOWN_SIZE_TYPES)[number];

export function defaultMaxSizeMessageFactory(
  max: number,
  type: KnownSizeType = 'b',
) {
  return `Max size ${max} ${type}`;
}

const MULTIPLIERS: Partial<Record<KnownSizeType, number>> = {
  b: 1,
  B: 1,
  kb: 1024,
  KB: 1024,
  mb: 1024 * 1024,
  MB: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

function getSizeInBytes(size: number, type: KnownSizeType) {
  const multiplier = MULTIPLIERS[type];
  if (multiplier === undefined && isDevMode()) {
    console.error(
      `Unknown size type "${type}". Expected one of: ${KNOWN_SIZE_TYPES.join(', ')}`,
    );
  }
  return size * (multiplier ?? 1);
}

export function createMaxSizeValidator(
  createMsg: (max: number, type?: KnownSizeType) => string,
): <T extends File | null>(max: number, type?: KnownSizeType) => Validator<T> {
  return (max, type = 'b') => {
    const sizeInBytes = getSizeInBytes(max, type);
    const msg = createMsg(max, type);

    return (value) => {
      if (!value) return '';
      const fileSize = value.size;
      if (fileSize > sizeInBytes) return msg;
      return '';
    };
  };
}
