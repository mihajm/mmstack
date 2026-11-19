import { Injectable } from '@angular/core';
import { type Route } from '@angular/router';

/**
 * @internal
 * The routes whose views a {@link TransitionRouterOutlet} still holds on screen, per outlet.
 * Read by the hold-aware reuse strategy so the router's unused-injector cleanup skips them.
 */
@Injectable({ providedIn: 'root' })
export class HeldRouteInjectors {
  private readonly holds = new Map<object, ReadonlySet<Route>>();

  hold(owner: object, routes: Iterable<Route>): void {
    this.holds.set(owner, new Set(routes));
  }

  release(owner: object): void {
    this.holds.delete(owner);
  }

  isHeld(route: Route): boolean {
    for (const routes of this.holds.values())
      if (routes.has(route)) return true;
    return false;
  }
}
