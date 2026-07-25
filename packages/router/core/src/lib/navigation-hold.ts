import {
  computed,
  effect,
  inject,
  type Injector,
  linkedSignal,
  type Resource,
  type ResourceRef,
  type ResourceStatus,
  runInInjectionContext,
  type Signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { EventType, NavigationCancellationCode, Router } from '@angular/router';
import { scan } from 'rxjs';

type Mode = 'live' | 'frozen' | 'settling';

// Angular < 22 has no `ResourceSnapshot` type — define a local equivalent (same shape).
type ResourceSnapshot<T> =
  | { readonly status: Exclude<ResourceStatus, 'error'>; readonly value: T }
  | { readonly status: 'error'; readonly error: Error | undefined };

type NavState<T> = {
  readonly mode: Mode;
  readonly seed: ResourceSnapshot<T>;
  readonly nav: number;
};

/** The stabilized result: the read surface of a `Resource`, plus `reload()` delegated to the source. */
export type HeldResource<T> = Resource<T> & { reload(): boolean };

// Synthesized rather than read off `resource.snapshot` so this file carries no dependency on the
// Angular 22 `Resource.snapshot` member; the shape mirrors Angular's own snapshot computed.
function liveSnapshot<T>(
  resource: ResourceRef<T>,
): Signal<ResourceSnapshot<T>> {
  return computed(() => {
    const status = resource.status();
    if (status === 'error')
      return { status, error: resource.error() as Error } as const;
    return { status, value: resource.value() } as ResourceSnapshot<T>;
  });
}

const isLoadingStatus = (s: ResourceStatus): boolean =>
  s === 'loading' || s === 'reloading';

/**
 * Stabilizes a resource across navigation so its state can't flash through mid-transition:
 *
 * - **During a navigation** the whole snapshot (value/status/error/loading) is frozen at the
 *   pre-navigation state, so a refetch the navigation triggers shows no torn/loading state.
 * - **On success or skip** (`NavigationEnd`/`NavigationSkipped`) it reveals — settle-aware:
 *   the navigation's refetch usually starts just AFTER `NavigationEnd` (live params tick on it),
 *   so the last settled snapshot is held through that first load cycle and revealed when it
 *   lands. Once the cycle completes, loads pass through live again (a later `reload()`'s
 *   indicator shows normally) until the next navigation.
 * - **On a true rollback** (`NavigationError`, or a `NavigationCancel` that isn't a redirect /
 *   superseded-by-a-new-navigation) the same settle logic holds the pre-navigation snapshot
 *   until the cancelled load settles back — never revealing the would-be state of the route we
 *   didn't reach.
 * - **Redirect / superseded cancels** are left frozen: a new navigation is already taking over
 *   and will drive the next state (no spurious unfreeze between the two).
 *
 * The signal-level analogue of holding the previous view in {@link TransitionRouterOutlet}: use
 * it for a resource that *persists* across a navigation (a layout/shell resource, or a reused
 * route on a param change), where the outlet's view-hold doesn't apply.
 *
 * OBSERVATION CAVEAT (and the `eager` opt-out): the settle machine is pull-based — it
 * advances only when the held resource is READ. A consumer that goes unread through a
 * navigation (an unmounted view, a backgrounded pane) misses the load-cycle frames, so
 * the machine can't tell the cycle completed; a later manual `reload()` then gets held
 * (its indicator invisible) instead of passing through live. Pass `eager: true` to add
 * a tiny always-on watcher that keeps settledness tracked with zero readers — right for
 * shell/layout resources that are read intermittently.
 *
 * @example
 * ```ts
 * readonly user = holdThroughNavigation(
 *   queryResource<User>(() => `/api/users/${this.id()}`),
 * );
 * // user.value() never flashes to loading on param navigation, and rolls back if cancelled
 * ```
 */
export function holdThroughNavigation<T>(
  resource: ResourceRef<T>,
  options?: { injector?: Injector; eager?: boolean },
): HeldResource<T> {
  const run = <R>(fn: () => R): R =>
    options?.injector ? runInInjectionContext(options.injector, fn) : fn();

  return run(() => {
    const router = inject(Router);
    const live = liveSnapshot(resource);

    const initial: NavState<T> = {
      mode: 'live',
      seed: untracked(live),
      nav: 0,
    };
    const navState = toSignal(
      router.events.pipe(
        scan<unknown, NavState<T>>((state, e) => {
          switch ((e as { type: EventType }).type) {
            case EventType.NavigationStart:
              return state.mode === 'frozen'
                ? state
                : { mode: 'frozen', seed: untracked(live), nav: state.nav + 1 };
            case EventType.NavigationEnd:
            case EventType.NavigationSkipped:
            case EventType.NavigationError:
              return { mode: 'settling', seed: state.seed, nav: state.nav };
            case EventType.NavigationCancel: {
              const code = (e as { code: NavigationCancellationCode }).code;
              return code ===
                NavigationCancellationCode.SupersededByNewNavigation ||
                code === NavigationCancellationCode.Redirect
                ? state // redirect/superseded: new navigation takes over, stay frozen
                : { mode: 'settling', seed: state.seed, nav: state.nav };
            }
            default:
              return state;
          }
        }, initial),
      ),
      { initialValue: initial },
    );

    // `done` = this navigation's load cycle completed; later loads then pass through live.
    const stable = linkedSignal<
      { ns: NavState<T>; live: ResourceSnapshot<T> },
      { snap: ResourceSnapshot<T>; done: boolean }
    >({
      source: () => ({ ns: navState(), live: live() }),
      computation: ({ ns, live: liveSnap }, prev) => {
        const heldSnap = prev?.value.snap ?? ns.seed;
        if (ns.mode === 'frozen') return { snap: heldSnap, done: false };
        if (ns.mode === 'live') return { snap: liveSnap, done: false };

        const sameSettle =
          prev !== undefined &&
          prev.source.ns.mode === 'settling' &&
          prev.source.ns.nav === ns.nav;
        if (sameSettle && prev.value.done)
          return { snap: liveSnap, done: true };
        if (isLoadingStatus(liveSnap.status))
          return { snap: heldSnap, done: false };
        const completed =
          sameSettle && isLoadingStatus(prev.source.live.status);
        return { snap: liveSnap, done: completed };
      },
    });

    if (options?.eager) effect(() => void stable());

    return buildHeldResource(
      computed(() => stable().snap),
      resource,
    );
  });
}

function buildHeldResource<T>(
  snapshot: Signal<ResourceSnapshot<T>>,
  source: ResourceRef<T>,
): HeldResource<T> {
  const value = computed(() => {
    const s = snapshot();
    return s.status === 'error' ? (undefined as T) : s.value;
  });

  const hasValue = (() => {
    const s = snapshot();
    return s.status !== 'error' && s.value !== undefined;
  }) as HeldResource<T>['hasValue'];

  return {
    value,
    status: computed(() => snapshot().status),
    error: computed(() => {
      const s = snapshot();
      return s.status === 'error' ? s.error : undefined;
    }),
    isLoading: computed(() => isLoadingStatus(snapshot().status)),
    hasValue,
    reload: () => source.reload(),
  };
}
