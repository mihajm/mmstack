import {
  computed,
  inject,
  Injector,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  invertBatch,
  opLog,
  type CreateOpLogOptions,
  type OpBatch,
  type StoreOp,
} from './op-log';

export type StoreHistory = {
  readonly canUndo: Signal<boolean>;
  readonly canRedo: Signal<boolean>;
  /** Revert the most recent tracked change; a no-op when nothing is undoable. */
  undo(): void;
  /** Re-apply the most recently undone change. */
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
  /** Max entries kept per stack (default 100). */
  readonly limit?: number;
  /**
   * The change stream to track. Defaults to self-diffing `source` (every change to the store
   * becomes undoable). For collaborative-safe undo, pass a sync client's LOCAL envelope stream
   * (e.g. an `opSync`'s `subscribe`, which fires only for this peer's own writes) — remote
   * peers' changes then never land on your undo stack. When the stream exposes `flush` (an
   * `opSync` does), undo/redo drain it synchronously so their own emissions never echo back
   * onto the stack as fresh entries.
   */
  readonly track?: {
    subscribe(cb: (batch: OpBatch) => void): () => void;
    flush?(): void;
  };
  /**
   * Merge rapid consecutive edits into ONE undo entry, so a typing run undoes as a unit
   * instead of per keystroke. A tracked change arriving within `ms` of the previous one AND
   * touching the same paths with the same op kinds extends the previous entry (set
   * `samePath: false` to merge on time alone); anything else — a different field, a kind
   * change, a pause longer than `ms`, a `checkpoint()`, an undo/redo — starts a new entry.
   * The window is measured between consecutive changes, so an unbroken run keeps merging.
   * Undoing a merged entry is exactly equivalent to undoing its changes one by one.
   */
  readonly coalesce?: { readonly ms: number; readonly samePath?: boolean };
  /** Clock for the coalescing window (injectable for tests; default `Date.now`). */
  readonly now?: () => number;
};

const PATH_SEP = '';
const OP_SEP = '';

/**
 * Undo/redo for a copy-on-write store, built on the op-log: each tracked change is stored as
 * its inverse batch, so `undo()` is one `apply` and history costs only the diffs, not full
 * snapshots. Redoing is invert-of-the-inverse. A new edit made after an undo clears the redo
 * stack (linear history). Applying a redo/undo does not itself re-enter history.
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

  const undoStack: StoreOp[][] = [];
  const redoStack: StoreOp[][] = [];
  const version = signal(0); // monotonic: bumps on every mutation so the computeds recompute
  let applying = false;

  let runOpen = false;
  let lastAt = 0;
  let lastSig = '';

  const sigOf = (ops: readonly StoreOp[]): string =>
    ops.map((o) => `${o.kind}:${o.path.join(PATH_SEP)}`).join(OP_SEP);

  const mergeInto = (entry: StoreOp[], incoming: StoreOp[]): StoreOp[] => {
    const merged = [...entry];
    const rest: StoreOp[] = [];
    for (const inc of incoming) {
      const key = inc.path.join(PATH_SEP);
      const at = merged.findIndex((o) => o.path.join(PATH_SEP) === key);
      const cur = at >= 0 ? merged[at] : undefined;
      if (cur && cur.kind === 'set' && inc.kind === 'set') {
        const composed: Extract<StoreOp, { kind: 'set' }> = {
          kind: 'set',
          path: cur.path,
          next: cur.next,
        };
        // absent `prev` means the composed inverse is an add (inverts to a delete): the newest
        // forward op removed the key, so redo must remove it again
        if (Object.hasOwn(inc, 'prev')) composed.prev = inc.prev;
        merged[at] = composed;
      } else {
        rest.push(inc);
      }
    }
    return rest.length ? [...rest, ...merged] : merged;
  };

  const push = (stack: StoreOp[][], inverse: StoreOp[]): void => {
    stack.push(inverse);
    if (stack.length > limit) stack.shift();
  };

  const record = (batch: OpBatch): void => {
    if (applying) return; // an undo/redo's own emission must not re-enter history
    if (!batch.ops.length) return;
    const inverse = invertBatch(batch);
    const at = now();
    const sig = coalesce ? sigOf(batch.ops) : '';
    if (
      coalesce &&
      runOpen &&
      undoStack.length > 0 &&
      at - lastAt <= coalesce.ms &&
      (coalesce.samePath === false || sig === lastSig)
    ) {
      undoStack[undoStack.length - 1] = mergeInto(
        undoStack[undoStack.length - 1],
        inverse,
      );
    } else {
      push(undoStack, inverse);
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

  const run = (from: StoreOp[][], to: StoreOp[][]): void => {
    flushTrack();
    log.flush();
    const inverse = from.pop();
    if (!inverse) return;
    runOpen = false; // stepping through history is a boundary: the next edit starts fresh
    applying = true;
    try {
      log.apply(inverse);
      flushTrack();
    } finally {
      applying = false;
    }
    push(to, invertBatch(inverse)); // the inverse of what we applied restores the other direction
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
    },
  };
}
