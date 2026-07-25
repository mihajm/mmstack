import {
  effect,
  type EffectRef,
  inject,
  Injectable,
  Injector,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  type Route,
  Router,
} from '@angular/router';
import { defaultIfEmpty, filter, firstValueFrom, take } from 'rxjs';
import { PreloadStrategy } from '../preloading/preload-strategy';
import { findPath } from '../util/find-path';
import { VisualCommitCoordinator } from '../visual-commit';
import {
  destroyLazyInjectors,
  findMarkedRoute,
  hasLazyState,
  replaceRouteAt,
  withoutLazyState,
} from './lazy-route-internals';

const REMOUNT_MARKER = Symbol('mmRemountable');

/** What an {@link RemountHandle.invalidate} call ended up doing. */
export type RemountResult =
  /** The cached subtree was dropped and (unless `navigation: 'none'`) the URL was re-entered. */
  | { outcome: 'remounted' }
  /** The marked route had nothing cached, so there was nothing to drop. */
  | { outcome: 'no-op' }
  /** A navigation was in flight and `inFlight: 'reject'` was asked for. */
  | { outcome: 'rejected' };

/** Options for {@link RemountHandle.invalidate}. */
export type RemountOptions = {
  /**
   * `'reload-current'` (default) re-enters the current URL after dropping the cache, so the
   * subtree loads again immediately. `'none'` only drops the cache — the next navigation into
   * the subtree picks up the fresh load.
   */
  navigation?: 'none' | 'reload-current';
  /**
   * What to do when *any* navigation is already in flight. Deliberately conservative: relevance
   * to the marked subtree is not computed, because a navigation mid-recognition can still turn
   * out to touch it.
   *
   * - `'wait'` (default) — run once the in-flight navigation settles. Invalidations that queue
   *   up meanwhile coalesce into a single run.
   * - `'cancel-and-retry'` — abort the in-flight navigation, then run.
   * - `'reject'` — do nothing and resolve `{ outcome: 'rejected' }`.
   */
  inFlight?: 'wait' | 'cancel-and-retry' | 'reject';
};

/** Controls one `remountable` subtree. Shared per id — every injection sees the same handle. */
export interface RemountHandle {
  /** Bumps on every successful invalidation; loads/preloads verify ownership against it. */
  readonly generation: Signal<number>;
  invalidate(options?: RemountOptions): Promise<RemountResult>;
}

/**
 * Marks a lazy route as remountable, so {@link injectRemountHandle} can find and invalidate it.
 * Spread the result into the route's `data`.
 *
 * The id is the lookup key, not the `Route` object: `Router.resetConfig` shallow-copies every
 * route it standardizes, so route identity goes stale while the marker survives.
 *
 * @example
 * ```ts
 * {
 *   path: 'reports',
 *   loadChildren: () => import('./reports/routes'),
 *   data: { ...remountable('reports') },
 * }
 * ```
 */
export function remountable(id: string): Route['data'] {
  return { [REMOUNT_MARKER]: id };
}

/**
 * Handle for the subtree marked with {@link remountable}`(id)`. Call `invalidate()` to throw the
 * loaded subtree away and load it again — for a lazy feature whose route config is generated
 * from data that just changed, or any case where "re-run `loadChildren`" is the intent.
 *
 * Invalidation drops the router's cached children, injector, factory and component for the route
 * and orphans the `Route` object it cached them on, so a load or preload that was already in
 * flight lands on the discarded object and can never repopulate the live config. The orphaned
 * subtree's injectors are destroyed once the replacement has loaded and its swap is on screen, so
 * the services the old mount created are torn down instead of being left running.
 *
 * @example
 * ```ts
 * readonly reports = injectRemountHandle('reports');
 *
 * async onDefinitionChanged() {
 *   const { outcome } = await this.reports.invalidate();
 *   if (outcome === 'remounted') this.toast('Reports reloaded');
 * }
 * ```
 */
export function injectRemountHandle(id: string): RemountHandle {
  return inject(RemountRegistry).handle(id);
}

@Injectable({ providedIn: 'root' })
class RemountRegistry {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly visualCommit = inject(VisualCommitCoordinator);
  private readonly handles = new Map<string, RemountHandle>();

  handle(id: string): RemountHandle {
    let handle = this.handles.get(id);
    if (!handle) {
      handle = new Remounter(this.router, this.injector, this.visualCommit, id);
      this.handles.set(id, handle);
    }
    return handle;
  }
}

type Queued = {
  readonly promise: Promise<RemountResult>;
  resolve(result: RemountResult): void;
  navigate: boolean;
};

class Remounter implements RemountHandle {
  private readonly gen = signal(0);
  readonly generation = this.gen.asReadonly();

  private queued: Queued | null = null;
  /** Routes dropped from the config that still own the DI of a subtree that may be on screen. */
  private readonly orphans: Route[] = [];
  private disposalWatcher: EffectRef | null = null;

  constructor(
    private readonly router: Router,
    private readonly injector: Injector,
    private readonly visualCommit: VisualCommitCoordinator,
    private readonly id: string,
  ) {}

  invalidate(options?: RemountOptions): Promise<RemountResult> {
    const navigate = (options?.navigation ?? 'reload-current') !== 'none';
    const inFlight = options?.inFlight ?? 'wait';
    const current = this.router.getCurrentNavigation();

    if (!current) return this.run(navigate);

    switch (inFlight) {
      case 'reject':
        return Promise.resolve({ outcome: 'rejected' });
      case 'cancel-and-retry': {
        // Subscribe first: aborting emits the cancel synchronously.
        const settled = this.afterSettled();
        current.abort();
        return settled.then(() => this.run(navigate));
      }
      case 'wait':
        return this.enqueue(navigate);
    }
  }

  /** One queued run per handle: later waiters join it and the strongest intent wins. */
  private enqueue(navigate: boolean): Promise<RemountResult> {
    if (this.queued) {
      this.queued.navigate ||= navigate;
      return this.queued.promise;
    }

    let resolve!: (result: RemountResult) => void;
    const promise = new Promise<RemountResult>((r) => (resolve = r));
    const queued: Queued = { promise, resolve, navigate };
    this.queued = queued;

    void this.afterSettled().then(async () => {
      this.queued = null;
      queued.resolve(await this.run(queued.navigate));
    });

    return promise;
  }

  private async run(navigate: boolean): Promise<RemountResult> {
    const location = findMarkedRoute(
      this.router.config,
      REMOUNT_MARKER,
      this.id,
    );
    if (!location)
      throw new Error(
        `[mmstack/router-core] No route marked remountable("${this.id}") in the router config. Spread remountable('${this.id}') into the route's data.`,
      );

    const cached = hasLazyState(location.route);
    const path = findPath(this.router.config, location.route);
    replaceRouteAt(location, withoutLazyState(location.route));
    // The subtree is factory-fresh again, so demand-driven warming has to be allowed to re-warm it.
    this.injector.get(PreloadStrategy).forget(path);
    if (!cached) return { outcome: 'no-op' };

    this.orphans.push(location.route);
    this.watchForSuccessor();

    this.gen.update((g) => g + 1);
    if (navigate)
      await this.router.navigateByUrl(this.router.url, {
        onSameUrlNavigation: 'reload',
      });

    return { outcome: 'remounted' };
  }

  /**
   * An orphaned route still owns its subtree's injectors, and the view built from them can still
   * be on screen — under `navigation: 'none'` it is, by design. They are destroyed once a
   * successor load has published *and* that navigation is visually committed: at that point the
   * old view is gone by construction, whether it was swapped out or destroyed outright.
   */
  private watchForSuccessor(): void {
    if (this.disposalWatcher) return;
    this.disposalWatcher = effect(
      () => {
        if (this.visualCommit.state().status !== 'committed') return;
        untracked(() => this.disposeOrphans());
      },
      { injector: this.injector },
    );
  }

  private disposeOrphans(): void {
    const location = findMarkedRoute(
      this.router.config,
      REMOUNT_MARKER,
      this.id,
    );
    if (!location || !hasLazyState(location.route)) return;

    for (const orphan of this.orphans) destroyLazyInjectors(orphan);
    this.orphans.length = 0;
    this.disposalWatcher?.destroy();
    this.disposalWatcher = null;
  }

  private afterSettled(): Promise<unknown> {
    return firstValueFrom(
      this.router.events.pipe(
        filter(
          (e) =>
            e instanceof NavigationEnd ||
            e instanceof NavigationCancel ||
            e instanceof NavigationError ||
            e instanceof NavigationSkipped,
        ),
        take(1),
        defaultIfEmpty(null),
      ),
    );
  }
}
