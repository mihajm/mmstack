import { type HttpHeaders, type HttpResourceRef } from '@angular/common/http';
import { type ValueEqualityFn } from '@angular/core';
import { keepPrevious } from '@mmstack/primitives';

export function persistResourceValues<T>(
  resource: HttpResourceRef<T>,
  shouldPersist = false,
  equal?: ValueEqualityFn<T>,
): HttpResourceRef<T> {
  if (!shouldPersist) return resource;

  return {
    ...resource,
    statusCode: keepPrevious<number | undefined>(resource.statusCode),
    headers: keepPrevious<HttpHeaders | undefined>(resource.headers),
    value: keepPrevious<T>(resource.value, { equal }),
  };
}
