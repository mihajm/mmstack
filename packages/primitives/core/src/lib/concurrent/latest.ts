import {
  computed,
  DestroyRef,
  inject,
  type Injector,
  linkedSignal,
  type ResourceStatus,
  runInInjectionContext,
  type Signal,
  type ValueEqualityFn,
} from '@angular/core';
import { joinAbsorbers } from '../semantics/algebra';
import {
  type Absorbing,
  type Done,
  type ErrorSentinel,
  isAbsorbing,
  isError,
} from '../semantics/sentinel';
import { type Precedence } from './census';
import { demandOf } from './demand';
import { createEdgeMemo, outcomeErrorCause } from './outcome';
import { injectTransitionScope } from './transition-scope';

/**
 * What `use()` accepts: any status-bearing async value — an Angular `ResourceRef`,
 * an `@mmstack/resource` query/mutation, or another `latest()` result (so async
 * derivations nest). Purely structural; no class or brand required. When the source
 * carries `outcome`, `use()` reads it; otherwise the outcome is derived from
 * `status` / `hasContent` / `hasValue` / `value` / `error` (see `outcomeOf`).
 */
export type UseSource<T> = {
  readonly status: Signal<ResourceStatus>;
  readonly value: Signal<T | undefined>;
  hasValue(): boolean;
  hasContent?(): boolean;
  readonly error?: Signal<unknown>;
  readonly outcome?: Signal<T | undefined | Absorbing | Done>;
  /** The source's load counter, when it keeps one (see `ResourceLike.loads`). */
  readonly loads?: Signal<number | undefined>;
};

/**
 * An async derivation: callable as a signal of the latest successfully-computed value
 * (held through in-flight recomputes — the stale-while-revalidate atom), with the
 * aggregate async state of everything it `use()`d. Satisfies both `UseSource` (so it
 * nests inside another `latest`) and the transition scope's `ResourceLike` surface
 * (so it registers into boundaries like any resource).
 */
export type LatestSignal<T> = Signal<T | undefined> & {
  /** The held value — same signal as the callable itself. */
  readonly value: Signal<T | undefined>;
  /**
   * The value plane of the last evaluation: its result, or the absorbing sentinel it settled
   * on (`loading` while something it needs has nothing to show, `error` when something it
   * needs failed or the computation threw). Which absorber, when several were read, is the
   * `errors` mode's call (see `CreateLatestOptions`). Never held: the held value is `value()`.
   */
  readonly outcome: Signal<T | undefined | Absorbing>;
  /**
   * Composes both axes: an `error` outcome is `error`; otherwise in-flight work maps to
   * `reloading` (a value is held) / `loading` (first load); a value outcome is `resolved`;
   * waiting with nothing in flight (e.g. a member is `idle`) is `idle`.
   */
  readonly status: Signal<ResourceStatus>;
  /** Any used member has a request in flight (`loading`/`reloading`) — the aggregate transition indicator. */
  readonly pending: Signal<boolean>;
  /** Alias of `pending`, for the `ResourceRef`-shaped surface. */
  readonly isLoading: Signal<boolean>;
  /**
   * The failure behind an `error` outcome (the computation's own thrown error, or the used
   * member's error), else the first used member's error in read order. `undefined` when
   * healthy. The held value stays readable through an error.
   */
  readonly error: Signal<unknown>;
  /** Whether a value has ever been produced (and is therefore held). */
  hasValue(): boolean;
  /**
   * Loads started by the used members, summed, each counted from when this derivation first
   * observes its counter (a read of `loads`). Monotone: a member that stops being used keeps what
   * it added. `undefined` while any used member keeps no counter.
   */
  readonly loads: Signal<number | undefined>;
};

/**
 * How `outcome()` (and so `status()` / `error()`) picks among absorbers when an evaluation
 * read more than one (`useAll`, or a read whose throw the computation caught and moved past).
 * - `'first'` (the default): the absorber the evaluation actually stopped at, in read order.
 *   This is what a sequential callback means.
 * - `'aggregate'`: the ranked join over what every used member demanded, under `precedence`
 *   (`'pending-first'` by default: nothing with a member in flight is settled, so an error
 *   shown in that window is premature; `'error-first'` inverts it).
 */
export type LatestErrorsOptions =
  | { readonly errors?: 'first'; readonly precedence?: never }
  | { readonly errors: 'aggregate'; readonly precedence?: Precedence };

export type CreateLatestOptions<T> = {
  /** Equality for the held value: an in-flight cycle that recomputes to an equal value never notifies consumers (while `pending` still reports the flight). */
  readonly equal?: ValueEqualityFn<T>;
  /**
   * Auto-registration into the nearest transition scope (same vocabulary as resource
   * options): `'indicator'` drives `pending`/hold-stale only, `'suspend'` also gates the
   * boundary's first-load placeholder. Requires an injection context (or `injector`).
   */
  readonly register?: false | 'indicator' | 'suspend';
  /** Injection context for `register`, when created outside one. */
  readonly injector?: Injector;
  readonly debugName?: string;
} & LatestErrorsOptions;

type Frame = {
  readonly deps: UseSource<unknown>[];
  readonly demands: Map<UseSource<unknown>, unknown>;
  readonly precedence: Precedence;
};

const frameStack: Frame[] = [];

export type { AwaitingSource } from './demand';

function currentFrame(name: string): Frame {
  const frame = frameStack.at(-1);
  if (!frame) {
    throw new Error(
      `[mmstack/primitives] ${name}() must be called synchronously within a latest() computation`,
    );
  }
  return frame;
}

function record(frame: Frame, res: UseSource<unknown>): unknown {
  if (frame.demands.has(res)) return frame.demands.get(res);
  frame.deps.push(res);
  const demand = demandOf(res);
  frame.demands.set(res, demand);
  return demand;
}

/**
 * Reads a resource inside a `latest()` computation: returns its value and reports it to
 * the enclosing collector, so the derivation's aggregate `pending`/`status`/`error`
 * include it. When the resource has nothing to show yet (first load), or failed, `use()`
 * throws its absorbing sentinel (`loading` / `error`) and the computation short-circuits —
 * code after this call simply doesn't run this round — which is what lets you write the
 * happy path with no `undefined` checks:
 *
 * ```ts
 * const fullName = latest(() => {
 *   const u = use(user);          // waterfalls compose:
 *   const org = use(orgFor(u));   // orgFor(u) is only read once `user` has a value
 *   return `${u.name} @ ${org.name}`;
 * });
 * ```
 *
 * The thrown sentinel is the lattice itself: avoid broad `try/catch` around `use()` calls,
 * or rethrow anything `isAbsorbing`. Must be called synchronously within `latest()` — like
 * `inject()`, it throws elsewhere.
 */
export function use<T>(res: UseSource<T>): T {
  const demand = record(currentFrame('use'), res as UseSource<unknown>);
  if (isAbsorbing(demand)) throw demand;
  return demand as T;
}

type UseValues<S extends readonly UseSource<unknown>[]> = {
  -readonly [K in keyof S]: S[K] extends UseSource<infer T> ? T : never;
};

/**
 * Reads several resources independently in one evaluation: every source is read and
 * reported, then, if any of them has nothing to show or failed, the ranked join of their
 * absorbers is thrown (under the enclosing `latest`'s `precedence`, `'pending-first'` by
 * default). Otherwise returns their values as a tuple.
 *
 * ```ts
 * const card = latest(() => {
 *   const [u, org] = useAll(user, org);
 *   return `${u.name} @ ${org.name}`;
 * });
 * ```
 */
export function useAll<const S extends readonly UseSource<unknown>[]>(
  ...sources: S
): UseValues<S> {
  const frame = currentFrame('useAll');
  const demands = sources.map((res) => record(frame, res));
  const absorber = joinAbsorbers(demands, frame.precedence);
  if (absorber) throw absorber;
  return demands as UseValues<S>;
}

type Evaluation<T> = {
  readonly kind: 'value' | 'absorbed' | 'thrown';
  readonly value?: T;
  readonly absorber?: Absorbing;
  readonly thrown?: unknown;
  readonly deps: readonly UseSource<unknown>[];
  readonly demands: ReadonlyMap<UseSource<unknown>, unknown>;
};

type Held<T> = { readonly has: boolean; readonly v: T | undefined };

/**
 * An async derivation over resources: evaluates `fn` inside a collector frame so that
 * every `use()` read registers as a member, and exposes the result with resource
 * semantics — the value holds its previous state while anything it read is in flight
 * (never flashing empty), `pending` aggregates the members' in-flight state, and the
 * whole thing is itself a `UseSource`, so `latest`s nest and propagate.
 *
 * ```ts
 * const fullName = latest(() => `${use(user).name} @ ${use(org).name}`);
 * fullName();          // held value — undefined only before the first successful run
 * fullName.outcome();  // the value, or the loading / error sentinel the evaluation settled on
 * fullName.pending();  // true while user OR org (re)loads
 * ```
 *
 * Two axes, never one: `outcome()` is the value plane, `pending()` the activity of the used
 * members. A member reloading with its previous value still in hand keeps `outcome()` at the
 * value while `pending()` is true. `status()` composes the two.
 *
 * Evaluation is a plain `computed` under the hood: lazy, pure, no effects, usable
 * outside any injection context (`register` is the only DI-touching option).
 */
export function latest<T>(
  fn: () => T,
  opt?: CreateLatestOptions<T>,
): LatestSignal<T> {
  const aggregate = opt?.errors === 'aggregate';
  const precedence: Precedence =
    (opt?.errors === 'aggregate' ? opt.precedence : undefined) ??
    'pending-first';

  const evaluation = computed<Evaluation<T>>(
    () => {
      const frame: Frame = { deps: [], demands: new Map(), precedence };
      frameStack.push(frame);
      try {
        const value = fn();
        return {
          kind: 'value',
          value,
          deps: frame.deps,
          demands: frame.demands,
        };
      } catch (e) {
        if (isAbsorbing(e))
          return {
            kind: 'absorbed',
            absorber: e,
            deps: frame.deps,
            demands: frame.demands,
          };
        return {
          kind: 'thrown',
          thrown: e,
          deps: frame.deps,
          demands: frame.demands,
        };
      } finally {
        frameStack.pop();
      }
    },
    opt?.debugName ? { debugName: `${opt.debugName}:evaluation` } : undefined,
  );

  const equal = opt?.equal ?? Object.is;

  const held = linkedSignal<Evaluation<T>, Held<T>>({
    source: evaluation,
    computation: (ev, prev) =>
      ev.kind === 'value'
        ? { has: true, v: ev.value }
        : (prev?.value ?? { has: false, v: undefined }),
    equal: (a, b) => a.has === b.has && (!a.has || equal(a.v as T, b.v as T)),
  });

  const value = computed(
    () => held().v,
    opt?.debugName ? { debugName: opt.debugName } : undefined,
  );

  const thrownEdge = createEdgeMemo();

  const outcome = computed<T | undefined | Absorbing>(() => {
    const ev = evaluation();
    // Read on every evaluation so the hold observes each value as it lands, even when only
    // `outcome` is read (a nesting `use`); a value outcome is the held value, so `equal` holds.
    const kept = held();
    const stop =
      ev.kind === 'absorbed'
        ? ev.absorber
        : ev.kind === 'thrown'
          ? thrownEdge(ev.thrown)
          : undefined;
    if (aggregate) {
      const joined = joinAbsorbers([...ev.demands.values(), stop], precedence);
      if (joined) return joined;
    } else if (stop) return stop;
    return kept.v;
  });

  const pending = computed(() =>
    evaluation().deps.some((d) => {
      const s = d.status();
      return s === 'loading' || s === 'reloading';
    }),
  );

  const status = computed<ResourceStatus>(() => {
    const out = outcome();
    if (isError(out)) return 'error';
    if (pending()) return held().has ? 'reloading' : 'loading';
    return isAbsorbing(out) ? 'idle' : 'resolved';
  });

  const causeOf = (
    sentinel: ErrorSentinel,
    ev: Evaluation<T>,
  ): { readonly cause: unknown } | undefined => {
    const known = outcomeErrorCause(sentinel);
    if (known) return known;
    const member = ev.deps.find((d) => ev.demands.get(d) === sentinel);
    return member ? { cause: member.error?.() } : undefined;
  };

  const error = computed(() => {
    const ev = evaluation();
    const out = outcome();
    if (isError(out)) return (causeOf(out, ev) ?? { cause: out }).cause;
    for (const d of ev.deps) {
      const e = d.error?.();
      if (e !== undefined) return e;
    }
    return undefined;
  });

  const seenLoads = new WeakMap<UseSource<unknown>, number>();
  let loadsTotal = 0;
  const loads = computed(() => {
    let counted = true;
    for (const d of evaluation().deps) {
      const l = d.loads?.();
      if (l === undefined) {
        counted = false;
        continue;
      }
      const last = seenLoads.get(d);
      // only forward moves add, so re-running with the same counts is a no-op
      if (last !== undefined && l > last) loadsTotal += l - last;
      seenLoads.set(d, l);
    }
    return counted ? loadsTotal : undefined;
  });

  const result = Object.assign(value, {
    value,
    loads,
    outcome,
    status,
    pending,
    isLoading: pending,
    error,
    hasValue: () => held().has,
  }) as LatestSignal<T>;

  if (opt?.register) {
    const register = () => {
      const scope = injectTransitionScope();
      scope.add(result, { suspends: opt.register === 'suspend' });
      inject(DestroyRef).onDestroy(() => scope.remove(result));
    };
    if (opt.injector) runInInjectionContext(opt.injector, register);
    else register();
  }

  return result;
}
