import { type Signal } from '@angular/core';
import { isMutable } from '../mutable';
import { isWritableSignal } from './is-writable';

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
