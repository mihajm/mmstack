import {
  Signal,
  type WritableSignal,
  isWritableSignal as assertion,
} from '@angular/core';

export function isWritableSignal<T>(
  value: Signal<T>,
): value is WritableSignal<T> {
  return assertion(value);
}
