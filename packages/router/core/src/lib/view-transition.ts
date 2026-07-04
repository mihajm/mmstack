import { inject, Injectable } from '@angular/core';
import type {
  ViewTransitionInfo,
  ViewTransitionsFeatureOptions,
} from '@angular/router';

/** Structural view of the DOM `ViewTransition`. */
type ViewTransitionLike = {
  skipTransition: () => void;
  finished: Promise<unknown>;
};

/**
 * @internal
 * Root coordinator shared between {@link mmRouterViewTransitions} and
 * {@link TransitionRouterOutlet}. Tells the outlet router view transitions are enabled and
 * hands it the active transition so it can skip Angular's inert activation-time transition
 * for held navigations.
 */
@Injectable({ providedIn: 'root' })
export class RouterViewTransitions {
  enabled = false;
  active: ViewTransitionLike | null = null;
}

/**
 * Wires {@link TransitionRouterOutlet} into Angular's router View Transitions so the two
 * cooperate instead of competing. Pass the result to Angular's `withViewTransitions`:
 *
 * ```ts
 * provideRouter(routes, withViewTransitions(mmRouterViewTransitions()));
 * ```
 *
 * With this in place:
 * - Routes the outlet does **not** hold (first navigation, `data.immediateTransition`,
 *   routes that load nothing) transition the normal Angular way — the swap is synchronous
 *   with activation, so Angular animates them correctly.
 * - Routes the outlet **holds** (waiting on data) have Angular's activation-time
 *   transition skipped (it would be inert — the incoming view activates hidden) and the
 *   outlet fires the real transition at the swap instead. Same `::view-transition-*` CSS
 *   applies to both.
 * - The outlet's `viewTransition` input defaults to "on" — you don't need to set the
 *   attribute. Set `[viewTransition]="false"` on a specific outlet to opt it back out.
 *
 * Your own `onViewTransitionCreated` / `skipInitialTransition` options are preserved.
 *
 * @param options Standard {@link ViewTransitionsFeatureOptions}; `onViewTransitionCreated`
 *   is chained after the coordination hook.
 */
export function mmRouterViewTransitions(
  options?: ViewTransitionsFeatureOptions,
): ViewTransitionsFeatureOptions {
  return {
    ...options,
    onViewTransitionCreated: (info: ViewTransitionInfo) => {
      const coordinator = inject(RouterViewTransitions);
      coordinator.enabled = true;

      const transition = info.transition as unknown as ViewTransitionLike;
      coordinator.active = transition;
      const clear = () => {
        if (coordinator.active === transition) coordinator.active = null;
      };
      transition.finished.then(clear, clear);

      options?.onViewTransitionCreated?.(info);
    },
  };
}
