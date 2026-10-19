import { isDevMode, linkedSignal, untracked } from '@angular/core';
import { STORE_SHARED_OPTIONS } from './internals';
import { diffOps, type StoreOp } from './op-log';
import type { UnwrapOpaque } from './opaque';
import { isRecord, structEq } from './predicates';
import { toStore, type toStoreOptions } from './store';
import type { WritableSignalStore } from './types';

/**
 * A 3-way merge of a forked value against a changed base: given the common `ancestor` (the base
 * value the fork last diverged from), `mine` (the fork's current value), and `theirs` (the base
 * now), return the reconciled value. Used when the base changes mid-fork — and at `commit`.
 */
export type ReconcileFn<T> = (ancestor: T, mine: T, theirs: T) => T;

/**
 * How a fork reconciles when the base changes underneath it:
 *  - `'fine'` (default for immutable stores) — per-path 3-way merge ({@link merge3}): keep the
 *    paths the fork edited, take the base's live values for paths it didn't. Survives concurrent
 *    base changes. UNSUPPORTED on a mutable base (in-place mutation defeats `merge3`'s
 *    reference-identity checks — `fork` warns and falls back to `'coarse'`).
 *  - `'coarse'` — whole-value re-link: any base change resets the WHOLE fork (drops staged writes).
 *    The cheapest strategy; correct when the base is held for the fork's lifetime (transitions).
 *    The default for a MUTABLE base.
 *  - a {@link ReconcileFn} — bring your own merge (e.g. Immer patches, array-by-id, CRDT-ish).
 *    NOTE: any reference-based 3-way merge has the same mutable-store problem as `'fine'`; on a
 *    mutable base a custom fn receives `ancestor === theirs` (the same mutated object).
 */
export type ForkStrategy<T> = 'fine' | 'coarse' | ReconcileFn<T>;

/**
 * A forked store: an isolated, writable overlay on a base store. Writes stay LOCAL to the fork
 * (the base is untouched); unedited paths read through to the base. `commit()` flushes the fork's
 * value onto the base; `discard()` drops the staged writes.
 *
 * The mechanism is `linkedSignal`: it holds local writes until its source (the base) changes, then
 * runs the {@link ForkStrategy} to reconcile. The store interface, deep reads, and deep
 * copy-on-write writes all come from `toStore` unchanged — the only fork-specific logic is the
 * reconcile on a base change.
 *
 * Reactivity note: the fork reads through a single staged signal, so a read subscribes to the
 * whole record (coarser than the base store's per-leaf tracking) and the strategy re-runs on any
 * base change. Free when the base is held (it never ticks); on a live base, `'fine'`'s {@link
 * merge3} checks reference identity first, so a subtree neither side touched costs one comparison.
 */
export type Fork<T> = {
  /** The forked store — use it like any store (read/write/extend). */
  readonly store: WritableSignalStore<T>;
  /** Apply the fork's staged value onto the base, then re-link (fork now mirrors the base). */
  commit(): void;
  /** Drop staged writes — the fork reads through to the base again. */
  discard(): void;
  /** The staged delta vs the CURRENT base, as structural ops (inspect, persist, invert). */
  ops(): StoreOp[];
};

const ABSENT: unique symbol = Symbol('absent');
type Slot = unknown;

const fieldOf = (r: Record<string, unknown>, k: string): Slot =>
  Object.hasOwn(r, k) ? r[k] : ABSENT;

/** Same value, presence included: an absent key equals only an absent key. */
const sameSlot = (a: Slot, b: Slot): boolean =>
  a === ABSENT || b === ABSENT ? a === b : structEq(a, b);

function mergeSlot(ancestor: Slot, mine: Slot, theirs: Slot): Slot {
  // fast path: a copy-on-write side that kept its reference is unchanged, without a deep compare
  if (Object.is(mine, theirs) || Object.is(mine, ancestor)) return theirs;
  if (Object.is(theirs, ancestor)) return mine;
  if (sameSlot(mine, theirs) || sameSlot(mine, ancestor)) return theirs;
  // `theirs` equal to the ancestor needs no check of its own: the result is `mine` either way, and
  // walking records key by key keeps the base's references for the subtrees the fork left alone
  if (isRecord(ancestor) && isRecord(mine) && isRecord(theirs)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const merged = mergeSlot(
        fieldOf(ancestor, key),
        fieldOf(mine, key),
        fieldOf(theirs, key),
      );
      if (merged !== ABSENT) out[key] = merged;
    }
    return out;
  }
  return mine; // leaf / array / type-mismatch conflict → local wins
}

/**
 * Per-path 3-way merge by VALUE. A side whose value equals the ancestor made no change and yields
 * to the other side: `mine` equal to the ancestor takes the live base, `theirs` equal to the
 * ancestor keeps the fork's edit. When both sides changed a plain record, it merges key by key;
 * any other conflict (a leaf, an array, a type change) keeps the fork's value. Arrays are atomic
 * here (no positional merge); supply a {@link ReconcileFn} for array-aware merging.
 *
 * Equality is structural over plain data: plain records and plain arrays compare deeply,
 * primitives by `Object.is`, and everything else (a `Date`, `Map`, class instance, opaque value)
 * only by reference. So a side that edited a value and then wrote it back as a fresh copy counts
 * as unchanged: with ancestor `{ arr: [0] }`, a fork that wrote `[1]` and then a fresh `[0]`, and
 * a base now at `{ arr: [2] }`, the merge is `{ arr: [2] }`.
 *
 * Fast path: before any deep compare, reference identity is checked first. A subtree the fork
 * never touched keeps its reference under copy-on-write writes (`toStore` rebuilds only the
 * edited path), so it is recognised as unchanged at the cost of one comparison, and only paths
 * whose references differ are compared by value.
 *
 * An absent key and a key holding `undefined` are different values here, because `diffOps` (and
 * so `Fork.ops()` and every sync layer built on it) turns one into the other with a `set` or a
 * `delete`. Presence merges like any value: a key the base deleted and the fork left alone is
 * absent, a key the fork deleted is absent, and only a deliberate `undefined` survives as a key.
 */
export function merge3<T>(ancestor: T, mine: T, theirs: T): T {
  return mergeSlot(ancestor, mine, theirs) as T;
}

/**
 * ForkStoreOptions, vivify/noUnionLeaves should remain the same & are automatically inherited, override carefully (advanced usecases)
 */
export type ForkStoreOptions<T> = toStoreOptions & {
  strategy?: ForkStrategy<T>;
};

export function forkStore<T extends Record<string, any>>(
  base: WritableSignalStore<T>,
  opt?: ForkStoreOptions<T>,
): Fork<T> {
  // A mutable base mutates in place, so its value reference is stable across changes — which defeats merge3's identity-based change detection
  const mutableBase =
    typeof (base as { mutate?: unknown }).mutate === 'function';
  let strategy = opt?.strategy ?? (mutableBase ? 'coarse' : 'fine');
  if (mutableBase && strategy === 'fine') {
    if (isDevMode())
      console.warn(
        "[fork] strategy 'fine' relies on reference-identity change detection, but the base is a " +
          "mutable store (in-place mutation keeps the same reference) — falling back to 'coarse'.",
      );
    strategy = 'coarse';
  }

  const reconcile: ReconcileFn<T> =
    strategy === 'coarse'
      ? (_ancestor, _mine, theirs) => theirs // re-link to the new base (whole-value reset)
      : strategy === 'fine'
        ? (merge3 as ReconcileFn<T>)
        : strategy;

  const merge = reconcile as unknown as ReconcileFn<UnwrapOpaque<T>>;
  const staged = linkedSignal<UnwrapOpaque<T>, UnwrapOpaque<T>>({
    source: () => base(),
    computation: (theirs, prev) =>
      prev === undefined ? theirs : merge(prev.source, prev.value, theirs),
  });
  const store = toStore(staged, {
    ...(base as any)[STORE_SHARED_OPTIONS],
    ...opt,
  }) as unknown as WritableSignalStore<T>;

  return {
    store,
    commit: () => base.set(untracked(staged)),
    discard: () => staged.set(untracked(base)),
    ops: () => diffOps(untracked(base), untracked(staged)),
  };
}
