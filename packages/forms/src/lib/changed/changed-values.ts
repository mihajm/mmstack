import { computed, isDevMode, type Signal, untracked } from '@angular/core';
import type { FieldState, FieldTree } from '@angular/forms/signals';
import { CHANGED, CHANGED_EQUAL, CHANGED_WITH } from './changed';

/**
 * A nested partial of `T` where arrays are kept whole: change extraction treats an array as a
 * single unit (index-level diffs lie once items reorder), so an array-typed property appears
 * either complete or not at all.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Same pure diff as change tracking's untracked-child fallback. */
function valueDiff(initial: unknown, current: unknown): boolean {
  if (Object.is(initial, current)) return false;
  if (Array.isArray(current) && Array.isArray(initial)) {
    if (current.length !== initial.length) return true;
    return current.some((c, i) => valueDiff(initial[i], c));
  }
  if (isRecord(current) && isRecord(initial)) {
    const keys = Object.keys(current);
    if (keys.length !== Object.keys(initial).length) return true;
    return keys.some((k) => valueDiff(initial[k], current[k]));
  }
  return true;
}

function childState(
  state: FieldState<unknown>,
  key: string | number,
): FieldState<unknown> | undefined {
  const tree = state.fieldTree as unknown as Record<
    string | number,
    (() => FieldState<unknown>) | undefined
  >;
  return tree[key]?.();
}

type Collected = { readonly value: unknown; readonly paths: string[] } | null;

const unit = (value: unknown, path: string): Collected => ({
  value,
  paths: [path],
});

/**
 * Walks the tracked tree collecting the minimal changed subset. Mirrors `nodeChanged`'s
 * delegation exactly — each node's own `changed` signal decides whether the walk descends —
 * so the extracted payload and the boolean dirty flag can never disagree.
 *
 * Unit granularity (emitted whole): leaves; arrays (the honest default — index diffs lie under
 * reorder); nodes carrying a `changedEqual`/`changedWith` override (the override is authoritative
 * for the whole subtree, so deeper attribution would second-guess it); records whose key set
 * changed; and untracked children (no delegate to descend into).
 */
function collectNode(
  state: FieldState<unknown>,
  path: string,
  // baseline slice from the nearest tracked ancestor — used when this node has no entry
  fallbackInitial: unknown,
): Collected {
  const entry = state.metadata(CHANGED);
  if (entry && !entry.changed()) return null;

  const current = state.value();

  // Override-bearing nodes are units — their `changed` is authoritative for the subtree.
  if (state.metadata(CHANGED_WITH)?.() || state.metadata(CHANGED_EQUAL)?.())
    return unit(current, path);

  const initial = entry ? entry.initial() : fallbackInitial;

  if (isRecord(current) && isRecord(initial)) {
    const keys = Object.keys(current);
    // Key churn: per-child delegation can't attribute additions/removals — whole unit.
    if (keys.length !== Object.keys(initial).length)
      return unit(current, path);

    const out: Record<string, unknown> = {};
    const paths: string[] = [];
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const child = childState(state, key);
      if (child) {
        const collected = collectNode(child, childPath, initial[key]);
        if (collected) {
          out[key] = collected.value;
          paths.push(...collected.paths);
        }
      } else if (valueDiff(initial[key], current[key])) {
        // No field node at all for this key: fallback diff, emitted whole.
        out[key] = current[key];
        paths.push(childPath);
      }
    }
    // The container reads changed but no child claims it (e.g. delegate/diff drift on
    // exotic values) — stay honest and emit the whole container rather than {}.
    if (entry && paths.length === 0) return unit(current, path);
    return paths.length ? { value: out, paths } : null;
  }

  // Leaf / array / type-change: one unit. For untracked nodes (no entry) decide via the
  // pure diff against the ancestor's baseline slice, so subtrees of a tracked parent resolve.
  if (!entry && !valueDiff(initial, current)) return null;
  return unit(current, path);
}

function collectRoot(tree: FieldTree<unknown>): Collected {
  const state = tree();
  if (!state.metadata(CHANGED)) {
    if (isDevMode())
      console.warn(
        '[@mmstack/forms] changedValues/changedPaths called on an untracked field — apply trackChanges() to the form first.',
      );
    return null;
  }
  return collectNode(state, '', undefined);
}

/**
 * Untracked snapshot of the changed subset WITH its unit paths.
 * @internal exported for submit-changes (paths drive submitted-unit re-baselining).
 */
export function collectChanged<T>(
  tree: FieldTree<T>,
): { readonly value: DeepPartial<T>; readonly paths: string[] } | null {
  const collected = untracked(() => collectRoot(tree as FieldTree<unknown>));
  return collected
    ? { value: collected.value as DeepPartial<T>, paths: collected.paths }
    : null;
}

/**
 * Extracts the minimal changed subset of a tracked form — the natural PATCH payload. Returns
 * `undefined` when nothing changed. Respects the same `changedEqual`/`changedWith` rules the
 * boolean `changed` does, so the payload and the dirty flag always agree.
 *
 * Granularity: objects narrow per-property; arrays and leaves are whole units; a record whose
 * key set changed and any node with an equality override are emitted whole (see the walker note).
 *
 * Reads are untracked — this is a submit-time snapshot, not a live signal. For reactive
 * consumption use {@link changedPaths} / {@link changedCount}.
 *
 * @example
 * ```ts
 * const f = form(model, trackChanges(model));
 * // user edited name only:
 * changedValues(f); // { name: 'Ada' }
 * ```
 */
export function changedValues<T>(tree: FieldTree<T>): DeepPartial<T> | undefined {
  return collectChanged(tree)?.value;
}

/**
 * A live signal of the changed unit paths of a tracked form (dot-joined, array indices as
 * segments, the root itself as `''`). Each path is one extraction unit — the same granularity
 * {@link changedValues} emits. Useful for debugging and "what will this PATCH send".
 */
export function changedPaths<T>(
  tree: FieldTree<T>,
): Signal<readonly string[]> {
  return computed(() => collectRoot(tree as FieldTree<unknown>)?.paths ?? []);
}

/**
 * A live count of changed units — for "3 unsaved changes" badges. Sugar over
 * {@link changedPaths}.
 */
export function changedCount<T>(tree: FieldTree<T>): Signal<number> {
  const paths = changedPaths(tree);
  return computed(() => paths().length);
}
