import { computed, ElementRef, isSignal, type Signal } from '@angular/core';

import type { DragHandleLike, Resolvable } from './types';

/**
 * @internal
 * turn a {@link Resolvable} into a Signal
 */
export function resolveSignal<T>(value: Resolvable<T>): Signal<T> {
  if (isSignal(value)) return value;
  if (typeof value === 'function') return computed(value as () => T);
  return computed(() => value);
}

/**
 * @internal
 * Resolves a HTMLElement from various shapes this library encounters
 */
export function resolveElement(
  value: DragHandleLike | undefined,
): HTMLElement | undefined {
  if (!value) return undefined;
  if (value instanceof ElementRef) return value.nativeElement;
  if (
    typeof value === 'object' &&
    'elementRef' in value &&
    value.elementRef instanceof ElementRef
  ) {
    return value.elementRef.nativeElement;
  }
  return value as HTMLElement;
}
