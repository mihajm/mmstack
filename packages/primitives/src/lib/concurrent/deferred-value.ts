import {
  afterNextRender,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
  type ValueEqualityFn,
} from '@angular/core';

/**
 * How the catch-up write is scheduled (the "lower priority" of the deferral):
 * - `'afterRender'` (default): after the next render — the urgent update (e.g. the
 *   keystroke echo) paints first, the expensive subtree catches up right after.
 * - `'idle'`: `requestIdleCallback` (macrotask fallback) — catch up when the frame has
 *   budget; keeps continuous input smooth at the cost of a laggier deferred view.
 * - A function: custom scheduler — call the callback when it's time to catch up and
 *   return a canceller (also the test seam).
 */
export type DeferStrategy =
  | 'afterRender'
  | 'idle'
  | ((cb: () => void) => () => void);

export type DeferredValueOptions<T> = {
  readonly strategy?: DeferStrategy;
  /** Equality for the deferred value — an equal catch-up never notifies consumers. */
  readonly equal?: ValueEqualityFn<T>;
  readonly injector?: Injector;
};

/**
 * The deferred view of a source signal: callable as the lagging value, with `pending`
 * reporting whether a catch-up is still owed (source has moved ahead) — the
 * `useDeferredValue`/`isStale` pair.
 */
export type DeferredSignal<T> = Signal<T> & {
  /** True while the deferred value is behind the source (a catch-up is scheduled). */
  readonly pending: Signal<boolean>;
};

/**
 * `useDeferredValue` for signals: returns a signal that HOLDS its previous value when
 * `source` changes and catches up at lower priority (after paint / on idle), so an
 * expensive subtree keyed off the deferred value never blocks the urgent update that
 * caused the change — type into a filter, the input echoes instantly, the big list
 * re-renders a beat later.
 *
 * ```ts
 * const query = signal('');
 * const deferredQuery = deferredValue(query);
 * const results = computed(() => expensiveFilter(items(), deferredQuery()));
 * // template: <input [(ngModel)]="query" /> stays responsive; results lag one paint
 * // deferredQuery.pending() → dim the stale list while it catches up
 * ```
 *
 * Rapid changes coalesce: each change reschedules the catch-up, so only the LATEST
 * source value is ever applied (no intermediate churn in the expensive subtree).
 * On the server this is a synchronous pass-through — SSR renders once, so deferral
 * would just mean rendering stale content.
 *
 * This is a scheduling tool, not an async one — for async work compose `latest()`;
 * for coordinated multi-resource reveals use a transition scope.
 */
export function deferredValue<T>(
  source: Signal<T>,
  opt?: DeferredValueOptions<T>,
): DeferredSignal<T> {
  const injector = opt?.injector ?? inject(Injector);
  const equal = opt?.equal ?? Object.is;

  if (injector.get(PLATFORM_ID) === 'server') {
    const passthrough = computed(() => source()) as Signal<T> & {
      pending: Signal<boolean>;
    };
    passthrough.pending = computed(() => false);
    return passthrough;
  }

  const schedule = resolveScheduler(opt?.strategy ?? 'afterRender', injector);
  const out = signal(untracked(source), { equal });

  let cancel: (() => void) | null = null;
  const watch = effect(
    () => {
      const v = source();
      cancel?.(); // latest wins: rapid changes coalesce into one catch-up
      cancel = schedule(() => {
        cancel = null;
        out.set(v);
      });
    },
    { injector },
  );
  injector.get(DestroyRef).onDestroy(() => {
    watch.destroy();
    cancel?.();
    cancel = null;
  });

  const result = computed(() => out()) as Signal<T> & {
    pending: Signal<boolean>;
  };
  // "behind" is a value comparison, not a schedule flag: an equal-valued catch-up
  // (e.g. type a char, delete it before the deferred view caught up) is not pending
  result.pending = computed(() => !equal(out(), source()));
  return result;
}

function resolveScheduler(
  strategy: DeferStrategy,
  injector: Injector,
): (cb: () => void) => () => void {
  if (typeof strategy === 'function') return strategy;

  if (strategy === 'idle') {
    return (cb) => {
      const ric = globalThis.requestIdleCallback as
        | typeof requestIdleCallback
        | undefined;
      if (ric) {
        const id = ric(() => cb());
        return () => globalThis.cancelIdleCallback?.(id);
      }
      const id = setTimeout(cb, 0);
      return () => clearTimeout(id);
    };
  }

  return (cb) => {
    const ref = afterNextRender({ read: cb }, { injector });
    return () => ref.destroy();
  };
}
