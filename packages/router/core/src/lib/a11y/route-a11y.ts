import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  afterNextRender,
  effect,
  type EnvironmentProviders,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  untracked,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { VisualCommitCoordinator } from '../visual-commit';

/** Which parts of the route-change announcement to run. Both default to `true`. */
export type RouteA11yOptions = {
  /** Announce the new document title in a polite live region. */
  announce?: boolean;
  /** Move focus to the view that swapped in. */
  focus?: boolean;
};

const ROUTE_A11Y_OPTIONS = new InjectionToken<Required<RouteA11yOptions>>(
  'mmRouteA11yOptions',
);

/**
 * Makes route changes perceivable to assistive technology, on the visual commit rather than on
 * `NavigationEnd`.
 *
 * A client-side navigation replaces the page without any of the signals a document load gives a
 * screen reader: focus stays wherever it was, and nothing is announced. On commit this
 *
 * - moves focus to the root element of the view that swapped in (given a transient
 *   `tabindex="-1"`, focused with `preventScroll` so it can't fight scroll restoration), and
 * - announces the new document title in a polite live region.
 *
 * The title is read after the hold-aware title store has applied, so what is announced is what
 * the page is actually called. Fires once per committed navigation and never for a navigation
 * that was superseded before it reached the screen.
 *
 * @example
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [provideRouter(routes), provideRouteA11y()],
 * });
 *
 * // Announce only — the app moves focus itself:
 * provideRouteA11y({ focus: false });
 * ```
 */
export function provideRouteA11y(
  options?: RouteA11yOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ROUTE_A11Y_OPTIONS,
      useValue: {
        announce: options?.announce ?? true,
        focus: options?.focus ?? true,
      },
    },
    provideEnvironmentInitializer(() => inject(RouteA11y)),
  ]);
}

const LIVE_REGION_STYLE =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';

@Injectable({ providedIn: 'root' })
class RouteA11y {
  private readonly options = inject(ROUTE_A11Y_OPTIONS);
  private readonly coordinator = inject(VisualCommitCoordinator);
  private readonly title = inject(Title);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private liveRegion: HTMLElement | null = null;
  private announcedFor: number | null = null;

  constructor() {
    if (!this.isBrowser) return;

    effect(() => {
      const { status, navigationId } = this.coordinator.state();
      if (
        status !== 'committed' ||
        navigationId === null ||
        navigationId === this.announcedFor
      )
        return;
      this.announcedFor = navigationId;
      // One render later: the title store's own effect has applied by then, and the swapped-in
      // view is laid out, so it can take focus.
      untracked(() =>
        afterNextRender(() => this.perform(), { injector: this.injector }),
      );
    });
  }

  private perform(): void {
    if (this.options.focus) this.moveFocus();
    if (this.options.announce) this.announce(this.title.getTitle());
  }

  private moveFocus(): void {
    const root = this.coordinator.committedRoot();
    if (!root) return;

    if (root.hasAttribute('tabindex')) {
      root.focus({ preventScroll: true });
      return;
    }

    root.setAttribute('tabindex', '-1');
    root.addEventListener('blur', () => root.removeAttribute('tabindex'), {
      once: true,
    });
    root.focus({ preventScroll: true });
  }

  private announce(text: string): void {
    if (!this.liveRegion) {
      const region = this.document.createElement('div');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      region.setAttribute('role', 'status');
      region.setAttribute('style', LIVE_REGION_STYLE);
      this.document.body.appendChild(region);
      this.liveRegion = region;
    }
    this.liveRegion.textContent = text;
  }
}
