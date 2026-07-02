import {
  computed,
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  type Injector,
  isDevMode,
  linkedSignal,
  PendingTasks,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type Provider,
  type ResourceStatus,
  type Signal,
} from '@angular/core';
import { mutable } from '../mutable';

/**
 * The structural surface a transition scope actually reads — everything a `ResourceRef`
 * has, so any resource (query, mutation, plain Angular `resource`) passes as-is, but also
 * satisfied by status-bearing derivations like `latest()`, so those register too.
 *
 * `abort` is the optional cancellation seam: a resource that knows how to tear down its
 * in-flight work exposes it (`queryResource` does; mutations deliberately don't — a POST
 * can't be unsent), and {@link TransitionScope.abortPending} calls it. Resources without
 * it are simply left to settle.
 */
export type ResourceLike = {
  readonly status: Signal<ResourceStatus>;
  readonly isLoading: Signal<boolean>;
  hasValue(): boolean;
  abort?(): void;
};

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
  readonly resources: Signal<readonly ResourceLike[]>;
  /**
   * Any registered resource has a request in flight (`status` is `loading`/`reloading`).
   * This is the transition indicator — true during a reload while `keepPrevious` holds
   * the visible value, so the UI can show "updating…" without unmounting.
   */
  readonly pending: Signal<boolean>;
  /** Any *suspending* resource is not ready — drives the first-load placeholder. */
  suspended(type: SuspendType): boolean;
  add(res: ResourceLike, opt?: RegisterOptions): void;
  remove(res: ResourceLike): void;
  /**
   * Coordinated commit: wraps a value signal so it FREEZES at its last-settled value
   * while the scope is `pending`, then reveals the current value once *everything*
   * settles. Multiple values wrapped this way release together — one consistent frame,
   * never a torn mix of new + stale across resources. Compose over a `keepPrevious`
   * value: keepPrevious holds per-resource, `commit` gates the reveal on the aggregate.
   */
  commit<T>(value: Signal<T>): Signal<T>;
  /**
   * THE CANCELLATION CONTRACT, and its manual lever for shared-scope cases.
   *
   * What holds by construction (no call needed):
   * - **View-scoped work dies with its view.** A superseded transition (outlet or
   *   `*mmTransition`) destroys the hidden incoming view and its injector; resources
   *   created there are destroyed, which aborts their in-flight loads.
   * - **Abort is real, all the way down.** Deduped HTTP requests are refCounted — when
   *   the last consumer lets go the request itself is torn down — and an aborted
   *   response can never settle into the query cache (cache writes happen on the
   *   subscriber side of the interceptor chain).
   *
   * What this method adds: resources registered in a scope that OUTLIVES the transition
   * (a shared/root scope) aren't view-scoped, so nothing destroys them on supersede.
   * `abortPending()` walks the registered resources and calls `abort()` on every
   * in-flight one that exposes it ({@link ResourceLike.abort} — queries do, mutations
   * deliberately don't, and a shared resource aborts for ALL its readers, so call this
   * on interactions that invalidate the pending work, not as a reflex).
   *
   * Honest limit (true for every JS framework): only I/O is cancellable — an
   * already-running synchronous computation cannot be preempted.
   *
   * @returns how many resources were actually aborted.
   */
  abortPending(): number;
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

type Entry = { readonly ref: ResourceLike; readonly suspends: boolean };

export function createTransitionScope(): TransitionScope {
  const list = mutable<Entry[]>([]);

  const pending = computed(() =>
    list().some(({ ref }) => {
      const s = ref.status();
      return s === 'loading' || s === 'reloading';
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
    abortPending: () =>
      untracked(() => {
        let aborted = 0;
        for (const { ref } of list()) {
          const s = ref.status();
          if ((s === 'loading' || s === 'reloading') && ref.abort) {
            ref.abort();
            aborted++;
          }
        }
        return aborted;
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
    abortPending: () => 0,
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

/**
 * The scope→`PendingTasks` bridge: while `scope.pending()` is true, hold an Angular
 * pending task so SSR serialization waits for the scope's in-flight loads — HTTP loads
 * already do this via HttpClient, but CUSTOM loaders (a `latest()` over a hand-rolled
 * promise, a non-HTTP resource) would otherwise let the server render a boundary
 * mid-load. Wired automatically by `provideTransitionScope` /
 * `provideForwardingTransitionScope`; call it yourself only for scopes you construct
 * directly with `createTransitionScope()`.
 *
 * Server-only by design: on the browser, tying `ApplicationRef.isStable` to every load
 * would stall stability-gated machinery (testability, hydration timing) for no benefit.
 */
export function bridgeScopeToPendingTasks(
  scope: TransitionScope,
  injector?: Injector,
): void {
  const run = <T>(fn: () => T): T =>
    injector ? runInInjectionContext(injector, fn) : fn();
  run(() => {
    if (inject(PLATFORM_ID) !== 'server') return;
    const tasks = inject(PendingTasks);
    let done: (() => void) | null = null;
    effect(() => {
      if (scope.pending()) done ??= tasks.add();
      else {
        done?.();
        done = null;
      }
    });
    inject(DestroyRef).onDestroy(() => {
      done?.();
      done = null;
    });
  });
}

/** Provide a fresh transition scope at a boundary so its subtree's resources are tracked independently. */
export function provideTransitionScope(): Provider {
  return {
    provide: TRANSITION_SCOPE,
    useFactory: () => {
      const scope = createTransitionScope();
      bridgeScopeToPendingTasks(scope);
      return scope;
    },
  };
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
 * A transition scope that can be re-pointed at a delegate target at runtime. Reads and
 * commit/hold follow the current target; `add`/`remove` pin to the target that was current
 * at add-time, so re-pointing between a resource's registration and its destroy-time removal
 * never strands it in the wrong scope. With no target it behaves as a plain own-scope.
 */
export type ForwardingTransitionScope = TransitionScope & {
  setTarget(target: TransitionScope | null): void;
};

export function createForwardingScope(): ForwardingTransitionScope {
  const own = createTransitionScope();
  const target = signal<TransitionScope | null>(null);
  const eff = () => target() ?? own;
  const owners = new Map<ResourceLike, TransitionScope>();

  return {
    setTarget: (t) => target.set(t),
    resources: computed(() => eff().resources()),
    pending: computed(() => eff().pending()),
    suspended: (type) => eff().suspended(type),
    add: (ref, opt) => {
      const t = untracked(target) ?? own;
      owners.set(ref, t);
      t.add(ref, opt);
    },
    remove: (ref) => {
      const t = owners.get(ref) ?? untracked(target) ?? own;
      t.remove(ref);
      owners.delete(ref);
    },
    commit: <T>(value: Signal<T>): Signal<T> =>
      linkedSignal<{ v: T; settled: boolean }, T>({
        source: () => ({ v: value(), settled: !eff().pending() }),
        computation: (curr, prev) =>
          curr.settled || prev === undefined ? curr.v : prev.value,
      }),
    abortPending: () => (untracked(target) ?? own).abortPending(),
    holding: computed(() => eff().holding()),
    beginHold: () => (untracked(target) ?? own).beginHold(),
    endHold: () => (untracked(target) ?? own).endHold(),
    hold: <T>(value: Signal<T>): Signal<T> =>
      linkedSignal<{ v: T; held: boolean }, T>({
        source: () => ({ v: value(), held: eff().holding() }),
        computation: (curr, prev) =>
          prev !== undefined && curr.held ? prev.value : curr.v,
      }),
  };
}

/** Provide a forwarding transition scope at a boundary (used by the transition outlet). */
export function provideForwardingTransitionScope(): Provider {
  return {
    provide: TRANSITION_SCOPE,
    useFactory: () => {
      const scope = createForwardingScope();
      bridgeScopeToPendingTasks(scope);
      return scope;
    },
  };
}

/** Read the transition scope reachable from `injector`, or null if none is provided there. */
export function getTransitionScope(injector: Injector): TransitionScope | null {
  return injector.get(TRANSITION_SCOPE, null);
}

/**
 * @internal Transaction-attributed pending for `startTransition`/`startTransaction`: like
 * `scope.pending`, but loads already in flight when the tracker is created are NOT attributed —
 * a pre-existing background load can neither settle the transaction early nor block its settle
 * forever. A pre-existing flight is excluded only until it first settles; a later re-trigger of
 * the same resource (e.g. the transaction's write changed its request) counts as the
 * transaction's own work.
 */
export function createAttributedPending(
  scope: TransitionScope,
): Signal<boolean> {
  const isInFlight = (ref: ResourceLike): boolean => {
    const s = untracked(ref.status);
    return s === 'loading' || s === 'reloading';
  };
  const preexisting = new Set(untracked(scope.resources).filter(isInFlight));

  return computed(() => {
    let pending = false;
    for (const ref of scope.resources()) {
      const s = ref.status();
      const loading = s === 'loading' || s === 'reloading';
      if (preexisting.has(ref)) {
        // deletes are monotonic, so this stays sound under re-computation
        if (loading) continue;
        preexisting.delete(ref);
        continue;
      }
      if (loading) pending = true;
    }
    return pending;
  });
}

/**
 * Returns a register function bound to the nearest transition scope: it adds a resource
 * to the scope and removes it when the caller's injection context is destroyed. Pass any
 * `ResourceRef` (a query, mutation, or plain Angular resource) through it.
 */
export function injectRegisterResource() {
  const scope = injectTransitionScope();
  const destroyRef = inject(DestroyRef);

  return <T extends ResourceLike>(res: T, opt?: RegisterOptions): T => {
    scope.add(res, opt);
    destroyRef.onDestroy(() => scope.remove(res));
    return res;
  };
}

/** Convenience: register a resource with the nearest transition scope. Must run in an injection context. */
export function registerResource<T extends ResourceLike>(
  res: T,
  opt?: RegisterOptions,
): T {
  return injectRegisterResource()(res, opt);
}
