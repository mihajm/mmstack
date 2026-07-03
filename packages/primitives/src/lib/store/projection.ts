import { linkedSignal } from '@angular/core';
import { isOpaque } from './opaque';
import { isRecord } from './predicates';
import { toStore, type toStoreOptions } from './store';
import type { SignalStore } from './types';

/** Identity selector for keyed array reconciliation: a property name, or a function per item. */
export type ReconcileKey = string | ((item: any) => unknown);

const isPlainArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && !isOpaque(v);

function keyOf(item: unknown, key: ReconcileKey): unknown {
  if (typeof key === 'function') return key(item);
  return isRecord(item) ? item[key] : item;
}

/**
 * Produces a value equal to `next` but sharing as much of `prev`'s reference structure as possible:
 * an object subtree that did not change keeps its `prev` reference, and array items are matched by
 * `key` so a surviving item keeps its identity across a reorder/insert/remove (only added items are
 * new, only removed items are dropped). This is what lets a derived store recompute without tearing
 * down every downstream `computed` that reads an unchanged part of it.
 */
export function reconcile<T>(prev: T, next: T, key: ReconcileKey = 'id'): T {
  return reconcileValue(prev, next, key) as T;
}

function reconcileValue(prev: unknown, next: unknown, key: ReconcileKey): unknown {
  if (Object.is(prev, next)) return prev;

  if (isPlainArray(prev) && isPlainArray(next)) {
    const byKey = new Map<unknown, unknown>();
    for (const item of prev) byKey.set(keyOf(item, key), item);
    let changed = prev.length !== next.length;
    const out = next.map((item, i) => {
      const match = byKey.get(keyOf(item, key));
      const rv = match !== undefined ? reconcileValue(match, item, key) : item;
      if (rv !== prev[i]) changed = true;
      return rv;
    });
    return changed ? out : prev;
  }

  if (isRecord(prev) && isRecord(next)) {
    const nextKeys = Object.keys(next);
    let changed = Object.keys(prev).length !== nextKeys.length;
    const out: Record<string, unknown> = {};
    for (const k of nextKeys) {
      const rv = Object.hasOwn(prev, k)
        ? reconcileValue(prev[k], next[k], key)
        : next[k];
      out[k] = rv;
      if (rv !== prev[k]) changed = true;
    }
    return changed ? out : prev;
  }

  return next;
}

export type ProjectionOptions = toStoreOptions & {
  /** Identity key for reconciling array items (default `'id'`). */
  readonly key?: ReconcileKey;
};

/**
 * A derived STORE, the store-shaped counterpart to `computed`. `fn` receives a mutable draft seeded
 * with the current value and either mutates it in place or returns a new value; whichever it does,
 * the result is reconciled against the previous value (see {@link reconcile}) so unchanged subtrees
 * keep reference identity and keyed array items keep their proxy identity. Reading through the
 * returned store is fine-grained: a `computed` over one field only recomputes when that field
 * actually changes, even though the whole projection re-ran.
 *
 * Recompute is pull-based, exactly like `computed`: the projection is memoized and re-runs on the
 * first read after a signal `fn` depends on changes, so reads are always coherent (no waiting on an
 * effect flush) and nothing recomputes while nobody reads. `fn` must be pure, it runs inside the
 * reactive computation. Prefer `computed` for a plain value; reach for `projection` when you want
 * the per-property tracking of a store on top of a derivation.
 *
 * ```ts
 * const active = projection<User[]>(() => users().filter((u) => u.active), [], { key: 'id' });
 * // active[0].name(); — surviving users keep identity across recomputes
 * ```
 *
 * Needs an injection context (or an explicit `injector`) for the store layer's cleanup on the main
 * thread; with an explicit store context (`createStoreContext()`) it is injector-free, so it also
 * runs on a worker host.
 *
 * @param fn receives the current draft; mutate it, or return new data.
 * @param seed the initial value, held before the first run.
 */
export function projection<T extends object>(
  fn: (draft: T) => void | T,
  seed: T,
  opt?: ProjectionOptions,
): SignalStore<T> {
  const { key = 'id', ...storeOpt } = opt ?? {};

  // linkedSignal rather than an effect-driven signal: the computation runs in the tracked
  // context (fn's reads are dependencies) and `previous` hands back the last emitted value for
  // the reconcile, so the projection is glitch-free, lazy, and needs no effect scheduler.
  const root = linkedSignal<undefined, T>({
    source: () => undefined,
    computation: (_, previous) => {
      const base = previous ? previous.value : seed;
      // a plain mutable scratch seeded with the current value; fn mutates it or returns new data
      const draft = structuredClone(base);
      const returned = fn(draft);
      const next = (returned === undefined ? draft : returned) as T;
      return reconcile(base, next, key);
    },
  });

  return toStore(root, storeOpt).asReadonlyStore() as SignalStore<T>;
}
