import {
  type Signal,
  type WritableSignal,
  isWritableSignal as assertion,
} from '@angular/core';
import { isMutable } from '../mutable';

export function isWritableSignal<T>(
  value: Signal<T>,
): value is WritableSignal<T> {
  return assertion(value);
}

/**
 * @internal
 * Creates a setter function for a source signal of type `Signal<T[]>` or a function returning `T[]`.
 * @param source The source signal of type `Signal<T[]>` or a function returning `T[]`.
 * @returns
 */
export function createSetter<T>(
  source: Signal<T[]>,
): (value: T, index: number) => void {
  if (!isWritableSignal(source))
    return () => {
      // noop;
    };

  if (isMutable(source))
    return (value, index) => {
      source.mutate((arr) => {
        arr[index] = value;
        return arr;
      });
    };

  return (value, index) => {
    source.update((arr) => arr.map((v, i) => (i === index ? value : v)));
  };
}

/**
 * @internal
 * Item equality over a `mutable()` source: objects are edited in place, so the same reference
 * may carry new content and is never equal; primitives compare by value.
 */
export function mutableItemEqual<T>(a: T, b: T): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' || typeof a === 'function') return false;
  return a === b;
}
