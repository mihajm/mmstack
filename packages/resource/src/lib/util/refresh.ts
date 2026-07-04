import { type HttpResourceRef } from '@angular/common/http';
import {
  effect,
  untracked,
  type DestroyRef,
  type EffectRef,
  type Injector,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';

/**
 * Refresh configuration for a query resource.
 * - a `number` is shorthand for `{ interval: number }` (poll every n milliseconds)
 * - the object form composes polling with event-driven refresh triggers
 */
export type RefreshOptions =
  | number
  | {
      /**
       * Poll interval in milliseconds. Omit (or 0) for no polling — useful when only
       * the event-driven triggers below are wanted.
       */
      interval?: number;
      /**
       * Reload when the page becomes visible again (tab refocused, window restored).
       * @default false
       */
      onFocus?: boolean;
      /**
       * Reload when the browser comes back online.
       * @default false
       */
      onReconnect?: boolean;
    };

/** @internal Reactive sources + injector for the event-driven refresh triggers. */
export type RefreshTriggers = {
  injector: Injector;
  visibility: Signal<DocumentVisibilityState>;
  online: Signal<boolean>;
};

export function refresh<T>(
  resource: HttpResourceRef<T>,
  destroyRef: DestroyRef,
  opt?: RefreshOptions,
  inactive?: () => boolean,
  triggers?: RefreshTriggers,
): HttpResourceRef<T> {
  const normalized = typeof opt === 'number' ? { interval: opt } : (opt ?? {});
  const {
    interval: ms,
    onFocus = false,
    onReconnect = false,
  } = normalized;

  const hasInterval = !!ms;
  const hasTriggerEffects = !!triggers && (onFocus || onReconnect);

  if (!hasInterval && !hasTriggerEffects) return resource;

  const tick = () => {
    if (inactive?.()) return;
    resource.reload();
  };

  const effectRefs: EffectRef[] = [];

  if (triggers && onFocus) {
    const vis = triggers.visibility;
    let prev = untracked(vis);
    effectRefs.push(
      effect(
        () => {
          const next = vis();
          const was = prev;
          prev = next;
          if (was !== 'visible' && next === 'visible') untracked(tick);
        },
        { injector: triggers.injector },
      ),
    );
  }

  if (triggers && onReconnect) {
    const online = triggers.online;
    let prev = untracked(online);
    effectRefs.push(
      effect(
        () => {
          const next = online();
          const was = prev;
          prev = next;
          if (!was && next) untracked(tick);
        },
        { injector: triggers.injector },
      ),
    );
  }

  if (!hasInterval) {
    return {
      ...resource,
      destroy: () => {
        effectRefs.forEach((ref) => ref.destroy());
        resource.destroy();
      },
    };
  }

  let sub = interval(ms)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(tick);

  const reload = (): boolean => {
    sub.unsubscribe();

    const hasReloaded = resource.reload();

    sub = interval(ms)
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(tick);

    return hasReloaded;
  };

  return {
    ...resource,
    reload,
    destroy: () => {
      sub.unsubscribe();
      effectRefs.forEach((ref) => ref.destroy());
      resource.destroy();
    },
  };
}