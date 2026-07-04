import { inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Event, EventType, Router } from '@angular/router';

/**
 * @internal
 * Buffers registrations made during a navigation and applies them only when it commits.
 *
 * Registrations flush on `NavigationEnd`, are dropped on `NavigationCancel`/`NavigationError`,
 * and apply immediately when made outside any navigation.
 *
 * Must be created in an injection context.
 */
export function createStagedApply<V>(
  apply: (id: string, value: V) => void,
): (id: string, value: V) => void {
  const router = inject(Router);

  let staged: [string, V][] | null = null;

  router.events.pipe(takeUntilDestroyed()).subscribe((e: Event) => {
    switch (e.type) {
      case EventType.NavigationStart:
        staged = [];
        break;
      case EventType.NavigationEnd: {
        const flush = staged ?? [];
        staged = null;
        for (const [id, value] of flush) apply(id, value);
        break;
      }
      case EventType.NavigationCancel:
      case EventType.NavigationError:
        staged = null;
        break;
    }
  });

  return (id: string, value: V) => {
    if (staged) staged.push([id, value]);
    else apply(id, value);
  };
}
