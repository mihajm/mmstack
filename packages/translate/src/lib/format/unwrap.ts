import { isSignal, type Signal } from '@angular/core';

export function unwrap<T>(value: T | Signal<T>): T {
  return isSignal(value) ? value() : value;
}
