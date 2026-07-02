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
import { injectTransitionScope } from './transition-scope';

/**
 * What `use()` accepts: any status-bearing async value — an Angular `ResourceRef`,
 * an `@mmstack/resource` query/mutation, or another `latest()` result (so async
 * derivations nest). Purely structural; no class or brand required.
 */
export type UseSource<T> = {
  readonly status: Signal<ResourceStatus>;
  readonly value: Signal<T | undefined>;
  hasValue(): boolean;
  readonly error?: Signal<unknown>;
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
   * Aggregate status. `error` wins (any used member errored, or the computation threw);
   * otherwise in-flight work maps to `reloading` (a value is held) / `loading` (first
   * load); a completed computation is `resolved`; blocked-with-nothing-in-flight (e.g.
   * a member is `idle`) is `idle`.
   */
  readonly status: Signal<ResourceStatus>;
  /** Any used member has a request in flight (`loading`/`reloading`) — the aggregate transition indicator. */
  readonly pending: Signal<boolean>;
  /** Alias of `pending`, for the `ResourceRef`-shaped surface. */
  readonly isLoading: Signal<boolean>;
  /**
   * The computation's own thrown error, or the first used member's error (in read
   * order). `undefined` when healthy. The held value stays readable through an error.
   */
  readonly error: Signal<unknown>;
  /** Whether a value has ever been produced (and is therefore held). */
  hasValue(): boolean;
};

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
};

type Frame = {
  readonly deps: UseSource<unknown>[];
  readonly seen: Set<UseSource<unknown>>;
  readonly errors: unknown[];
};

const frameStack: Frame[] = [];

/**
 * Thrown by `use()` to short-circuit a computation whose input has no value yet; caught
 * by the owning `latest()`. Identity-compared, so user code must not swallow it — avoid
 * broad `try/catch` around `use()` calls.
 */
const BLOCKED = new Error(
  '[mmstack/primitives] latest() blocked — internal sentinel, do not catch',
);

/**
 * Reads a resource inside a `latest()` computation: returns its value and reports it to
 * the enclosing collector, so the derivation's aggregate `pending`/`status`/`error`
 * include it. When the resource has no value yet (first load) or is in an error state,
 * the computation short-circuits — code after this call simply doesn't run this round —
 * which is what lets you write the happy path with no `undefined` checks:
 *
 * ```ts
 * const fullName = latest(() => {
 *   const u = use(user);          // waterfalls compose:
 *   const org = use(orgFor(u));   // orgFor(u) is only read once `user` has a value
 *   return `${u.name} @ ${org.name}`;
 * });
 * ```
 *
 * Must be called synchronously within `latest()` — like `inject()`, it throws elsewhere.
 */
export function use<T>(res: UseSource<T>): T {
  const frame = frameStack.at(-1);
  if (!frame) {
    throw new Error(
      '[mmstack/primitives] use() must be called synchronously within a latest() computation',
    );
  }
  if (!frame.seen.has(res)) {
    frame.seen.add(res);
    frame.deps.push(res);
  }
  // status() is read tracked even on the short-circuit paths, so the owning computed
  // re-evaluates when the load settles / the error clears.
  if (res.status() === 'error') {
    frame.errors.push(res.error?.());
    throw BLOCKED;
  }
  if (!res.hasValue()) throw BLOCKED;
  return res.value() as T;
}

type Evaluation<T> = {
  readonly kind: 'value' | 'blocked' | 'thrown';
  readonly value?: T;
  readonly thrown?: unknown;
  readonly deps: readonly UseSource<unknown>[];
  readonly errors: readonly unknown[];
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
 * fullName.pending();  // true while user OR org (re)loads
 * ```
 *
 * Evaluation is a plain `computed` under the hood: lazy, pure, no effects, usable
 * outside any injection context (`register` is the only DI-touching option).
 */
export function latest<T>(
  fn: () => T,
  opt?: CreateLatestOptions<T>,
): LatestSignal<T> {
  const evaluation = computed<Evaluation<T>>(
    () => {
      const frame: Frame = { deps: [], seen: new Set(), errors: [] };
      frameStack.push(frame);
      try {
        const value = fn();
        return { kind: 'value', value, deps: frame.deps, errors: frame.errors };
      } catch (e) {
        if (e === BLOCKED)
          return { kind: 'blocked', deps: frame.deps, errors: frame.errors };
        return {
          kind: 'thrown',
          thrown: e,
          deps: frame.deps,
          errors: frame.errors,
        };
      } finally {
        frameStack.pop();
      }
    },
    opt?.debugName ? { debugName: `${opt.debugName}:evaluation` } : undefined,
  );

  const equal = opt?.equal ?? Object.is;

  // The stale-while-revalidate atom: holds the last successful result through blocked /
  // errored rounds. `equal` gates notification, so an in-flight cycle that lands on an
  // equal value never ripples to consumers — while `pending` (independent) still cycles.
  const held = linkedSignal<Evaluation<T>, Held<T>>({
    source: evaluation,
    computation: (ev, prev) =>
      ev.kind === 'value'
        ? { has: true, v: ev.value }
        : (prev?.value ?? { has: false, v: undefined }),
    equal: (a, b) =>
      a.has === b.has && (!a.has || equal(a.v as T, b.v as T)),
  });

  const value = computed(
    () => held().v,
    opt?.debugName ? { debugName: opt.debugName } : undefined,
  );

  const pending = computed(() =>
    evaluation().deps.some((d) => {
      const s = d.status();
      return s === 'loading' || s === 'reloading';
    }),
  );

  const status = computed<ResourceStatus>(() => {
    const ev = evaluation();
    if (ev.kind === 'thrown' || ev.errors.length > 0) return 'error';
    if (pending()) return held().has ? 'reloading' : 'loading';
    return ev.kind === 'value' ? 'resolved' : 'idle';
  });

  const error = computed(() => {
    const ev = evaluation();
    return ev.kind === 'thrown' ? ev.thrown : ev.errors.at(0);
  });

  const result = Object.assign(value, {
    value,
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
