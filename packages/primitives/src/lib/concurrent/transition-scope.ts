import {
  computed,
  DestroyRef,
  inject,
  InjectionToken,
  isDevMode,
  linkedSignal,
  ResourceStatus,
  signal,
  untracked,
  type Provider,
  type ResourceRef,
  type Signal,
} from '@angular/core';
import { mutable } from '../mutable';

/**
 * What "not ready" means for first-load suspense:
 *  - `'value'`: the resource has no value yet (`!hasValue()`). With `keepPrevious`,
 *    this stays false through a reload — the previous value holds — so a transition
 *    does NOT re-suspend; only the genuine first load shows a placeholder.
 *  - `'loading'`: any in-flight request suspends, even a background reload.
 */
export type SuspendType = 'value' | 'loading';

export type RegisterOptions = {
  /**
   * Whether this resource blocks the boundary's first paint (`suspended()`).
   * `true` for things the subtree can't render without (e.g. lazily-loaded component
   * code); `false` for in-region data, which should drive the transition indicator
   * (`pending`) and hold-stale, but NOT blank the whole boundary while it first loads.
   */
  readonly suspends?: boolean;
};

/**
 * A transition scope: the set of resources whose async state a boundary coordinates.
 * Provided per-boundary (so nested boundaries are independent — the transition-scoped,
 * not global, registry) with a root default so registration always lands somewhere.
 */
export type TransitionScope = {
  /** The currently-registered resources (read-only view). */
  readonly resources: Signal<readonly ResourceRef<any>[]>;
  /**
   * Any registered resource has a request in flight (`status` is `loading`/`reloading`).
   * This is the transition indicator — true during a reload while `keepPrevious` holds
   * the visible value, so the UI can show "updating…" without unmounting.
   */
  readonly pending: Signal<boolean>;
  /** Any *suspending* resource is not ready — drives the first-load placeholder. */
  suspended(type: SuspendType): boolean;
  add(res: ResourceRef<any>, opt?: RegisterOptions): void;
  remove(res: ResourceRef<any>): void;
  /**
   * Coordinated commit: wraps a value signal so it FREEZES at its last-settled value
   * while the scope is `pending`, then reveals the current value once *everything*
   * settles. Multiple values wrapped this way release together — one consistent frame,
   * never a torn mix of new + stale across resources. Compose over a `keepPrevious`
   * value: keepPrevious holds per-resource, `commit` gates the reveal on the aggregate.
   */
  commit<T>(value: Signal<T>): Signal<T>;
  /**
   * Whether a transaction is currently HOLDING this scope's synchronous display reads (Tier 3).
   * A counter under the hood, so nested transactions compose. Distinct from `pending` (a resource
   * is in flight): `holding` brackets a whole transaction from start to settle.
   */
  readonly holding: Signal<boolean>;
  /** Begin a transaction hold (increment the counter). */
  beginHold(): void;
  /** End a transaction hold (decrement); reveals held values when the counter reaches 0. */
  endHold(): void;
  /**
   * Tier 3 display hold: wraps a value so it FREEZES at its pre-hold value while the scope is
   * `holding`, then reveals the live value when the hold ends. Unlike `commit` (gates on
   * `pending`), this brackets the whole transaction — so a *synchronous* state write made inside
   * the transaction stays visually held until the transaction settles, with no torn frame.
   */
  hold<T>(value: Signal<T>): Signal<T>;
};

type Entry = { readonly ref: ResourceRef<any>; readonly suspends: boolean };

export function createTransitionScope(): TransitionScope {
  const list = mutable<Entry[]>([]);

  const pending = computed(() =>
    list().some(({ ref }) => {
      const s = ref.status();
      return s === ResourceStatus.Loading || s === ResourceStatus.Reloading;
    }),
  );

  const holdCount = signal(0);
  const holding = computed(() => holdCount() > 0);

  return {
    resources: computed(() => list().map((e) => e.ref)),
    pending,
    suspended: (type) =>
      list().some(
        ({ ref, suspends }) =>
          suspends && (type === 'loading' ? ref.isLoading() : !ref.hasValue()),
      ),
    add: (ref, opt) =>
      untracked(() =>
        list.inline((c) => c.push({ ref, suspends: opt?.suspends ?? true })),
      ),
    remove: (ref) =>
      untracked(() =>
        list.inline((c) => {
          const i = c.findIndex((e) => e.ref === ref);
          if (i !== -1) c.splice(i, 1);
        }),
      ),
    commit: <T>(value: Signal<T>): Signal<T> =>
      linkedSignal<{ v: T; settled: boolean }, T>({
        source: () => ({ v: value(), settled: !pending() }),
        computation: (curr, prev) =>
          curr.settled || prev === undefined ? curr.v : prev.value,
      }),
    holding,
    beginHold: () => untracked(() => holdCount.update((c) => c + 1)),
    endHold: () =>
      untracked(() => holdCount.update((c) => (c > 0 ? c - 1 : 0))),
    hold: <T>(value: Signal<T>): Signal<T> =>
      linkedSignal<{ v: T; held: boolean }, T>({
        source: () => ({ v: value(), held: holding() }),
        computation: (curr, prev) =>
          prev !== undefined && curr.held ? prev.value : curr.v,
      }),
  };
}

function createNoopScope(): TransitionScope {
  return {
    resources: computed(() => []),
    pending: computed(() => false),
    suspended: () => false,
    add: () => {
      // noop
    },
    remove: () => {
      // noop
    },
    commit: <T>(value: Signal<T>): Signal<T> => value,
    holding: computed(() => false),
    beginHold: () => {
      // noop
    },
    endHold: () => {
      // noop
    },
    hold: <T>(value: Signal<T>): Signal<T> => value,
  };
}

const TRANSITION_SCOPE = new InjectionToken<TransitionScope>(
  '@mmstack/primitives:transition-scope',
);

/** Provide a fresh transition scope at a boundary so its subtree's resources are tracked independently. */
export function provideTransitionScope(): Provider {
  return { provide: TRANSITION_SCOPE, useFactory: createTransitionScope };
}

export function injectTransitionScope(): TransitionScope {
  const scope = inject(TRANSITION_SCOPE, { optional: true });

  if (!scope) {
    if (isDevMode())
      console.warn(
        '[mmstack/primitives] No transition scope in context — registration/tracking here is a no-op. ' +
          'Use a <mm-suspense> boundary or provideTransitionScope() in an ancestor.',
      );
    return createNoopScope();
  }

  return scope;
}

/**
 * Returns a register function bound to the nearest transition scope: it adds a resource
 * to the scope and removes it when the caller's injection context is destroyed. Pass any
 * `ResourceRef` (a query, mutation, or plain Angular resource) through it.
 */
export function injectRegisterResource() {
  const scope = injectTransitionScope();
  const destroyRef = inject(DestroyRef);

  return <T extends ResourceRef<any>>(res: T, opt?: RegisterOptions): T => {
    scope.add(res, opt);
    destroyRef.onDestroy(() => scope.remove(res));
    return res;
  };
}

/** Convenience: register a resource with the nearest transition scope. Must run in an injection context. */
export function registerResource<T extends ResourceRef<any>>(
  res: T,
  opt?: RegisterOptions,
): T {
  return injectRegisterResource()(res, opt);
}
