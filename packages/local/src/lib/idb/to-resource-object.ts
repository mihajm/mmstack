import {
  computed,
  type ResourceRef,
  type Signal,
  type WritableSignal,
} from '@angular/core';

function toWritable<T>(
  sig: Signal<T>,
  set: (value: T) => void,
  update: (updater: (value: T) => T) => void,
): WritableSignal<T> {
  const writable = sig as WritableSignal<T>;

  writable.set = set;
  writable.update = update;
  writable.asReadonly = () => sig;

  return writable;
}

export function toResourceObject<T>(
  res: ResourceRef<T>,
  fallback?: T,
): ResourceRef<T> {
  const set: ResourceRef<T>['set'] = (v) => res.set(v);
  const update: ResourceRef<T>['update'] = (u) => res.update(u);

  return {
    asReadonly: () => res.asReadonly(),
    destroy: () => res.destroy(),
    error: res.error,
    isLoading: res.isLoading,
    status: res.status,
    value: toWritable(
      computed(() => {
        try {
          return res.value();
        } catch {
          return fallback as T;
        }
      }),
      set,
      update,
    ),
    reload: () => res.reload(),
    hasValue: (() => res.hasValue()) as ResourceRef<T>['hasValue'],
    set,
    update,
  };
}
