import { ResourceRef } from '@angular/core';

export function toResourceObject<T>(res: ResourceRef<T>): ResourceRef<T> {
  return {
    asReadonly: () => res.asReadonly(),
    destroy: () => res.destroy(),
    error: res.error,
    isLoading: res.isLoading,
    status: res.status,
    value: res.value,
    reload: () => res.reload(),
    hasValue: (() => res.hasValue()) as ResourceRef<T>['hasValue'],
    set: (v) => res.set(v),
    update: (v) => res.update(v),
  };
}
