import {
  mergeCircuitBreakerOptions,
  mergeRetryOptions,
  mergeCacheOptions,
  mergeRefreshOptions,
} from './merge-options';
import { describe, it, expect } from 'vitest';

describe('merge-options', () => {
  describe('mergeCircuitBreakerOptions', () => {
    it('returns undefined if all undefined', () => {
      expect(mergeCircuitBreakerOptions(undefined, undefined, undefined)).toBeUndefined();
    });

    it('returns an empty object if any is true and others are undefined', () => {
      expect(mergeCircuitBreakerOptions(true, undefined, undefined)).toEqual({});
      expect(mergeCircuitBreakerOptions(undefined, true, undefined)).toEqual({});
    });

    it('merges multiple true values into an empty object', () => {
      expect(mergeCircuitBreakerOptions(true, true, true)).toEqual({});
    });

    it('merges an object with true', () => {
      expect(mergeCircuitBreakerOptions(true, { timeout: 1000 })).toEqual({ timeout: 1000 });
      expect(mergeCircuitBreakerOptions({ timeout: 1000 }, true)).toEqual({ timeout: 1000 });
    });

    it('deep merges multiple objects with later overriding earlier', () => {
      expect(
        mergeCircuitBreakerOptions(
          { timeout: 1000, threshold: 3 },
          { threshold: 5 },
          { timeout: 5000 }
        )
      ).toEqual({ timeout: 5000, threshold: 5 });
    });
  });

  describe('mergeRetryOptions', () => {
    it('returns undefined if all undefined', () => {
      expect(mergeRetryOptions(undefined, undefined, undefined)).toBeUndefined();
    });

    it('returns a max object if a number is passed', () => {
      expect(mergeRetryOptions(3, undefined, undefined)).toEqual({ max: 3 });
      expect(mergeRetryOptions(undefined, 5, undefined)).toEqual({ max: 5 });
    });

    it('merges objects and numbers, latter overrides former', () => {
      expect(mergeRetryOptions(3, { backoff: 100 })).toEqual({ max: 3, backoff: 100 });
      expect(mergeRetryOptions({ max: 5, backoff: 100 }, 2)).toEqual({ max: 2, backoff: 100 });
    });
  });

  describe('mergeCacheOptions', () => {
    it('returns undefined if all undefined', () => {
      expect(mergeCacheOptions(undefined, undefined)).toBeUndefined();
    });

    it('merges true into an empty object functionally representing true', () => {
      expect(mergeCacheOptions(true, true)).toEqual({});
    });

    it('merges an object with true', () => {
      expect(mergeCacheOptions(true, { ttl: 5000 })).toEqual({ ttl: 5000 });
      expect(mergeCacheOptions({ ttl: 5000 }, true)).toEqual({ ttl: 5000 });
    });

    it('deep merges multiple objects with later overriding earlier', () => {
      expect(mergeCacheOptions({ ttl: 5000 }, { staleTime: 1000 })).toEqual({ ttl: 5000, staleTime: 1000 });
      expect(mergeCacheOptions({ ttl: 5000 }, { ttl: 1000 })).toEqual({ ttl: 1000 });
    });
  });

  describe('mergeRefreshOptions', () => {
    it('returns undefined if all undefined', () => {
      expect(mergeRefreshOptions(undefined, undefined)).toBeUndefined();
    });

    it('returns interval object if a number is passed', () => {
      expect(mergeRefreshOptions(1000, undefined)).toEqual({ interval: 1000 });
      expect(mergeRefreshOptions(undefined, 2000)).toEqual({ interval: 2000 });
    });

    it('merges objects and numbers, latter overrides former', () => {
      expect(mergeRefreshOptions(1000, { onFocus: true })).toEqual({ interval: 1000, onFocus: true });
      expect(mergeRefreshOptions({ interval: 5000, onFocus: true }, 2000)).toEqual({ interval: 2000, onFocus: true });
    });
  });
});
