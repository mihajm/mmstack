import {
  computed,
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  Injector,
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
  type WritableSignal,
} from '@angular/core';
import { mutable } from '../mutable';
import {
  type CensusError,
  type CensusMember,
  type CensusRegistry,
  type ErroredEntry,
  type MemberId,
  memberId,
  ordinalOf,
  type Precedence,
  type RetryRound,
} from './census';
import { createCensus } from './census-registry';
import { BOUNDARY_CENSUS } from './census-token';
import {
  beginOwnHold,
  endOwnHold,
  inheritHoldSeeds,
  preHoldValueOf,
  redirectHoldSeeds,
} from './hold-seed';
import {
  guessableInternals,
  type GuessableInternals,
  truthOfCell,
} from './optimistic-seam';
import {
  dismissableEntries,
  dismissAllEntries,
  dismissEntry,
  EMPTY_DISMISSALS,
  presentedErrored,
  type DismissalMap,
} from './dismiss';
import {
  CONCURRENCY_INSTRUMENTATION,
  type ConcurrencyInstrumentation,
} from './instrumentation';
import { resourceHasContent, resourceMember } from './resource-member';
import { censusSettled } from './settlement';
import { type SettlementDeadline } from './settlement-deadline';

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
  /** The current error, read for the message a boundary presents when the resource fails. */
  readonly error?: Signal<unknown>;
  /**
   * Re-run the load. When present, a failed resource is retryable from its boundary
   * ({@link TransitionScope.retry} / {@link TransitionScope.retryAll}).
   */
  reload?(): unknown;
  /**
   * Whether there is something to show, including a value held through a failed reload.
   * `hasValue()` follows Angular's rule and turns false on error even while a held value is
   * still displayed; readiness reads this instead when present, so a failed background reload
   * never blanks content the user is reading. Falls back to `hasValue()`.
   */
  hasContent?(): boolean;
  /**
   * How many loads this resource has started, counting every request change and reload,
   * including one that aborts and replaces a load in flight. Monotone. When present, a
   * transaction tells its own loads apart from ones already in flight when it started, however
   * quickly they settle and restart; without it (or while it reads `undefined`) that is
   * best-effort.
   */
  readonly loads?: Signal<number | undefined>;
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
  /** What the boundary calls this resource when it fails (`errored` entries). Defaults to `'resource'`. */
  readonly displayName?: string;
  /**
   * `'mutation'` registers a write: it drives `pending` but never suspends (`suspends` is
   * ignored), has no retry, and its last failure stays in `errored` until dismissed or the next
   * mutation starts. Defaults to `'resource'`.
   */
  readonly kind?: 'resource' | 'mutation';
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
   * Any registered resource has a request in flight (`isLoading()`, or `status` is
   * `loading`/`reloading`). This is the transition indicator — true during a reload while
   * `keepPrevious` holds the visible value, so the UI can show "updating…" without unmounting.
   * It reads activity, never a status fold: a registration whose status settled to `'error'`
   * while it still has work in flight keeps this true.
   */
  readonly pending: Signal<boolean>;
  /**
   * Any *suspending* resource is not ready — drives the first-load placeholder. `'value'` is the
   * census fold reading `pending`: a suspending resource with no content that has not failed. A
   * failed first load leaves it, so the boundary presents {@link failed} instead of holding its
   * placeholder forever. Under `'error-first'` it also stays true while a suspending resource
   * has nothing to show and no failure blanks the boundary.
   */
  suspended(type: SuspendType): boolean;
  /**
   * Register a resource. EVERY `add` must be paired with a `remove` when the
   * registrant goes away — the scope holds the resource strongly and keeps
   * reading its `status` forever otherwise (stale `pending`, pinned memory).
   * Prefer {@link registerResource} / `injectRegisterResource`, which pair the
   * removal with the caller's `DestroyRef` automatically.
   */
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
   *
   * A hold on a scope also holds the scopes provided inside it (`provideTransitionScope`, nested
   * boundaries, `*mmTransition` branches): they report `holding()` too, so a view mounted there
   * stays with the held page. Only the hold is shared; `pending` and the census stay per scope.
   * One exception: the fallback scope a forwarding scope uses while it has no target is not
   * linked to anything around it and cannot take part in an observable hold.
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
   *
   * A reader first read while the scope is held shows a recorded signal as it was before the
   * first write since that hold began, counting holds inherited from enclosing scopes, so it
   * joins the frame the rest of the held page shows. Anything not recorded reads live.
   */
  hold<T>(value: Signal<T>): Signal<T>;
  /**
   * The boundary should present its error slot: the census fold is `error` and at least one
   * suspending member has failed with no content to show. A failed background reload whose
   * value is still held (`keepPrevious`) does not count: that content stays, and the failure rides
   * {@link errored} instead. A readiness member registered directly in {@link census}
   * (`censusResource`) has no content reading, so its failure always counts.
   */
  readonly failed: Signal<boolean>;
  /** Every failing member, with or without content, minus dismissed ones: the indicator reading. */
  readonly errored: Signal<readonly ErroredEntry[]>;
  /** Every failing member's error, ignoring dismissal. */
  readonly failures: Signal<readonly CensusError[]>;
  /** Retry the member(s) with this id: a round that re-runs each capable member at most once. */
  retry(id: MemberId): RetryRound;
  /** Retry every capable member that is not already in flight, as one round. */
  retryAll(): RetryRound;
  /** Hide one presented failure until that member fails again (only non-retryable members). */
  dismiss(entry: ErroredEntry): void;
  /** Dismiss every presented, dismissable failure. */
  dismissAll(): void;
  /**
   * Resolves once the fold has left `pending` after the reactive graph drained: `'idle'` when
   * everything settled cleanly, `'error'` when something failed.
   */
  settled(): Promise<'idle' | 'error'>;
  /**
   * The census this scope folds over. Registrations land here as members; other members
   * (`censusResource`, enrolled facades) join it through the boundary token. For advanced use.
   */
  readonly census: CensusRegistry;
};

type Entry = {
  readonly ref: ResourceLike;
  readonly member: CensusMember;
  readonly unregister: () => void;
  readonly suspends: boolean;
};

const MEMBER_SITE = 'transition-scope';
const DEFAULT_DISPLAY_NAME = 'resource';

const statusInFlight = (s: ResourceStatus): boolean =>
  s === 'loading' || s === 'reloading';

export type CreateTransitionScopeOptions = {
  /** Scope identity for instrumentation events (idea/concurrency-devtools.md). */
  readonly name?: string;
  /** Optional observability listener; taps are no-ops when omitted (zero cost). */
  readonly instrumentation?: ConcurrencyInstrumentation;
  /**
   * Per-member settlement backstop: a suspending member that has not settled within `ms` of its
   * registration is declared failed, so the boundary presents an error instead of waiting forever.
   * Absent by default.
   */
  readonly deadline?: SettlementDeadline;
  /**
   * What the boundary shows when a suspending member is still loading and some member has failed.
   * - `'pending-first'` (the default): the placeholder (`suspended('value')`) holds until every
   *   suspending member settles, then the error slot (`failed`) shows if a failure is still there.
   * - `'error-first'`: a failure that blanks the boundary (a suspending member with no content, or
   *   a member registered directly in the census) shows the error slot at once, even while others
   *   load. A failure that does not blank (indicator-only, or content still held) does NOT end
   *   suspense: the placeholder holds while a suspending member has nothing to show.
   * Affects `suspended('value')`, `failed` and `settled()` only; `pending` and the transaction
   * reads do not fold.
   */
  readonly precedence?: Precedence;
  /**
   * Where the census schedules its drained checks (`retry(...).settled()`, `settled()`). Without
   * it those calls must run in an injection context. The providers pass their own injector.
   */
  readonly injector?: Injector;
};

export function createTransitionScope(
  opt?: CreateTransitionScopeOptions,
): TransitionScope {
  const list = mutable<Entry[]>([]);
  const inst = opt?.instrumentation;
  const name = opt?.name ?? 'scope';
  const at = (): number =>
    typeof globalThis.performance !== 'undefined'
      ? globalThis.performance.now()
      : Date.now();

  const census = createCensus({
    injector: opt?.injector,
    deadline: opt?.deadline,
    precedence: opt?.precedence,
  });

  // The scope's own activity fold over EVERY registration, indicator-only ones included. The
  // census `inFlight` is readiness-only, so it is not this reading.
  const pending = computed(() =>
    list().some(
      ({ ref, member }) => member.inFlight() || statusInFlight(ref.status()),
    ),
  );

  // Blanks the boundary: the fold is `error` and some failing readiness member has no content.
  // Registrations answer `hasContent()`; a member registered directly in the census
  // (`censusResource`) counts as no content unless it carries its own `content` witness.
  const failed = computed(() => {
    if (census.foldState().kind !== 'error') return false;
    const listed = new Set<MemberId>();
    const blank = new Set<MemberId>();
    for (const { ref, member, suspends } of list()) {
      listed.add(member.id);
      if (suspends && !resourceHasContent(ref)) blank.add(member.id);
    }
    // Read through the census, so a failure it synthesizes (the settlement deadline) counts too.
    return census
      .errored()
      .some(
        ({ member }) =>
          member.readiness &&
          (listed.has(member.id)
            ? blank.has(member.id)
            : !(member.content?.() ?? false)),
      );
  });

  const dismissed = signal<DismissalMap>(EMPTY_DISMISSALS);
  const errored = computed(() =>
    presentedErrored(census.errored(), dismissed()),
  );

  const holdCount = signal(0);
  const holdParent = signal<TransitionScope | null>(null);
  const holding = computed(() => holdCount() > 0 || !!holdParent()?.holding());

  const reportRound = (round: RetryRound): RetryRound => {
    inst?.retryRound?.({ scope: name, dispatched: round.dispatched, at: at() });
    return round;
  };

  const self: TransitionScope = {
    resources: computed(() => list().map((e) => e.ref)),
    pending,
    suspended: (type) =>
      type === 'loading'
        ? list().some(({ member, suspends }) => suspends && member.inFlight())
        : census.foldState().kind === 'pending' ||
          // Under 'error-first' a failure that does not blank must not end suspense while a
          // suspending registration still has nothing to show. Never true under 'pending-first'.
          (!failed() &&
            list().some(
              ({ member, suspends }) => suspends && member.pending(),
            )),
    add: (ref, o) =>
      untracked(() => {
        const suspends = o?.kind === 'mutation' ? false : (o?.suspends ?? true);
        const member = resourceMember(ref, {
          id: memberId(MEMBER_SITE, ordinalOf(ref)),
          displayName: o?.displayName ?? DEFAULT_DISPLAY_NAME,
          suspends,
          kind: o?.kind,
        });
        const unregister = census.register(member);
        list.inline((c) => c.push({ ref, member, unregister, suspends }));
        inst?.resourceRegistered?.({ scope: name, suspends });
      }),
    remove: (ref) =>
      untracked(() => {
        const i = list().findIndex((e) => e.ref === ref);
        if (i === -1) return;
        const entry = list()[i];
        list.inline((c) => c.splice(i, 1));
        entry.unregister();
        inst?.resourceRemoved?.({ scope: name });
      }),
    commit: <T>(value: Signal<T>): Signal<T> =>
      committedReader(value, () => !pending()),
    abortPending: () =>
      untracked(() => {
        let aborted = 0;
        for (const { ref } of list()) {
          if (statusInFlight(ref.status()) && ref.abort) {
            ref.abort();
            aborted++;
          }
        }
        if (aborted > 0)
          inst?.abortPending?.({ scope: name, aborted, at: at() });
        return aborted;
      }),
    holding,
    beginHold: () =>
      untracked(() => {
        if (holdCount() === 0) beginOwnHold(self);
        holdCount.update((c) => c + 1);
      }),
    endHold: () =>
      untracked(() => {
        if (holdCount() === 0) return;
        holdCount.update((c) => c - 1);
        if (holdCount() === 0) endOwnHold(self);
      }),
    hold: <T>(value: Signal<T>): Signal<T> => heldReader(self, value, holding),
    failed,
    errored,
    failures: census.failures,
    retry: (id) => reportRound(census.retry(id)),
    retryAll: () => reportRound(census.retryAll()),
    dismiss: (entry) =>
      untracked(() => {
        const before = dismissed();
        const next = dismissEntry(before, entry);
        dismissed.set(next);
        const id = entry.member.id;
        if (next.get(id) !== before.get(id))
          inst?.dismissed?.({
            scope: name,
            name: entry.failure.displayName,
            at: at(),
          });
      }),
    dismissAll: () =>
      untracked(() => {
        const before = dismissed();
        const entries = census.errored();
        dismissed.set(dismissAllEntries(before, entries));
        if (inst?.dismissed)
          for (const entry of dismissableEntries(before, entries))
            inst.dismissed({
              scope: name,
              name: entry.failure.displayName,
              at: at(),
            });
      }),
    settled: () => censusSettled(census, { injector: opt?.injector }),
    census,
  };
  holdParents.set(self, holdParent);
  holdResets.set(self, () =>
    untracked(() => {
      if (holdCount() === 0) return;
      holdCount.set(0);
      endOwnHold(self);
    }),
  );
  return self;
}

/** Ends a scope's own hold outright (the scope is destroyed while holding). */
const holdResets = new WeakMap<TransitionScope, () => void>();

/**
 * A frozen frame over a guessable is taken from the truth beneath its guesses; a visible guess
 * reads through it live, and a reverted one is never kept by the frame.
 */
function overGuess<T>(g: GuessableInternals, frozen: Signal<T>): Signal<T> {
  return computed(() => {
    const f = frozen();
    const [has, v] = g.visible();
    return (has ? v : f) as T;
  });
}

/** `hold()`: freezes at the pre-hold value while `held()`; a mid-hold first read is seeded. */
function heldReader<T>(
  self: object,
  value: Signal<T>,
  held: () => boolean,
): Signal<T> {
  const g = guessableInternals(value);
  const src = (g ? g.truth : value) as Signal<T>;
  const frozen = linkedSignal<{ v: T; held: boolean }, T>({
    source: () => ({ v: src(), held: held() }),
    computation: (curr, prev) => {
      if (prev !== undefined) return curr.held ? prev.value : curr.v;
      if (!curr.held) return curr.v;
      const seed = preHoldValueOf(self, g ? g.port : value);
      if (!seed) return curr.v;
      return (g ? truthOfCell(seed.value) : seed.value) as T;
    },
  });
  return g ? overGuess(g, frozen) : frozen;
}

/** `commit()`: freezes at the last settled value while `settled()` is false. */
function committedReader<T>(
  value: Signal<T>,
  settled: () => boolean,
): Signal<T> {
  const g = guessableInternals(value);
  const src = (g ? g.truth : value) as Signal<T>;
  const frozen = linkedSignal<{ v: T; settled: boolean }, T>({
    source: () => ({ v: src(), settled: settled() }),
    computation: (curr, prev) =>
      curr.settled || prev === undefined ? curr.v : prev.value,
  });
  return g ? overGuess(g, frozen) : frozen;
}

/** Each plain scope's link to the scope it inherits its hold from. */
const holdParents = new WeakMap<
  TransitionScope,
  WritableSignal<TransitionScope | null>
>();

/** A hold on `parent` also holds `scope` (and seeds its mid-hold readers). */
function inheritHold(scope: TransitionScope, parent: TransitionScope): void {
  holdParents.get(scope)?.set(parent);
  inheritHoldSeeds(scope, parent);
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
    failed: computed(() => false),
    errored: computed(() => []),
    failures: computed(() => []),
    retry: () => EMPTY_ROUND,
    retryAll: () => EMPTY_ROUND,
    dismiss: () => {
      // noop
    },
    dismissAll: () => {
      // noop
    },
    settled: () => Promise.resolve('idle'),
    census: createCensus(),
  };
}

const EMPTY_ROUND: RetryRound = {
  generation: 0,
  dispatched: 0,
  settled: () => Promise.resolve(),
};

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

/**
 * The reactive taps, which need an injection context: while a listener is installed, bracket each
 * pending window of `scope` with a `pendingStart`/`pendingEnd` span, and report each member that
 * starts failing through `resourceFailed`. Each tap exists only when its hook does, so the bridge
 * is zero-cost by default.
 */
function bridgeScopeToInstrumentation(
  scope: TransitionScope,
  name: string,
  inst: ConcurrencyInstrumentation | undefined,
  injector?: Injector,
): void {
  if (!inst) return;
  const run = <T>(fn: () => T): T =>
    injector ? runInInjectionContext(injector, fn) : fn();
  const at = (): number =>
    typeof globalThis.performance !== 'undefined'
      ? globalThis.performance.now()
      : Date.now();
  run(() => {
    if (inst.resourceFailed) reportFailures(scope, name, inst, at);
    if (!inst.pendingStart && !inst.pendingEnd) return;
    let handle: unknown;
    let open = false;
    effect(() => {
      const pending = scope.pending();
      untracked(() => {
        if (pending && !open) {
          open = true;
          handle = inst.pendingStart?.({
            scope: name,
            resources: scope.resources().length,
            at: at(),
          });
        } else if (!pending && open) {
          open = false;
          inst.pendingEnd?.(handle, { at: at() });
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      if (open) inst.pendingEnd?.(handle, { at: at() });
    });
  });
}

/** Report each member whose failure appears, once per failure episode (dismissal ignored). */
function reportFailures(
  scope: TransitionScope,
  name: string,
  inst: ConcurrencyInstrumentation,
  at: () => number,
): void {
  let failing = new Set<MemberId>();
  effect(() => {
    const failures = scope.failures();
    untracked(() => {
      const next = new Set<MemberId>();
      for (const f of failures) {
        if (!failing.has(f.id) && !next.has(f.id))
          inst.resourceFailed?.({
            scope: name,
            name: f.displayName,
            message: f.message,
            at: at(),
          });
        next.add(f.id);
      }
      failing = next;
    });
  });
}

/**
 * Provide a fresh transition scope at a boundary so its subtree's resources are tracked
 * independently. The scope's census is provided as the boundary census too, so members that
 * register through it (`censusResource`) fold into the same boundary.
 */
export function provideTransitionScope(
  opt?: CreateTransitionScopeOptions,
): Provider {
  return [scopeProvider(opt), scopeCensusProvider];
}

function scopeProvider(opt?: CreateTransitionScopeOptions): Provider {
  return {
    provide: TRANSITION_SCOPE,
    useFactory: () => {
      const listener =
        opt?.instrumentation ??
        inject(CONCURRENCY_INSTRUMENTATION, { optional: true }) ??
        undefined;
      const scope = createTransitionScope({
        name: opt?.name,
        instrumentation: listener,
        deadline: opt?.deadline,
        precedence: opt?.precedence,
        injector: opt?.injector ?? inject(Injector),
      });
      const parent = inject(TRANSITION_SCOPE, {
        skipSelf: true,
        optional: true,
      });
      if (parent) inheritHold(scope, parent);
      // a scope destroyed while it holds must not keep the shared hold registry alive
      inject(DestroyRef).onDestroy(() => holdResets.get(scope)?.());
      bridgeScopeToPendingTasks(scope);
      bridgeScopeToInstrumentation(scope, opt?.name ?? 'scope', listener);
      return scope;
    },
  };
}

/** The scope's census doubles as the boundary census, so `censusResource` and facades join it. */
const scopeCensusProvider: Provider = {
  provide: BOUNDARY_CENSUS,
  useFactory: () => inject(TRANSITION_SCOPE).census,
};

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

export function createForwardingScope(
  opt?: CreateTransitionScopeOptions,
): ForwardingTransitionScope {
  const own = createTransitionScope(opt);
  const target = signal<TransitionScope | null>(null);
  const eff = () => target() ?? own;
  const current = () => untracked(target) ?? own;
  // WeakMap, deliberately: the forwarder usually outlives its targets (an outlet
  // re-pointing at per-route scopes). If a registrant ever misses its `remove`,
  // ephemeron semantics let the ref↔dead-target cycle collect once the registrant
  // drops the ref, instead of this map pinning every stranded pair forever.
  const owners = new WeakMap<ResourceLike, TransitionScope>();

  const self: ForwardingTransitionScope = {
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
      committedReader(value, () => !eff().pending()),
    abortPending: () => (untracked(target) ?? own).abortPending(),
    holding: computed(() => eff().holding()),
    beginHold: () => (untracked(target) ?? own).beginHold(),
    endHold: () => (untracked(target) ?? own).endHold(),
    hold: <T>(value: Signal<T>): Signal<T> =>
      heldReader(self, value, () => eff().holding()),
    failed: computed(() => eff().failed()),
    errored: computed(() => eff().errored()),
    failures: computed(() => eff().failures()),
    retry: (id) => current().retry(id),
    retryAll: () => current().retryAll(),
    dismiss: (entry) => current().dismiss(entry),
    dismissAll: () => current().dismissAll(),
    settled: () => current().settled(),
    census: createForwardingCensus(
      () => eff().census,
      () => current().census,
    ),
  };
  // seeders follow the hold to the scope it lands on
  redirectHoldSeeds(self, () => untracked(target) ?? own);
  return self;
}

/**
 * The census face of a forwarding scope: reads follow the current target, a member registers
 * into the target that is current at registration (and leaves from there), as `add` does.
 */
function createForwardingCensus(
  eff: () => CensusRegistry,
  current: () => CensusRegistry,
): CensusRegistry {
  return {
    register: (member) => current().register(member),
    enroll: (descriptor) => current().enroll(descriptor),
    snapshot: () => untracked(eff).snapshot(),
    foldState: computed(() => eff().foldState()),
    inFlight: computed(() => eff().inFlight()),
    failures: computed(() => eff().failures()),
    errored: computed(() => eff().errored()),
    retry: (id) => current().retry(id),
    retryAll: () => current().retryAll(),
  };
}

/**
 * Provide a forwarding transition scope at a boundary (used by the transition outlet). Its own
 * fallback scope takes `opt`; once re-pointed, the target's options apply.
 */
export function provideForwardingTransitionScope(
  opt?: CreateTransitionScopeOptions,
): Provider {
  return [
    {
      provide: TRANSITION_SCOPE,
      useFactory: () => {
        const scope = createForwardingScope({
          ...opt,
          injector: opt?.injector ?? inject(Injector),
        });
        bridgeScopeToPendingTasks(scope);
        return scope;
      },
    },
    scopeCensusProvider,
  ];
}

/** Read the transition scope reachable from `injector`, or null if none is provided there. */
export function getTransitionScope(injector: Injector): TransitionScope | null {
  return injector.get(TRANSITION_SCOPE, null);
}

type FlightClaims = {
  readonly byRef: Map<ResourceLike, Map<number, object>>;
  readonly version: ReturnType<typeof signal<number>>;
};
const flightClaims = new WeakMap<TransitionScope, FlightClaims>();

/** Owner of record for a claimed load whose transaction has settled: nobody live adopts it. */
const SETTLED_OWNER: object = {};

/** Drop claims on loads a later start has already replaced; only the current load of a resource can be in flight. */
function pruneClaims(
  claims: FlightClaims,
  current: Map<ResourceLike, number>,
): boolean {
  let changed = false;
  for (const [ref, byCount] of claims.byRef) {
    const now = current.get(ref);
    for (const n of byCount.keys())
      if (now === undefined || n < now) {
        byCount.delete(n);
        changed = true;
      }
    if (!byCount.size) claims.byRef.delete(ref);
  }
  return changed;
}

function claimsOf(scope: TransitionScope): FlightClaims {
  let c = flightClaims.get(scope);
  if (!c)
    flightClaims.set(scope, (c = { byRef: new Map(), version: signal(0) }));
  return c;
}

/** @internal The `loads` count of every resource in the scope that exposes one. */
export function snapshotLoads(
  scope: TransitionScope,
): Map<ResourceLike, number> {
  return untracked(() => {
    const out = new Map<ResourceLike, number>();
    for (const ref of scope.resources()) {
      const loads = ref.loads?.();
      if (loads !== undefined) out.set(ref, loads);
    }
    return out;
  });
}

/**
 * @internal Claim for `owner` every load started since `before` (a {@link snapshotLoads} taken
 * at the start of a synchronous slice). A load another owner already claimed stays theirs.
 */
export function claimLoads(
  scope: TransitionScope,
  owner: object,
  before: Map<ResourceLike, number>,
): void {
  const claims = claimsOf(scope);
  const current = snapshotLoads(scope);
  let changed = pruneClaims(claims, current);
  for (const [ref, after] of current) {
    const from = before.get(ref) ?? 0;
    if (after <= from) continue;
    let byCount = claims.byRef.get(ref);
    if (!byCount) claims.byRef.set(ref, (byCount = new Map()));
    for (let n = from + 1; n <= after; n++) {
      if (byCount.has(n)) continue;
      byCount.set(n, owner);
      changed = true;
    }
  }
  if (changed) claims.version.update((v) => v + 1);
}

/**
 * @internal `owner` settled. Its claims stay on record under a settled owner, so a load it
 * started that is still in flight is not adopted by another transaction's window; claims on
 * loads already replaced by a later start are dropped.
 */
export function releaseClaims(scope: TransitionScope, owner: object): void {
  const claims = flightClaims.get(scope);
  if (!claims) return;
  let changed = pruneClaims(claims, snapshotLoads(scope));
  for (const byCount of claims.byRef.values())
    for (const [n, o] of byCount)
      if (o === owner) {
        byCount.set(n, SETTLED_OWNER);
        changed = true;
      }
  if (changed) claims.version.update((v) => v + 1);
}

/**
 * @internal Transaction-attributed pending for `startTransition`/`startTransaction`: like
 * `scope.pending`, but loads already in flight when the tracker is created are NOT attributed,
 * so a pre-existing background load can neither settle the transaction early nor block its
 * settle forever.
 *
 * With `loads` on a resource: a load counts when it was claimed by `owner` (started inside one
 * of its synchronous slices), or started after the tracker was created and not claimed by
 * another owner. That is "started since the checkpoint", not "caused by this writer", for loads
 * started outside a slice. Without `loads`: a pre-existing flight is excluded until a read
 * sees it settled (best-effort: a load that restarts, or settles and refires between two reads,
 * stays excluded).
 */
export function createAttributedPending(
  scope: TransitionScope,
  owner?: object,
): Signal<boolean> {
  const inFlight = (s: ResourceStatus) => s === 'loading' || s === 'reloading';
  const loads0 = snapshotLoads(scope);
  const preexisting = new Set(
    untracked(scope.resources).filter((ref) => inFlight(untracked(ref.status))),
  );
  const claims = claimsOf(scope);

  return computed(() => {
    claims.version();
    let pending = false;
    for (const ref of scope.resources()) {
      const loading = inFlight(ref.status());
      const loads = ref.loads?.();
      if (loads === undefined) {
        if (preexisting.has(ref)) {
          // deletes are monotonic, so this stays sound under re-computation
          if (!loading) preexisting.delete(ref);
          continue;
        }
        if (loading) pending = true;
        continue;
      }
      if (!loading) continue;
      const claimedBy = claims.byRef.get(ref)?.get(loads);
      if (claimedBy !== undefined) {
        if (claimedBy === owner) pending = true;
        continue;
      }
      const l0 = loads0.get(ref);
      if (!preexisting.has(ref) || (l0 !== undefined && loads > l0))
        pending = true;
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
