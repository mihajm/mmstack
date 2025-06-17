import { HttpResourceRef } from '@angular/common/http';

export function toResourceObject<T>(
  res: HttpResourceRef<T>,
): HttpResourceRef<T> {
  return {
    asReadonly: () => res.asReadonly(),
    destroy: () => res.destroy(),
    error: res.error,
    headers: res.headers,
    isLoading: res.isLoading,
    progress: res.progress,
    status: res.status,
    statusCode: res.statusCode,
    value: res.value,
    reload: () => res.reload(),
    hasValue: (() => res.hasValue()) as HttpResourceRef<T>['hasValue'],
    set: (v) => res.set(v),
    update: (v) => res.update(v),
  };
}
