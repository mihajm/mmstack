import {
  computed,
  DestroyRef,
  EnvironmentInjector,
  inject,
  Injector,
  resource,
  runInInjectionContext,
  signal,
  type ResourceOptions,
  type ResourceRef,
  type Signal,
} from '@angular/core';
import {
  type CensusError,
  type CensusMember,
  type MemberId,
  memberId,
} from './census';
import { injectCensus } from './census-token';

let ordinal = 0;

/** What a census needs to name the member a resource enrolls as, on top of what `resource` needs. */
export interface CensusResourceIdentity {
  /** The member-id site key — the resource's KIND, stable across every instance of it. */
  readonly site: string;
  /** What a boundary calls this member when it presents. */
  readonly displayName: string;
}

/**
 * **An Angular `resource` that enrols itself in the nearest boundary census.** Outside every
 * boundary the census is null and this is a plain `resource`, so the same call site serves code
 * inside and outside a boundary without asking which one it is in.
 *
 * The projection is fixed, because a readiness member has one honest reading of a resource:
 * `pending` and `inFlight` are `isLoading` (a reload IS in flight and IS the fold's business),
 * `failure` is the resource's error state, and `retry` is the resource's own `reload` — honorable by
 * construction rather than by a promise the call site makes. The failure carries no message: a
 * runtime fault is dynamic, so a boundary presents its own generic copy.
 *
 * Enrolment is undone at destroy through `DestroyRef`. Passing `injector` moves BOTH halves to that
 * injector — the resource and the census it looks for — so a resource created away from its owner's
 * context never enrols in a boundary its owner is not inside.
 */
export function censusResource<T, R>(
  options: ResourceOptions<T, R> &
    CensusResourceIdentity & { defaultValue: NoInfer<T> },
): ResourceRef<T>;
export function censusResource<T, R>(
  options: ResourceOptions<T, R> & CensusResourceIdentity,
): ResourceRef<T | undefined>;
export function censusResource<T, R>(
  options: ResourceOptions<T, R> & CensusResourceIdentity,
): ResourceRef<T | undefined> {
  const { site, displayName, ...resourceOptions } = options;
  const injector = options.injector ?? inject(Injector);

  /**
   * The loader is scheduled on the ENVIRONMENT injector, never the component's, and the difference
   * is a deadlock: a pending member holds its boundary, the hold detaches the enrolling component's
   * change detection, and a component-scheduled loader only runs WITH that change detection — so
   * the member could never settle the very hold its pending state caused. A member must be able to
   * settle while the presentation it gates is held. The resource still dies with the component:
   * destruction rides the component's `DestroyRef`.
   */
  const env = injector.get(EnvironmentInjector);
  const ref = resource<T, R>({
    ...resourceOptions,
    injector: env,
  } as ResourceOptions<T, R>);

  runInInjectionContext(injector, () => {
    inject(DestroyRef).onDestroy(() => ref.destroy());
    const census = injectCensus();
    if (census === null) return;
    const leave = census.register(
      memberOf(ref, memberId(site, (ordinal += 1)), displayName),
    );
    inject(DestroyRef).onDestroy(leave);
  });

  return ref;
}

/** The half of a resource a census reads, stated structurally: the member is a function of these
 * three and nothing about the value type. */
interface ResourceSurface {
  readonly isLoading: Signal<boolean>;
  readonly error: Signal<unknown>;
  reload(): boolean;
}

function memberOf(
  ref: ResourceSurface,
  id: MemberId,
  displayName: string,
): CensusMember {
  const never = signal(false);
  const loading = computed(() => ref.isLoading());
  return {
    id,
    displayName,
    readiness: true,
    paused: never,
    pending: loading,
    inFlight: loading,
    failure: computed<CensusError | undefined>(() =>
      ref.error() === undefined
        ? undefined
        : { id, displayName, message: undefined },
    ),
    retry: { retry: () => void ref.reload() },
  };
}
