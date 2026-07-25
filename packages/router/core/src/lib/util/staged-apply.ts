import { effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Event, EventType, Router } from '@angular/router';
import { VisualCommitCoordinator } from '../visual-commit';

/** When buffered registrations are applied. */
export type StagedFlush =
  /** `NavigationEnd` — the router has committed the URL. */
  | 'navigation-end'
  /** The swap is on screen (see `injectVisualCommit`) — right for anything the user can see. */
  | 'visual-commit';

/**
 * @internal
 * Buffers registrations made during a navigation and applies them only when it commits.
 *
 * Registrations are dropped on `NavigationCancel`/`NavigationError`, and apply immediately when
 * made outside any navigation. Under `'visual-commit'` a buffer that a navigation never got to
 * flush — because a newer navigation interrupted it — carries into the interrupting navigation
 * and flushes at its commit instead. A cancellation there only drops the buffer if no swap is
 * still on its way to the screen: one that is will need it.
 *
 * Must be created in an injection context.
 */
export function createStagedApply<V>(
  apply: (id: string, value: V) => void,
  flushOn: StagedFlush = 'navigation-end',
): (id: string, value: V) => void {
  const router = inject(Router);
  const holdAware = flushOn === 'visual-commit';
  const coordinator = holdAware ? inject(VisualCommitCoordinator) : null;

  let staged: [string, V][] | null = null;

  const flush = () => {
    const pending = staged ?? [];
    staged = null;
    for (const [id, value] of pending) apply(id, value);
  };

  router.events.pipe(takeUntilDestroyed()).subscribe((e: Event) => {
    switch (e.type) {
      case EventType.NavigationStart:
        staged = holdAware ? (staged ?? []) : [];
        break;
      case EventType.NavigationEnd:
        if (!holdAware) flush();
        break;
      case EventType.NavigationCancel:
      case EventType.NavigationError:
        // A swap an earlier navigation still owes will reach the screen, and needs its buffer.
        if (!coordinator?.outstandingCommit()) staged = null;
        break;
    }
  });

  if (coordinator) {
    let flushedFor: number | null = null;
    effect(() => {
      const { status, navigationId } = coordinator.state();
      if (status !== 'committed' || navigationId === flushedFor) return;
      flushedFor = navigationId;
      untracked(flush);
    });
  }

  return (id: string, value: V) => {
    if (staged) staged.push([id, value]);
    else apply(id, value);
  };
}
