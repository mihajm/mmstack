import { untracked, type Signal, type WritableSignal } from '@angular/core';

export function toWritable<T>(
  sig: Signal<T>,
  set: (next: T) => void,
): WritableSignal<T> {
  const internal = sig as WritableSignal<T>;
  internal.set = set;
  internal.update = (updater) => internal.set(updater(untracked(internal)));
  internal.asReadonly = () => sig;

  return internal;
}
