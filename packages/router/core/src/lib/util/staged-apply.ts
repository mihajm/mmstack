import { inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Event, EventType, Router } from '@angular/router';

/**
 * @internal
 * Buffers registrations made DURING a navigation and applies them only when it commits.
 *
 * Resolvers run before a navigation lands, so naive `register()` calls flip shared
 * state (document title, breadcrumb labels) for navigations that are subsequently
 * cancelled or errored — the browser would show the new route's title while the app
 * remains on the old URL. Staged registrations flush on `NavigationEnd` and are dropped
 * on `NavigationCancel`/`NavigationError`; registrations made outside any navigation
 * apply immediately.
 *
 * Must be created in an injection context (root-store constructors/field initializers).
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
