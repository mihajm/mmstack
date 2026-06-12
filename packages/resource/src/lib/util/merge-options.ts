import type { CircuitBreakerOptions } from './circuit-breaker';
import type { RefreshOptions } from './refresh';
import type { RetryOptions } from './retry-on-error';
import type { ResourceCacheOptions } from '../options';

/**
 * Deep merges multiple circuit breaker options.
 * The latter options override the former.
 */
export function mergeCircuitBreakerOptions(
  global?: CircuitBreakerOptions | true,
  query?: CircuitBreakerOptions | true,
  local?: CircuitBreakerOptions | true,
): CircuitBreakerOptions | true | undefined {
  if (!global && !query && !local) return undefined;
  return {
    ...(global === true ? {} : global),
    ...(query === true ? {} : query),
    ...(local === true ? {} : local),
  };
}

/**
 * Deep merges multiple retry options.
 * The latter options override the former.
 */
export function mergeRetryOptions(
  global?: RetryOptions | number,
  query?: RetryOptions | number,
  local?: RetryOptions | number,
): RetryOptions | number | undefined {
  if (global === undefined && query === undefined && local === undefined) return undefined;
  return {
    ...(typeof global === 'number' ? { max: global } : global),
    ...(typeof query === 'number' ? { max: query } : query),
    ...(typeof local === 'number' ? { max: local } : local),
  };
}

/**
 * Deep merges multiple cache options.
 * The latter options override the former.
 */
export function mergeCacheOptions(
  query?: ResourceCacheOptions,
  local?: ResourceCacheOptions
): ResourceCacheOptions | undefined {
  if (query === undefined && local === undefined) return undefined;
  return {
    ...(query === true ? {} : query),
    ...(local === true ? {} : local),
  };
}

/**
 * Deep merges multiple refresh options.
 * The latter options override the former.
 */
export function mergeRefreshOptions(
  query?: RefreshOptions | number,
  local?: RefreshOptions | number
): RefreshOptions | number | undefined {
  if (query === undefined && local === undefined) return undefined;
  return {
    ...(typeof query === 'number' ? { interval: query } : query),
    ...(typeof local === 'number' ? { interval: local } : local),
  };
}
