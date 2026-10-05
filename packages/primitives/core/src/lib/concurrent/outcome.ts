import { computed, type ResourceStatus, type Signal } from '@angular/core';
import {
  errorEdge,
  loading,
  type ErrorSentinel,
  type Loading,
} from '../semantics/sentinel';

/**
 * What {@link outcomeOf} reads: the status-bearing surface every mmstack resource, Angular
 * `ResourceRef` and `latest()` carries. `hasContent` is optional and wins over `hasValue` when
 * present (a value held through a failed reload counts as content).
 */
export type OutcomeSource<T> = {
  readonly status: Signal<ResourceStatus>;
  readonly value: Signal<T | undefined>;
  hasValue(): boolean;
  hasContent?(): boolean;
  readonly error?: Signal<unknown>;
};

/**
 * A resource's value plane as one total read: the value, `undefined` (nothing requested, which is
 * a value, never a trigger), or an absorbing sentinel (`loading` while there is nothing to show,
 * `error` whenever the resource failed).
 */
export type Outcome<T> = T | undefined | Loading | ErrorSentinel;

/** What a `loading` sentinel minted by {@link outcomeOf} carries as its `source`. */
export type ResourceLoadingSource = {
  readonly kind: 'resource';
  readonly name?: string;
};

export type OutcomeOptions = {
  /** Carried on the `loading` sentinel's source, to say what is loading. */
  readonly name?: string;
};

const causes = new WeakMap<ErrorSentinel, unknown>();

/**
 * The failure an error sentinel minted by {@link outcomeOf} (or by `latest()` for a thrown
 * computation) stands for. The sentinel itself is value-free; the cause stays on this side table.
 */
export function outcomeErrorCause(
  sentinel: ErrorSentinel,
): { readonly cause: unknown } | undefined {
  return causes.has(sentinel) ? { cause: causes.get(sentinel) } : undefined;
}

const NONE: unique symbol = Symbol('none');

/**
 * One edge mint per distinct failure: an object failure maps to its sentinel for as long as it
 * lives, a primitive failure is remembered while it stays the latest one. A re-read never mints
 * (and never reports) again.
 */
export function createEdgeMemo(): (cause: unknown) => ErrorSentinel {
  const byObject = new WeakMap<object, ErrorSentinel>();
  let lastCause: unknown = NONE;
  let lastEdge: ErrorSentinel | undefined;

  const mint = (cause: unknown) => {
    const edge = errorEdge(cause);
    causes.set(edge, cause);
    return edge;
  };

  return (cause) => {
    if (
      (typeof cause === 'object' && cause !== null) ||
      typeof cause === 'function'
    ) {
      let edge = byObject.get(cause);
      if (!edge) {
        edge = mint(cause);
        byObject.set(cause, edge);
      }
      return edge;
    }
    if (lastEdge && Object.is(lastCause, cause)) return lastEdge;
    lastCause = cause;
    lastEdge = mint(cause);
    return lastEdge;
  };
}

const memo = new WeakMap<object, Signal<unknown>>();

/**
 * The outcome of a status-bearing ref, as a memoized signal (one per ref):
 *
 * | status | content | outcome |
 * |---|---|---|
 * | `error` | either | `errorEdge(error())`, minted once per distinct error |
 * | `loading` / `reloading` | no | `loading({ kind: 'resource', name })` |
 * | `loading` / `reloading` | yes | `value()` |
 * | `resolved` / `local` / `idle` | yes | `value()` |
 * | `idle` (and any other settled status) | no | `undefined` |
 *
 * Content is `hasContent()` when the ref has it, else `hasValue()`. The status is read first and
 * `value()` is never read while the ref is errored, so a ref whose `value()` throws in that state
 * (Angular's `ResourceRef`) is safe. The signal is memoized per ref, so `name` is honoured only on
 * the first call for that ref.
 */
export function outcomeOf<T>(
  source: OutcomeSource<T>,
  opt?: OutcomeOptions,
): Signal<Outcome<T>> {
  const known = memo.get(source);
  if (known) return known as Signal<Outcome<T>>;

  const edge = createEdgeMemo();
  let pending: Loading | undefined;
  const loadingSentinel = () =>
    (pending ??= loading({
      kind: 'resource',
      ...(opt?.name === undefined ? {} : { name: opt.name }),
    } satisfies ResourceLoadingSource));

  const outcome = computed<Outcome<T>>(() => {
    const status = source.status();
    if (status === 'error') return edge(source.error?.());
    const content = source.hasContent?.() ?? source.hasValue();
    if (status === 'loading' || status === 'reloading')
      return content ? source.value() : loadingSentinel();
    return content ? source.value() : undefined;
  });

  memo.set(source, outcome);
  return outcome;
}
