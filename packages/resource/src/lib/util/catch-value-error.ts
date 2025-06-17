import { HttpResourceRef } from '@angular/common/http';
import { computed } from '@angular/core';
import { toWritable } from '@mmstack/primitives';

export function catchValueError<T>(
  resource: HttpResourceRef<T>,
  fallback: T,
): HttpResourceRef<T> {
  return {
    ...resource,
    value: toWritable(
      computed(() => {
        try {
          return resource.value();
        } catch {
          return fallback;
        }
      }),
      (value) => resource.value.set(value),
    ),
  };
}
