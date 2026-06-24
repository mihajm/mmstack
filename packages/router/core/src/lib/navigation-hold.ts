/**
 * Navigation-aware resource stabilization. The behavior — freeze on NavigationStart, reveal on
 * success/skip, roll back on a genuine cancel/error (not redirect/superseded) — is modeled on
 * Angular's transactional router resource (angular/angular#69490). The implementation is an
 * independent, signals-only take: a scan over router events + linkedSignal, no effects.
 */

import {
  computed,
  inject,
  type Injector,
  linkedSignal,
  type Resource,
  type ResourceRef,
  ResourceStatus,
  runInInjectionContext,
  type Signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { EventType, NavigationCancellationCode, Router } from '@angular/router';
import { scan } from 'rxjs';

type Mode = 'live' | 'frozen' | 'rollback';

// Angular 19 has no `ResourceSnapshot` type and `ResourceStatus` is an enum — local equivalent.
type ResourceSnapshot<T> =
  | {
      readonly status: Exclude<ResourceStatus, ResourceStatus.Error>;
      readonly value: T;
    }
  | {
      readonly status: ResourceStatus.Error;
      readonly error: Error | undefined;
    };

type NavState<T> = {
  readonly mode: Mode;
  /** The pre-navigation snapshot, captured at the instant we enter `frozen`. */
  readonly frozen: ResourceSnapshot<T>;
};

/** The stabilized result: the read surface of a `Resource`, plus `reload()` delegated to the source. */
export type HeldResource<T> = Resource<T> & { reload(): boolean };

/**
 * The live resource state as a single snapshot signal — the freeze/reveal/rollback below all
 * operate on this one snapshot. Synthesized from `status()`/`value()`/`error()` because
 * Angular 19 has no `Resource.snapshot`. (On v22+ this is just `resource.snapshot`.)
 */
function liveSnapshot<T>(
  resource: ResourceRef<T>,
): Signal<ResourceSnapshot<T>> {
  return computed(() => {
    const status = resource.status();
    return (
      status === ResourceStatus.Error
        ? { status, error: resource.error() }
        : { status, value: resource.value() }
    ) as ResourceSnapshot<T>;
  });
}

const isLoadingStatus = (s: ResourceStatus): boolean =>
  s === ResourceStatus.Loading || s === ResourceStatus.Reloading;

/**
 * Stabilizes a resource across navigation so its state can't flash through mid-transition:
 *
 * - **During a navigation** the whole snapshot (value/status/error/loading) is frozen at the
 *   pre-navigation state, so a refetch the navigation triggers shows no torn/loading state.
 * - **On success or skip** (`NavigationEnd`/`NavigationSkipped`) it reveals the live state.
 * - **On a true rollback** (`NavigationError`, or a `NavigationCancel` that isn't a redirect /
 *   superseded-by-a-new-navigation) it holds the frozen snapshot until the resource stops
 *   loading, so a cancelled refetch settling back to the route we stayed on reveals cleanly —
 *   never the would-be state of the route we didn't reach.
 * - **Redirect / superseded cancels** are left frozen: a new navigation is already taking over
 *   and will drive the next state (no spurious unfreeze between the two).
 *
 * The signal-level analogue of holding the previous view in {@link TransitionRouterOutlet}: use
 * it for a resource that *persists* across a navigation (a layout/shell resource, or a reused
 * route on a param change), where the outlet's view-hold doesn't apply.
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
  options?: { injector?: Injector },
): HeldResource<T> {
  const run = <R>(fn: () => R): R =>
    options?.injector ? runInInjectionContext(options.injector, fn) : fn();

  return run(() => {
    const router = inject(Router);
    const live = liveSnapshot(resource);

    // single push→pull bridge: a scan over navigation events tracks the hold mode and the
    // pre-nav snapshot, captured (synchronously, at the event) only when ENTERING frozen — so
    // a redirect/superseded cancel followed by a new NavigationStart keeps the original.
    const navState = toSignal(
      router.events.pipe(
        scan<unknown, NavState<T>>(
          (state, e) => {
            switch ((e as { type: EventType }).type) {
              case EventType.NavigationStart:
                return state.mode === 'frozen'
                  ? state // already frozen (superseded) — keep the original snapshot
                  : { mode: 'frozen', frozen: untracked(live) };
              case EventType.NavigationEnd:
              case EventType.NavigationSkipped:
                return { mode: 'live', frozen: state.frozen };
              case EventType.NavigationError:
                return { mode: 'rollback', frozen: state.frozen };
              case EventType.NavigationCancel: {
                const code = (e as { code: NavigationCancellationCode }).code;
                return code ===
                  NavigationCancellationCode.SupersededByNewNavigation ||
                  code === NavigationCancellationCode.Redirect
                  ? state // a new navigation is taking over — stay as-is
                  : { mode: 'rollback', frozen: state.frozen };
              }
              default:
                return state;
            }
          },
          { mode: 'live', frozen: untracked(live) },
        ),
      ),
      { initialValue: { mode: 'live', frozen: untracked(live) } },
    );

    const stable = linkedSignal<
      { ns: NavState<T>; live: ResourceSnapshot<T> },
      ResourceSnapshot<T>
    >({
      source: () => ({ ns: navState(), live: live() }),
      computation: ({ ns, live: liveSnap }) => {
        if (ns.mode === 'frozen') return ns.frozen;
        // rollback: hold the pre-nav snapshot until the cancelled load settles, then reveal
        if (ns.mode === 'rollback')
          return isLoadingStatus(liveSnap.status) ? ns.frozen : liveSnap;
        return liveSnap;
      },
    });

    return buildHeldResource(stable, resource);
  });
}

function buildHeldResource<T>(
  snapshot: Signal<ResourceSnapshot<T>>,
  source: ResourceRef<T>,
): HeldResource<T> {
  const value = computed(() => {
    const s = snapshot();
    return s.status === ResourceStatus.Error ? (undefined as T) : s.value;
  });

  const hasValue = (() => {
    const s = snapshot();
    return s.status !== ResourceStatus.Error && s.value !== undefined;
  }) as HeldResource<T>['hasValue'];

  return {
    value,
    status: computed(() => snapshot().status),
    error: computed(() => {
      const s = snapshot();
      return s.status === ResourceStatus.Error ? s.error : undefined;
    }),
    isLoading: computed(() => isLoadingStatus(snapshot().status)),
    hasValue,
    reload: () => source.reload(),
  };
}
