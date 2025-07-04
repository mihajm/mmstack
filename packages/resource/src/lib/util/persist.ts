import { type HttpHeaders, type HttpResourceRef } from '@angular/common/http';
import {
  linkedSignal,
  type Signal,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';

function presist<T>(
  value: WritableSignal<T>,
  equal?: ValueEqualityFn<T>,
): WritableSignal<T>;

function presist<T>(value: Signal<T>, equal?: ValueEqualityFn<T>): Signal<T>;

function presist<T>(
  src: WritableSignal<T> | Signal<T>,
  equal?: ValueEqualityFn<T>,
): WritableSignal<T> | Signal<T> {
  // linkedSignal allows us to access previous source value

  const persisted = linkedSignal<T, T>({
    source: () => src(),
    computation: (next, prev) => {
      if (next === undefined && prev !== undefined) return prev.value;
      return next;
    },
    equal,
  });

  // if original value was WritableSignal then override linkedSignal methods to original...angular uses linkedSignal under the hood in ResourceImpl, this applies to that.
  if ('set' in src) {
    persisted.set = src.set;
    persisted.update = src.update;
    persisted.asReadonly = src.asReadonly;
  }

  return persisted;
}

export function persistResourceValues<T>(
  resource: HttpResourceRef<T>,
  persist = false,
  equal?: ValueEqualityFn<T>,
): HttpResourceRef<T> {
  if (!persist) return resource;

  return {
    ...resource,
    statusCode: presist<number | undefined>(resource.statusCode),
    headers: presist<HttpHeaders | undefined>(resource.headers),
    value: presist<T>(resource.value, equal),
  };
}
