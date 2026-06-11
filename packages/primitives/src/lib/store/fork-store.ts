import {
  isDevMode,
  linkedSignal,
  untracked,
  type Injector,
} from '@angular/core';
import { type Vivify } from '../util';
import { toStore, type UnwrapOpqaue, type WritableSignalStore } from './store';

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
 * merge3} is identity-pruned so it only walks paths that both sides changed.
 */
export type Fork<T> = {
  /** The forked store — use it like any store (read/write/extend). */
  readonly store: WritableSignalStore<T>;
  /** Apply the fork's staged value onto the base, then re-link (fork now mirrors the base). */
  commit(): void;
  /** Drop staged writes — the fork reads through to the base again. */
  discard(): void;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Per-path 3-way merge. Reference-equality short-circuits do the work: a subtree the fork never
 * touched satisfies `mine === ancestor` (structural sharing keeps its identity) → take the live
 * base; a subtree the base never changed satisfies `theirs === ancestor` → keep the fork's. So it
 * only deep-walks paths that BOTH sides changed, and on a leaf/array conflict the fork wins.
 * Arrays are treated atomically (no positional merge — index shifts make that unsafe); supply a
 * {@link ReconcileFn} for array-aware merging.
 *
 * CONTRACT: "unchanged" is detected by REFERENCE identity, not deep equality. `mine` must be a
 * copy-on-write derivative of `ancestor` — i.e. untouched nodes keep their reference — which the
 * fork guarantees because writes flow through `toStore` (it rebuilds only the edited path and
 * shares everything else). Feed it a structurally-equal-but-fresh-reference node for an untouched
 * path and it will treat that node as edited (recursion/leaf-value checks usually still reconcile,
 * but a fresh-ref clean node vs a base type-change resolves to the fork's stale value). Primitive
 * leaves compare by value, so equal primitives are correctly seen as unchanged.
 */
export function merge3<T>(ancestor: T, mine: T, theirs: T): T {
  if (Object.is(mine, theirs) || Object.is(mine, ancestor)) return theirs; // unedited → live base
  if (Object.is(theirs, ancestor)) return mine; // base unchanged here → keep the fork's edit

  if (isPlainRecord(mine) && isPlainRecord(theirs) && isPlainRecord(ancestor)) {
    const out: Record<string, unknown> = { ...theirs };
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      out[key] = merge3(
        (ancestor as Record<string, unknown>)[key],
        (mine as Record<string, unknown>)[key],
        (theirs as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }

  return mine; // leaf / array / type-mismatch conflict → local wins
}

export function forkStore<T extends Record<string, any>>(
  base: WritableSignalStore<T>,
  opt?: {
    strategy?: ForkStrategy<T>;
    injector?: Injector;
    /**
     * Store config for the FORK's store — NOT inherited from `base` (it's closed over inside
     * the base's `toStore` and can't be read back). If the base was created with these, pass
     * the same values or the fork's write semantics will differ:
     *  - `vivify`: without it, a write through a `null`/`undefined` path is silently dropped on
     *    the fork even though the base would have created the container. Match the base.
     *  - `noUnionLeaves`: a perf promise; off just means the slower reactive leaf-probe. NOTE it
     *    is a whole-store guarantee — a fork that flips a node's type (leaf↔substore) violates it,
     *    and on `commit` the base receives the flipped value with stale cached leaf-ness.
     */
    vivify?: Vivify;
    noUnionLeaves?: boolean;
  },
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

  const merge = reconcile as unknown as ReconcileFn<UnwrapOpqaue<T>>;
  const staged = linkedSignal<UnwrapOpqaue<T>, UnwrapOpqaue<T>>({
    source: () => base(),
    computation: (theirs, prev) =>
      prev === undefined ? theirs : merge(prev.source, prev.value, theirs),
  });
  const store = toStore(
    staged,
    opt?.injector,
    opt?.vivify,
    opt?.noUnionLeaves,
  ) as unknown as WritableSignalStore<T>;

  return {
    store,
    commit: () => base.set(untracked(staged)),
    discard: () => staged.set(untracked(base)),
  };
}
