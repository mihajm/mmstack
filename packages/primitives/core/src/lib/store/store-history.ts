import {
  computed,
  inject,
  Injector,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  applyOps,
  diffOps,
  invertBatch,
  opLog,
  type DiffOpsOptions,
  type CreateOpLogOptions,
  type EmitContext,
  type OpBatch,
  type StoreOp,
} from './op-log';
import {
  undoMergeFor,
  type FoldPolicyEntry,
  type MergePolicyEntry,
} from './op-sync';
import { structEq } from './predicates';

export type StoreHistory = {
  readonly canUndo: Signal<boolean>;
  readonly canRedo: Signal<boolean>;
  /**
   * Revert the most recent tracked change, selectively: only what that change did is taken back,
   * and what other writers changed since stays (see {@link storeHistory}). A no-op when nothing
   * is undoable.
   */
  undo(): void;
  /** Re-apply the most recently undone change: the inverse of what the undo actually applied. */
  redo(): void;
  /**
   * Close the current coalescing run: the next tracked change starts a NEW undo entry even if
   * it lands inside the `coalesce` window. Call it on the boundaries your UX considers an
   * action — a field blur, a selection change, a drag drop. A no-op without `coalesce`.
   */
  checkpoint(): void;
  /** Forget all tracked history (e.g. after a save boundary). */
  clear(): void;
  destroy(): void;
};

export type StoreHistoryOptions = CreateOpLogOptions & {
  /**
   * Max entries kept per stack (default 100). An ENTRY count, not a byte limit: an entry holds
   * the roots before and after its change, which share structure with the store but can keep an
   * unrelated subtree alive after the store dropped it, until the entry itself is dropped.
   */
  readonly limit?: number;
  /**
   * The change stream to track. Defaults to self-diffing `source` (every change to the store
   * becomes undoable). For collaborative-safe undo, pass a sync client's LOCAL envelope stream
   * (e.g. an `opSync`'s `subscribe`, which fires only for this peer's own writes) — remote
   * peers' changes then never land on your undo stack. When the stream exposes `flush` (an
   * `opSync` does), undo/redo drain it synchronously so their own emissions never echo back
   * onto the stack as fresh entries. A stream that passes the {@link EmitContext} (`opSync`,
   * `opLog`) gives each change the root it produced when it was emitted; without it the store is
   * read when the change is delivered, which a deferred delivery has already moved past.
   */
  readonly track?: {
    subscribe(cb: (batch: OpBatch, ctx?: EmitContext) => void): () => void;
    flush?(): void;
  };
  /**
   * Merge rapid consecutive edits into ONE undo entry, so a typing run undoes as a unit
   * instead of per keystroke. A tracked change arriving within `ms` of the previous one AND
   * touching the same paths with the same op kinds extends the previous entry (set
   * `samePath: false` to merge on time alone); anything else — a different field, a kind
   * change, a pause longer than `ms`, a `checkpoint()`, an undo/redo — starts a new entry.
   * The window is measured between consecutive changes, so an unbroken run keeps merging.
   *
   * A run continues only while each change starts from where the run left the paths it touches:
   * a discontinuity (one of those paths no longer holds what the run left there, e.g. after a
   * remote edit on a tracked sync) closes it. The check compares values, so a remote edit that
   * was reverted again before the next change (ABA) is not seen and the run continues. A merged
   * entry is ONE write from the run's first value to its last; its net is what differs between
   * them (parents and children alike), and only my own changes enter it, never a remote edit
   * elsewhere. Undoing it undoes the run as if it had been one write, which equals undoing its
   * changes one by one when no other writer touched those paths since the run began. A run that
   * ends where it started leaves no entry.
   */
  readonly coalesce?: { readonly ms: number; readonly samePath?: boolean };
  /**
   * The merge policies of the sync this history tracks: pass the SAME array you gave the sync
   * (`opSync`, `tabSync`, `meshSync`). They decide how an undo merges with what others wrote
   * since (see {@link storeHistory}). Absent: the defaults (no policy anywhere).
   */
  readonly policies?: readonly MergePolicyEntry[];
  /** The sync's custom register folds, likewise: an undo at a custom-fold path restores whole. */
  readonly folds?: readonly FoldPolicyEntry[];
  /** Clock for the coalescing window (injectable for tests; default `Date.now`). */
  readonly now?: () => number;
};

/** The value at `path`, with presence (a key holding `undefined` is found). */
function lookup(
  root: unknown,
  path: readonly (string | number)[],
): { found: boolean; value: unknown } {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg))
      return { found: false, value: undefined };
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return { found: true, value: cur };
}

type Key = string | number;
const UNIT: DiffOpsOptions = { arrays: 'unit' };

const PATH_SEP = '';
const OP_SEP = '';

/**
 * Undo/redo for a copy-on-write store, built on the op-log: each tracked change is stored as the
 * pair of roots before and after it (copy-on-write roots share everything the change did not
 * touch, so an entry costs about the changed spine), and `undo()` applies the inverse of what
 * differs between them. Redo inverts what the undo actually applied. A new edit made after an undo clears
 * the redo stack (linear history). Applying a redo/undo does not itself re-enter history.
 *
 * Undo is SELECTIVE. An inverse `set` whose path still holds what my change wrote applies as
 * is. When the value moved on since (another writer changed it), the inverse merges with the
 * current value: `merge(mine-after, mine-before, current)`, chosen per path from `policies` —
 * an array with no policy merges by `undoMerge` (my slots go back, theirs stay; if others moved
 * elements since, my inverse applies whole), a `keyedArray` merge policy merges by identity, an
 * explicit `lww` or a custom fold restores whole, anything else merges like `merge3`. Undoing my
 * add removes the key only while it still holds what I added (an edit by others wins); undoing
 * my delete always restores.
 *
 * Composes with sync for collaborative undo: pass `track: syncClient` so only YOUR writes are
 * undoable, while `undo()` emits a normal op that propagates to peers (it writes through the
 * store, which the sync client picks up). Coalescing groups only this stack's entries — what
 * goes over the wire is untouched.
 */
export function storeHistory<T extends object>(
  source: WritableSignal<T>,
  opt?: StoreHistoryOptions,
): StoreHistory {
  const limit = opt?.limit ?? 100;
  const coalesce = opt?.coalesce;
  const now = opt?.now ?? Date.now;

  const logOpt: CreateOpLogOptions = { origin: opt?.origin };
  if (opt?.driver) (logOpt as { driver?: unknown }).driver = opt.driver;
  else
    (logOpt as { injector?: Injector }).injector =
      opt?.injector ?? inject(Injector);
  const log = opLog(source, logOpt);
  const undoMergeAt = undoMergeFor(opt?.policies, opt?.folds);

  /**
   * An undo entry: the root before and after my change(s). A coalesced run extends `after` with
   * my own ops only, so a remote edit elsewhere never enters it; the net to undo is what differs
   * between the two roots. A redo entry, and an undo entry pushed back by a redo, is the inverse
   * of what was actually applied.
   */
  type Entry =
    | { readonly before: unknown; after: unknown }
    | { readonly inverse: StoreOp[] };
  const undoStack: Entry[] = [];
  const redoStack: Entry[] = [];
  const version = signal(0); // monotonic: bumps on every mutation so the computeds recompute
  let applying = false;

  let runOpen = false;
  let lastAt = 0;
  let lastSig = '';

  const sigOf = (ops: readonly StoreOp[]): string =>
    ops.map((o) => `${o.kind}:${o.path.join(PATH_SEP)}`).join(OP_SEP);

  const sameAt = (a: unknown, b: unknown, path: readonly Key[]): boolean => {
    const x = lookup(a, path);
    const y = lookup(b, path);
    return x.found && y.found
      ? structEq(x.value, y.value)
      : x.found === y.found;
  };

  /** The net change of an entry, as the inverse ops that undo it (array changes as units). */
  const inverseOf = (entry: Entry): StoreOp[] =>
    'inverse' in entry
      ? entry.inverse
      : invertBatch(diffOps(entry.before, entry.after, UNIT));

  const changes = (before: unknown, after: unknown): boolean =>
    diffOps(before, after, UNIT).length > 0;

  /**
   * The inverse batch resolved against the CURRENT value, op by op: what the undo (or redo)
   * actually applies. Each resolved op carries the current value as its `prev`, so its inverse
   * (the redo entry) restores exactly what was there.
   */
  const resolve = (inverse: StoreOp[]): StoreOp[] => {
    let root: unknown = untracked(source);
    const out: StoreOp[] = [];
    for (const op of inverse) {
      if (op.kind === 'clear') continue;
      const here = lookup(root, op.path);
      let next: StoreOp | null;
      if (op.kind === 'delete') {
        // undoing my add: only while the key still holds what I added (an edit by others wins)
        next =
          here.found && structEq(here.value, op.prev)
            ? { kind: 'delete', path: op.path, prev: here.value }
            : null;
      } else {
        const value =
          !Object.hasOwn(op, 'prev') ||
          (here.found && structEq(op.prev, here.value))
            ? op.next // undoing my delete, or nobody wrote here since: my inverse as is
            : undoMergeAt(op.path)(op.prev, op.next, here.value, {
                path: op.path,
              });
        next = here.found
          ? { kind: 'set', path: op.path, prev: here.value, next: value }
          : { kind: 'set', path: op.path, next: value };
      }
      if (!next) continue;
      out.push(next);
      root = applyOps(root, [next]);
    }
    return out;
  };

  const push = (stack: Entry[], entry: Entry): void => {
    stack.push(entry);
    if (stack.length > limit) stack.shift();
  };

  const record = (batch: OpBatch, ctx?: EmitContext): void => {
    if (applying) return; // an undo/redo's own emission must not re-enter history
    if (!batch.ops.length) return;
    // the root right after THIS change, as captured when it was emitted: a deferred sync
    // notification arrives after remote folds, and the store by then holds them too
    const after =
      ctx && Object.hasOwn(ctx, 'root')
        ? ctx.root
        : (untracked(source) as unknown);
    const before = applyOps(after, invertBatch(batch)); // and right before it
    const at = now();
    const sig = coalesce ? sigOf(batch.ops) : '';
    const top = undoStack[undoStack.length - 1];
    if (
      coalesce &&
      runOpen &&
      top &&
      !('inverse' in top) &&
      at - lastAt <= coalesce.ms &&
      (coalesce.samePath === false || sig === lastSig) &&
      // continuous: every path this change touches starts where the run left it
      batch.ops.every(
        (o) => o.kind === 'clear' || sameAt(before, top.after, o.path),
      )
    ) {
      top.after = applyOps(top.after, batch.ops); // my own ops onto my own after-root
      if (!changes(top.before, top.after)) {
        // the run came back to where it started: no entry (an undo that does nothing)
        undoStack.pop();
        runOpen = false;
        lastAt = at;
        redoStack.length = 0;
        version.update((v) => v + 1);
        return;
      }
    } else {
      if (!changes(before, after)) return; // nothing to undo
      push(undoStack, { before, after });
    }
    runOpen = true;
    lastAt = at;
    lastSig = sig;
    redoStack.length = 0; // a fresh edit forks the timeline
    version.update((v) => v + 1);
  };

  // track the sync client's local stream when given, else self-diff every store change
  const unsub = (opt?.track ?? log).subscribe(record);

  const flushTrack = (): void => opt?.track?.flush?.();

  const run = (from: Entry[], to: Entry[]): void => {
    flushTrack();
    log.flush();
    const entry = from.pop();
    if (!entry) return;
    runOpen = false; // stepping through history is a boundary: the next edit starts fresh
    const applied = resolve(inverseOf(entry));
    applying = true;
    try {
      if (applied.length) log.apply(applied);
      flushTrack();
    } finally {
      applying = false;
    }
    // the inverse of what we APPLIED restores the other direction
    if (applied.length) push(to, { inverse: invertBatch(applied) });
    version.update((v) => v + 1);
  };

  return {
    canUndo: computed(() => (version(), undoStack.length > 0)),
    canRedo: computed(() => (version(), redoStack.length > 0)),
    undo: () => run(undoStack, redoStack),
    redo: () => run(redoStack, undoStack),
    checkpoint: () => {
      runOpen = false;
    },
    clear: () => {
      runOpen = false;
      undoStack.length = 0;
      redoStack.length = 0;
      version.update((v) => v + 1);
    },
    destroy: () => {
      unsub();
      log.destroy();
      undoStack.length = 0; // entries hold roots: release them with the handle's subscriptions
      redoStack.length = 0;
      runOpen = false;
      version.update((v) => v + 1);
    },
  };
}
