import {
  type EnvironmentProviders,
  inject,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
  type DetachedRouteHandle,
  type Route,
  Router,
  RouteReuseStrategy,
} from '@angular/router';
import { HeldRouteInjectors } from './held-route-injectors';

/** The optional members of the strategy, typed here so this compiles where they are not declared. */
type CleanupAware = RouteReuseStrategy & {
  shouldDestroyInjector?(route: Route): boolean;
  retrieveStoredRouteHandles?(): DetachedRouteHandle[];
};

class AngularDefaultReuseStrategy extends BaseRouteReuseStrategy {}

/**
 * @internal
 * Delegates every decision to the inner strategy, except that the injector of a route a
 * {@link TransitionRouterOutlet} still holds on screen is never reported as destroyable.
 */
export class TransitionRouteReuseStrategy implements RouteReuseStrategy {
  constructor(
    private readonly inner: CleanupAware,
    private readonly held: HeldRouteInjectors,
  ) {}

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.inner.shouldDetach(route);
  }

  store(
    route: ActivatedRouteSnapshot,
    handle: DetachedRouteHandle | null,
  ): void {
    this.inner.store(route, handle);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.inner.shouldAttach(route);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.inner.retrieve(route);
  }

  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    return this.inner.shouldReuseRoute(future, curr);
  }

  retrieveStoredRouteHandles(): DetachedRouteHandle[] {
    return this.inner.retrieveStoredRouteHandles?.() ?? [];
  }

  shouldDestroyInjector(route: Route): boolean {
    // A strategy without the member never destroys, the same answer the router gives it.
    return (
      !this.held.isHeld(route) &&
      (this.inner.shouldDestroyInjector?.(route) ?? false)
    );
  }
}

/**
 * Makes `withAutoCleanupInjectors()` work with {@link TransitionRouterOutlet}: the injector of a
 * route whose view an outlet still holds stays alive until the swap. The router destroys it on
 * its next cleanup pass after that.
 *
 * Add it beside `provideRouter`. Without it, the router destroys a held route's injector at
 * `NavigationEnd` and the outlet has to swap early.
 *
 * @param inner Builds the strategy to wrap, run in an injection context. Pass it when the app
 *   has its own `RouteReuseStrategy`; every decision except the held-route rule is forwarded to
 *   it. Omitted, the strategy behaves like Angular's default one.
 *
 * Registering your own `{ provide: RouteReuseStrategy, ... }` after this replaces it; pass your
 * strategy as `inner` instead.
 *
 * @example
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [
 *     provideRouter(routes, withAutoCleanupInjectors()),
 *     provideTransitionRouteReuseStrategy(),
 *     // or, with your own strategy:
 *     // provideTransitionRouteReuseStrategy(() => new MyReuseStrategy()),
 *   ],
 * });
 * ```
 */
export function provideTransitionRouteReuseStrategy(
  inner?: () => RouteReuseStrategy,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: RouteReuseStrategy,
      useFactory: () =>
        new TransitionRouteReuseStrategy(
          inner ? inner() : new AngularDefaultReuseStrategy(),
          inject(HeldRouteInjectors),
        ),
    },
  ]);
}

const FIX =
  'Add provideTransitionRouteReuseStrategy() beside provideRouter, or provideTransitionRouteReuseStrategy(() => new MyReuseStrategy()) if the app has its own strategy.';

/** @internal */
export const AUTO_CLEANUP_WITHOUT_STRATEGY = `[mmstack/router-core] withAutoCleanupInjectors() is enabled, but the RouteReuseStrategy does not know about views held by mm-transition-outlet, so the router destroys a held route's injector at NavigationEnd and the outlet swaps early. ${FIX}`;

/** @internal */
export const HELD_INJECTOR_DESTROYED = `[mmstack/router-core] The injector of a route held by mm-transition-outlet was destroyed before the swap, so the outlet swapped early. If the app uses withAutoCleanupInjectors(): ${FIX}`;

const WARNED = new InjectionToken<{ config: boolean; guard: boolean }>(
  '@mmstack/router-core:reuse-strategy-warned',
  { providedIn: 'root', factory: () => ({ config: false, guard: false }) },
);

function holdAware(): boolean {
  return inject(RouteReuseStrategy) instanceof TransitionRouteReuseStrategy;
}

/**
 * @internal Dev mode only. The router keeps no public flag for auto-cleanup, so this reads its
 * private `injectorCleanup` field and stays silent when the field is absent.
 */
export function warnIfAutoCleanupNotHoldAware(): void {
  const warned = inject(WARNED);
  if (warned.config) return;
  const router = inject(Router) as unknown as { injectorCleanup?: unknown };
  if (!router.injectorCleanup || holdAware()) return;
  warned.config = true;
  console.warn(AUTO_CLEANUP_WITHOUT_STRATEGY);
}

/** @internal Dev mode only. Returns the callback the outlet runs when a held injector dies. */
export function heldInjectorDestroyedWarning(): () => void {
  const warned = inject(WARNED);
  const aware = holdAware();
  return () => {
    if (warned.guard || aware) return;
    warned.guard = true;
    console.warn(HELD_INJECTOR_DESTROYED);
  };
}
