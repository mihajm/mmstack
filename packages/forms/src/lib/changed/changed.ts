import {
  computed,
  type Signal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  applyEach,
  createManagedMetadataKey,
  createMetadataKey,
  type FieldState,
  type FieldTree,
  metadata,
  type SchemaFn,
  type SchemaPath,
} from '@angular/forms/signals';
import {
  type FieldProjector,
  type FieldRef,
  injectField,
  raw,
  type RawProjection,
} from '../compose/compose';

/** Equality used at a leaf to decide whether a value changed from its baseline. */
export type ChangedEqual<T = unknown> = (initial: T, current: T) => boolean;
/** Fully custom changed computation for a path, evaluated reactively. */
export type ChangedFn<T = unknown> = (initial: T, current: T) => boolean;

/** Per-node tracking entry stored on the field via {@link CHANGED}. */
export type ChangedEntry<T = unknown> = {
  /** The baseline value for this node (captured lazily, re-captured by {@link commit}). */
  readonly initial: Signal<T>;
  /** Whether this node differs from its baseline. */
  readonly changed: Signal<boolean>;
  /** Re-baselines this node — to `value` if given, otherwise to its current value. */
  readonly commit: (value?: T) => void;
};

/** Sentinel so `commit(undefined)` (a real `undefined` baseline) differs from `commit()`. */
const NO_VALUE = Symbol('mmstack/no-value');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure value diff with `Object.is` short-circuit — the fallback when a node isn't tracked. */
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

/** Per-path override metadata keys. */
const CHANGED_EQUAL = createMetadataKey<ChangedEqual>();
const CHANGED_WITH = createMetadataKey<ChangedFn>();

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

/**
 * Whether a child changed — delegating to the child's own `changed` signal (which honors the
 * child's overrides and localizes recomputation), falling back to a pure value diff for nodes
 * that aren't tracked (e.g. items of an initially-empty array, before they're committed).
 */
function childChanged(
  state: FieldState<unknown>,
  key: string | number,
  initialChild: unknown,
  currentChild: unknown,
): boolean {
  const entry = childState(state, key)?.metadata(CHANGED);
  return entry ? entry.changed() : valueDiff(initialChild, currentChild);
}

function nodeChanged(
  state: FieldState<unknown>,
  initial: Signal<unknown>,
): boolean {
  const init = initial();

  // Overrides derive `changed` straight from the value, so subscribe to it.
  const custom = state.metadata(CHANGED_WITH)?.();
  if (custom) return custom(init, state.value());
  const eq = state.metadata(CHANGED_EQUAL)?.();
  if (eq) return !eq(init, state.value());

  const cur = untracked(state.value);

  if (isRecord(cur) && isRecord(init)) {
    if (Object.is(cur, init)) {
      state.value(); // track until next cycle
      return false;
    }

    const keys = Object.keys(cur);
    if (keys.length !== Object.keys(init).length) return true;
    for (const k of keys)
      if (childChanged(state, k, init[k], cur[k])) return true;
    return false;
  }

  // Leaf / array / type-change: the result depends on this value, so subscribe to it.
  const current = state.value();
  if (Object.is(init, current)) return false;
  if (Array.isArray(current) && Array.isArray(init)) {
    // Index-wise: items are identity-tracked, so per-node delegation would miss a reorder.
    if (current.length !== init.length) return true;
    for (let i = 0; i < current.length; i++)
      if (valueDiff(init[i], current[i])) return true;
    return false;
  }
  return true;
}

/**
 * Managed metadata key carrying per-node change tracking. Its `create` runs at field-node
 * construction (in the node's injection context), snapshotting the baseline and building the
 * delegating `changed` computed.
 *
 * v21 note: Angular 21's `createManagedMetadataKey` hands `create` only the accumulated data
 * signal (not the `FieldState` — that arg was added in v22). We feed each node's `FieldState`
 * in through the tracking rule (`(ctx) => ctx.state`, see {@link applyTracking}) and read it back
 * off that signal, so `TWrite` is `FieldState` rather than `undefined`. Public API is unchanged.
 */
export const CHANGED = createManagedMetadataKey<ChangedEntry, FieldState<unknown>>(
  (data) => {
    const initial: WritableSignal<unknown> = signal(undefined);
    // Resolves to this node's FieldState, fed in via the tracking rule. Read lazily (never at
    // construction) so it's bound by the time `changed`/`commit` are actually used.
    const stateOf = (): FieldState<unknown> => data() as FieldState<unknown>;
    return {
      initial,
      changed: computed(() => nodeChanged(stateOf(), initial), {
        debugName: 'changed',
      }),
      commit: (value: unknown = NO_VALUE) =>
        initial.set(value === NO_VALUE ? untracked(stateOf().value) : value),
    };
  },
);

/**
 * Schema rule: override the equality used to decide whether a field changed from its baseline.
 * On a container this replaces the delegate-down logic for that subtree.
 */
export function changedEqual<T>(
  path: SchemaPath<T>,
  equal: ChangedEqual<T>,
): void {
  metadata(path, CHANGED_EQUAL, () => equal as ChangedEqual);
}

/** Schema rule: fully replace how a field's `changed` is computed. */
export function changedWith<T>(path: SchemaPath<T>, fn: ChangedFn<T>): void {
  metadata(path, CHANGED_WITH, () => fn as ChangedFn);
}

function applyTracking(path: SchemaPath<unknown>, shape: unknown): void {
  metadata(path, CHANGED, (ctx) => ctx.state);
  if (Array.isArray(shape)) {
    applyEach(path as SchemaPath<unknown[]>, (itemPath) =>
      shape.length
        ? applyTracking(itemPath as SchemaPath<unknown>, shape[0])
        : metadata(itemPath as SchemaPath<unknown>, CHANGED, (ctx) => ctx.state),
    );
  } else if (isRecord(shape)) {
    const p = path as unknown as Record<string, SchemaPath<unknown>>;
    for (const key of Object.keys(shape)) applyTracking(p[key], shape[key]);
  }
}

/**
 * One-call change tracking: a schema fn that attaches per-field tracking to every field, so
 * `injectChanged()` / the {@link changed} projector work anywhere in the form.
 *
 * @example
 * ```ts
 * f = form(model, trackChanges(model));
 * // or alongside an existing schema:
 * f = form(model, (p) => { required(p.name); trackChanges(model)(p); });
 * ```
 */
export function trackChanges<T>(model: WritableSignal<T>): SchemaFn<T> {
  const shape = untracked(model);
  return (path) => applyTracking(path as SchemaPath<unknown>, shape);
}

/** Projector: whether the bound field differs from its baseline. Composable in `compose`. */
export const changed: FieldProjector<boolean> = (field) => () =>
  field.state().metadata(CHANGED)?.changed() ?? false;

/** Reads whether the current `[formField]` host's field has changed from its baseline. */
export function injectChanged(): Signal<boolean> {
  return injectField(changed);
}

/**
 * A composition fragment for change tracking — spread into a `composition`/`compose` to add a
 * `changed` signal and a `reset` method to a field-type's exposed state.
 *
 * - `changed`: `Signal<boolean>` — whether the field differs from its baseline.
 * - `reset(initial?)`: revert the field's value to its baseline, or — when `initial` is given —
 *   set the field to `initial` and adopt it as the new baseline.
 *
 * @example
 * ```ts
 * const [textField, injectTextField] = composition({
 *   ...changeTracking(),
 *   label: withLabel,
 * });
 * // in a control: const f = injectTextField(); f.changed(); f.reset();
 * ```
 */
export function changeTracking<T = unknown>(): {
  changed: FieldProjector<boolean>;
  // Precise (no getter arm) so `compose` materializes it to the bare method, not a union.
  reset: (field: FieldRef) => RawProjection<(initial?: T) => void>;
} {
  return {
    changed,
    reset: (field) =>
      raw((initial?: T) => {
        const tree = field.state().fieldTree as FieldTree<T>;
        if (initial !== undefined) resetInitial(tree, initial);
        else resetChanged(tree as FieldTree<unknown>);
      }),
  };
}

/**
 * A composition fragment for change tracking + reconciliation — spread into a `composition` to add
 * `changed`, `reset`, and `reconcile` to a field-type's exposed state. Includes everything from
 * {@link changeTracking}.
 *
 * - `reconcile(incoming)`: merge incoming data, preserving in-flight edits (see {@link reconcile}).
 */
export function reconciliation<T = unknown>(): {
  changed: FieldProjector<boolean>;
  reset: (field: FieldRef) => RawProjection<(initial?: T) => void>;
  reconcile: (field: FieldRef) => RawProjection<(incoming: T) => void>;
} {
  return {
    ...changeTracking<T>(),
    reconcile: (field) =>
      raw((incoming: T) =>
        reconcile(field.state().fieldTree as FieldTree<T>, incoming),
      ),
  };
}

function walk(
  tree: FieldTree<unknown>,
  fn: (state: FieldState<unknown>) => void,
): void {
  const state = tree();
  fn(state);
  const value = untracked(state.value);
  const node = tree as unknown as Record<string | number, FieldTree<unknown>>;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walk(node[i], fn);
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) walk(node[key], fn);
  }
}

/** Re-baselines every tracked node in the subtree to its current value ("mark saved"). */
export function commitChanges(tree: FieldTree<unknown>): void {
  untracked(() => walk(tree, (state) => state.metadata(CHANGED)?.commit()));
}

/**
 * Reverts the subtree to its baseline and clears native touched/dirty (via `FieldState.reset`).
 * The baseline is left untouched. (form-core `reset`.)
 */
export function resetChanged(tree: FieldTree<unknown>): void {
  const entry = tree().metadata(CHANGED);
  if (entry) untracked(() => tree().reset(untracked(entry.initial)));
}

/**
 * Adopts `value` as the subtree's new value AND baseline, clearing native touched/dirty.
 * (form-core `resetWithInitial`.)
 */
export function resetInitial<T>(tree: FieldTree<T>, value: T): void {
  untracked(() => {
    (tree as FieldTree<unknown>)().reset(value);
    commitChanges(tree as FieldTree<unknown>);
  });
}

/** A custom per-path merge for {@link reconcile}: returns the value to keep for the field. */
export type ReconcileFn<T = unknown> = (ctx: {
  current: T;
  incoming: T;
  changed: boolean;
}) => T;

const RECONCILE_WITH = createMetadataKey<ReconcileFn>();

/** Schema rule: customize how {@link reconcile} merges incoming data at a path (leaf or subtree). */
export function reconcileWith<T>(
  path: SchemaPath<T>,
  fn: ReconcileFn<T>,
): void {
  metadata(path, RECONCILE_WITH, () => fn as ReconcileFn);
}

function reconcileNode(state: FieldState<unknown>, incoming: unknown): void {
  const entry = state.metadata(CHANGED);
  const current = untracked(state.value);
  const isChanged = entry ? untracked(entry.changed) : false;

  const custom = state.metadata(RECONCILE_WITH)?.();
  if (custom) {
    state.value.set(custom({ current, incoming, changed: isChanged }));
    entry?.commit(incoming);
    return;
  }

  // Objects: recurse per-property (keep a changed leaf, adopt unchanged siblings).
  if (isRecord(current) && isRecord(incoming)) {
    for (const key of Object.keys(incoming)) {
      const child = childState(state, key);
      if (child) reconcileNode(child, incoming[key]);
    }
    entry?.commit(incoming);
    return;
  }

  // Leaf/array/type-change as a unit (override an array path for smart merges).
  if (isChanged) {
    entry?.commit(incoming); // keep the edit; rebaseline to incoming
  } else {
    state.reset(incoming);
    commitChanges(state.fieldTree);
  }
}

/**
 * Merges incoming (e.g. server) data into the form without clobbering in-flight edits: unchanged
 * fields adopt the incoming value, changed fields keep their edit; every field's baseline becomes
 * the incoming value (so a kept edit now reads as changed vs the new server state). Customize a
 * path via {@link reconcileWith}.
 */
export function reconcile<T>(tree: FieldTree<T>, incoming: T): void {
  untracked(() => reconcileNode((tree as FieldTree<unknown>)(), incoming));
}
