import { isPlatformBrowser, ViewportScroller } from '@angular/common';
import {
  effect,
  type EnvironmentProviders,
  inject,
  Injectable,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Event, EventType, Router } from '@angular/router';
import { VisualCommitCoordinator } from '../visual-commit';

/**
 * Scroll restoration that fires on the visual commit instead of `NavigationEnd`.
 *
 * Angular's own restoration scrolls as soon as the router activates the route, which under a
 * {@link TransitionRouterOutlet} hold is while the *previous* view is still on screen — so the
 * old page jumps, and the new one arrives already scrolled to the wrong place. This restores
 * after the swap, when the content the position refers to actually exists.
 *
 * Per navigation: going back or forward restores the position that page was left at, and a
 * forward navigation goes to the top, or to the element named by the URL fragment. A navigation
 * that never commits (superseded by another one) never scrolls.
 *
 * Replaces `withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })` — enable one or the
 * other, not both, or the two will fight over the same scroll.
 *
 * @example
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [provideRouter(routes), provideTransitionScrollRestoration()],
 * });
 * ```
 */
export function provideTransitionScrollRestoration(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => inject(TransitionScrollRestoration)),
  ]);
}

type ScrollIntent = {
  /** Where to go back to, for a popstate navigation whose position we stored. */
  readonly restore: [number, number] | null;
};

@Injectable({ providedIn: 'root' })
class TransitionScrollRestoration {
  private readonly router = inject(Router);
  private readonly scroller = inject(ViewportScroller);
  private readonly commit = inject(VisualCommitCoordinator).state;
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Scroll position each navigation left the page at, keyed by its navigation id. */
  private readonly positions = new Map<number, [number, number]>();
  private readonly intents = new Map<number, ScrollIntent>();
  private currentId = 0;
  private scrolledFor: number | null = null;

  constructor() {
    if (!this.isBrowser) return;

    // The browser must not also restore, or it does so against the pre-swap DOM.
    this.scroller.setHistoryScrollRestoration('manual');

    this.router.events
      .pipe(takeUntilDestroyed())
      .subscribe((e: Event) => this.onEvent(e));

    effect(() => {
      const { status, navigationId } = this.commit();
      if (
        status !== 'committed' ||
        navigationId === null ||
        navigationId === this.scrolledFor
      )
        return;
      this.scrolledFor = navigationId;
      untracked(() => this.applyScroll(navigationId));
    });
  }

  private onEvent(e: Event): void {
    if (e.type !== EventType.NavigationStart) return;

    this.positions.set(this.currentId, this.scroller.getScrollPosition());
    this.currentId = e.id;

    const restoredId = e.restoredState?.navigationId;
    this.intents.set(e.id, {
      restore:
        e.navigationTrigger === 'popstate' && restoredId !== undefined
          ? (this.positions.get(restoredId) ?? null)
          : null,
    });
  }

  private applyScroll(navigationId: number): void {
    const intent = this.intents.get(navigationId);
    this.intents.clear();

    if (intent?.restore) {
      this.scroller.scrollToPosition(intent.restore);
      return;
    }

    const anchor = this.router.parseUrl(this.router.url).fragment;
    if (anchor) this.scroller.scrollToAnchor(anchor);
    else this.scroller.scrollToPosition([0, 0]);
  }
}
