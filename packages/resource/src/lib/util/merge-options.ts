import type { CircuitBreaker, CircuitBreakerOptions } from './circuit-breaker';
import type { RefreshOptions } from './refresh';
import type { RetryOptions } from './retry-on-error';
import type { ResourceCacheOptions } from '../options';

function isCircuitBreaker(
  opt: CircuitBreakerOptions | true | undefined,
): opt is CircuitBreaker {
  return typeof opt === 'object' && 'isClosed' in opt;
}

/**
 * Deep merges multiple circuit breaker options.
 * The latter options override the former: `false` turns the breaker off, a
 * `CircuitBreaker` instance is used as is, and option objects merge field by field.
 */
export function mergeCircuitBreakerOptions(
  global?: CircuitBreakerOptions | true,
  query?: CircuitBreakerOptions | true,
  local?: CircuitBreakerOptions | true,
): CircuitBreakerOptions | undefined {
  let merged: CircuitBreakerOptions | undefined;
  for (const layer of [global, query, local]) {
    if (layer === undefined) continue;
    if (layer === false || isCircuitBreaker(layer)) merged = layer;
    else if (layer === true) {
      if (!merged || isCircuitBreaker(merged)) merged = {};
    } else
      merged = {
        ...(merged && !isCircuitBreaker(merged) ? merged : {}),
        ...layer,
      };
  }
  return merged;
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
  if (global === undefined && query === undefined && local === undefined)
    return undefined;
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
  local?: ResourceCacheOptions,
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
  local?: RefreshOptions | number,
): RefreshOptions | number | undefined {
  if (query === undefined && local === undefined) return undefined;
  return {
    ...(typeof query === 'number' ? { interval: query } : query),
    ...(typeof local === 'number' ? { interval: local } : local),
  };
}
