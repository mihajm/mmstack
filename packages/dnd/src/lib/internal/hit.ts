import { computed, type Signal } from '@angular/core';

/**
 * Shared hover derivation: turns an innermost-first hit-index signal into the
 * `isDragOver` / `isInnermost` pair used by both element and external targets.
 */
export function deriveHit(hitIndex: Signal<number>): {
  isDragOver: Signal<boolean>;
  isInnermost: Signal<boolean>;
} {
  return {
    isDragOver: computed(() => hitIndex() >= 0),
    isInnermost: computed(() => hitIndex() === 0),
  };
}
