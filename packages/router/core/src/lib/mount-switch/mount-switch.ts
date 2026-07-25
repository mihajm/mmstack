import { inject, Injectable } from '@angular/core';
import {
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  type Route,
  Router,
  type UrlTree,
} from '@angular/router';
import { Subscription } from 'rxjs';
import {
  findMarkedRoute,
  replaceRouteAt,
} from '../remount/lazy-route-internals';

const MOUNT_ID = Symbol('mmMountSwitch');
const MOUNT_FACTORY = Symbol('mmMountSwitchFactory');

/** How a mount switch ended. */
export type MountSwitchResult =
  /** The navigation onto the new mount reached `NavigationEnd`. */
  | { outcome: 'committed' }
  /** The navigation aborted; the previous mount is back in the config, cache intact. */
  | { outcome: 'rolled-back'; reason: 'cancelled' | 'error' }
  /** A newer switch took over the config before this one settled. */
  | { outcome: 'superseded' };

/** Controls the mount created by {@link mountSwitchRoute} with the same id. */
export interface MountController {
  /**
   * Swaps the mount and navigates onto it, resolving when the transaction settles. Use this
   * from an effect, a click handler — anywhere outside the router's own recognition pass.
   *
   * @param opts.target Where to navigate. Defaults to re-entering the current URL.
   */
  switch(opts?: { target?: UrlTree }): Promise<MountSwitchResult>;
  /**
   * Swaps the mount synchronously and arms the rollback, returning the `UrlTree` navigation
   * should re-enter with. For use *inside* recognition — return it from a `canMatch` guard, and
   * the router's redirect hop lands on the new mount. The transaction then commits or rolls back
   * on the router's own events.
   */
  beginSwitch(): UrlTree;
  /**
   * How the switch that is currently in flight ends — or, if none is, how the next one to begin
   * does. Same result taxonomy either way, so a `beginSwitch()` caller can react to a rollback
   * without subscribing to router events itself.
   *
   * @example
   * ```ts
   * const controller = injectMountController('preview');
   *
   * // In a canMatch guard: swap now, learn the outcome later.
   * void controller.outcome().then((result) => {
   *   if (result.outcome === 'rolled-back') this.selected.set(this.lastCommitted);
   * });
   * return controller.beginSwitch();
   * ```
   */
  outcome(): Promise<MountSwitchResult>;
}

/**
 * Declares a route whose definition can be swapped at runtime — the mount point for a subtree
 * that is generated rather than written: a preview of a page the user is editing, a screen built
 * from a definition that just changed, an A/B variant.
 *
 * `factory` produces the route; it is called once for the initial mount and again for every
 * {@link MountController.switch}. Swapping is transactional: the new definition goes into the
 * config, navigation re-enters, and if that navigation aborts the exact previous `Route` object
 * goes back — lazy caches and all — as if nothing had been tried.
 *
 * @example
 * ```ts
 * export const routes: Routes = [
 *   mountSwitchRoute('preview', () => ({
 *     path: 'preview',
 *     children: buildRoutesFromDefinition(currentDefinition()),
 *   })),
 * ];
 *
 * // later, when the definition changes:
 * const { outcome } = await injectMountController('preview').switch();
 * ```
 */
export function mountSwitchRoute(id: string, factory: () => Route): Route {
  return markMount(id, factory, factory());
}

/**
 * The {@link MountController} for the mount declared by {@link mountSwitchRoute}`(id, ...)`.
 * Shared per id — every injection sees the same controller, so the queue-of-one is global to the
 * mount rather than per caller.
 */
export function injectMountController(id: string): MountController {
  return inject(MountSwitchRegistry).controller(id);
}

function markMount(id: string, factory: () => Route, route: Route): Route {
  return {
    ...route,
    data: { ...route.data, [MOUNT_ID]: id, [MOUNT_FACTORY]: factory },
  };
}

@Injectable({ providedIn: 'root' })
class MountSwitchRegistry {
  private readonly router = inject(Router);
  private readonly controllers = new Map<string, MountController>();

  controller(id: string): MountController {
    let controller = this.controllers.get(id);
    if (!controller) {
      controller = new MountSwitch(this.router, id);
      this.controllers.set(id, controller);
    }
    return controller;
  }
}

type Transaction = {
  /** The route to put back on rollback — always the last one that actually committed. */
  readonly replaced: Route;
  readonly promise: Promise<MountSwitchResult>;
  readonly subscription: Subscription;
  /** The navigation this transaction rides, claimed at the first `NavigationStart` it sees. */
  navigationId: number | null;
  resolve(result: MountSwitchResult): void;
};

class MountSwitch implements MountController {
  private pending: Transaction | null = null;
  /** `outcome()` callers waiting for a transaction that has not begun yet. */
  private readonly waiting: ((result: MountSwitchResult) => void)[] = [];

  constructor(
    private readonly router: Router,
    private readonly id: string,
  ) {}

  switch(opts?: { target?: UrlTree }): Promise<MountSwitchResult> {
    const promise = this.begin();
    // The outcome rides the router's events; a navigation that throws is reported as
    // `rolled-back` rather than as a rejection of this promise.
    this.router
      .navigateByUrl(opts?.target ?? this.router.parseUrl(this.router.url), {
        onSameUrlNavigation: 'reload',
      })
      .catch(() => undefined);
    return promise;
  }

  beginSwitch(): UrlTree {
    void this.begin();
    const nav = this.router.getCurrentNavigation();
    return (
      nav?.finalUrl ??
      nav?.extractedUrl ??
      this.router.parseUrl(this.router.url)
    );
  }

  outcome(): Promise<MountSwitchResult> {
    if (this.pending) return this.pending.promise;
    return new Promise<MountSwitchResult>((resolve) =>
      this.waiting.push(resolve),
    );
  }

  /** Swaps the config and arms the rollback. Synchronous, so the config never interleaves. */
  private begin(): Promise<MountSwitchResult> {
    const location = findMarkedRoute(this.router.config, MOUNT_ID, this.id);
    if (!location)
      throw new Error(
        `[mmstack/router-core] No mountSwitchRoute("${this.id}") in the router config.`,
      );

    const factory = location.route.data?.[MOUNT_FACTORY] as
      | (() => Route)
      | undefined;
    if (!factory)
      throw new Error(
        `[mmstack/router-core] The route marked mountSwitchRoute("${this.id}") lost its factory — build it with mountSwitchRoute(), not by copying its data.`,
      );

    // The superseded transaction hands over its rollback point: rolling back must land on the
    // mount that was last live, never on one that only ever existed mid-transaction.
    const superseded = this.pending;
    const replaced = superseded?.replaced ?? location.route;

    replaceRouteAt(location, markMount(this.id, factory, factory()));
    this.router.resetConfig(this.router.config);

    if (superseded) this.settle(superseded, { outcome: 'superseded' });
    return this.arm(replaced);
  }

  private arm(replaced: Route): Promise<MountSwitchResult> {
    let resolve!: (result: MountSwitchResult) => void;
    const promise = new Promise<MountSwitchResult>((r) => (resolve = r));

    const subscription = new Subscription();
    const transaction: Transaction = {
      replaced,
      promise,
      subscription,
      navigationId: null,
      resolve,
    };
    this.pending = transaction;

    const waiting = this.waiting.splice(0);
    if (waiting.length)
      void promise.then((result) => {
        for (const resolveWaiting of waiting) resolveWaiting(result);
      });

    subscription.add(
      this.router.events.subscribe((e) => {
        if (this.pending !== transaction) return;

        // The navigation this swap triggers is the next one to start; until it does, events
        // belong to the navigation we interrupted and say nothing about this transaction.
        if (e instanceof NavigationStart) {
          transaction.navigationId ??= e.id;
          return;
        }
        if (
          !(
            e instanceof NavigationEnd ||
            e instanceof NavigationError ||
            e instanceof NavigationCancel
          ) ||
          e.id !== transaction.navigationId
        )
          return;

        if (e instanceof NavigationEnd)
          this.settle(transaction, { outcome: 'committed' });
        else if (e instanceof NavigationError)
          this.rollback(transaction, 'error');
        else if (e.code === NavigationCancellationCode.Redirect)
          // Our own re-entry hop: the transaction rides the navigation that replaces it.
          transaction.navigationId = null;
        else this.rollback(transaction, 'cancelled');
      }),
    );

    return promise;
  }

  private rollback(
    transaction: Transaction,
    reason: 'cancelled' | 'error',
  ): void {
    const location = findMarkedRoute(this.router.config, MOUNT_ID, this.id);
    if (location) {
      replaceRouteAt(location, transaction.replaced);
      this.router.resetConfig(this.router.config);
    }
    this.settle(transaction, { outcome: 'rolled-back', reason });
  }

  private settle(transaction: Transaction, result: MountSwitchResult): void {
    transaction.subscription.unsubscribe();
    if (this.pending === transaction) this.pending = null;
    transaction.resolve(result);
  }
}
