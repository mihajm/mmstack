import { type HttpHeaders, type HttpResourceRef } from '@angular/common/http';
import { type ValueEqualityFn } from '@angular/core';
import { keepPrevious } from '@mmstack/primitives';

/**
 * The `keepPrevious` seam: `value`, `headers` and `statusCode` hold their last defined reading
 * across the gaps Angular's resource opens (a new request identity, a disabled request, a fault).
 * `fallback` is what `value` yields before anything was ever held — the resource's `defaultValue`,
 * which must NOT reach Angular under the hold, or it fills every gap before the hold can.
 * `hasValue` follows the held value under Angular's own rule (defined, and not in error), so a
 * transition that reads it stays mounted through a reload instead of re-suspending.
 */
export function persistResourceValues<T>(
  resource: HttpResourceRef<T>,
  shouldPersist = false,
  equal?: ValueEqualityFn<T>,
  fallback?: T,
): HttpResourceRef<T> {
  if (!shouldPersist) return resource;

  const value = keepPrevious<T>(resource.value, { equal, fallback });

  return {
    ...resource,
    statusCode: keepPrevious<number | undefined>(resource.statusCode),
    headers: keepPrevious<HttpHeaders | undefined>(resource.headers),
    value,
    hasValue: (() =>
      resource.status() !== 'error' &&
      value() !== undefined) as HttpResourceRef<T>['hasValue'],
  };
}
