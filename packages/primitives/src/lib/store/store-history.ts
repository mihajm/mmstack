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
   * peers' changes then never land on your undo stack.
   */
  readonly track?: { subscribe(cb: (batch: OpBatch) => void): () => void };
};

/**
 * Undo/redo for a copy-on-write store, built on the op-log: each tracked change is stored as
 * its inverse batch, so `undo()` is one `apply` and history costs only the diffs, not full
 * snapshots. Redoing is invert-of-the-inverse. A new edit made after an undo clears the redo
 * stack (linear history). Applying a redo/undo does not itself re-enter history.
 *
 * Composes with sync for collaborative undo: pass `track: syncClient` so only YOUR writes are
 * undoable, while `undo()` emits a normal op that propagates to peers (it writes through the
 * store, which the sync client picks up).
 */
export function storeHistory<T extends object>(
  source: WritableSignal<T>,
  opt?: StoreHistoryOptions,
): StoreHistory {
  const limit = opt?.limit ?? 100;

  const logOpt: CreateOpLogOptions = { origin: opt?.origin };
  if (opt?.driver) (logOpt as { driver?: unknown }).driver = opt.driver;
  else (logOpt as { injector?: Injector }).injector = opt?.injector ?? inject(Injector);
  const log = opLog(source, logOpt);

  const undoStack: StoreOp[][] = [];
  const redoStack: StoreOp[][] = [];
  const version = signal(0); // monotonic: bumps on every mutation so the computeds recompute
  let applying = false;

  const push = (stack: StoreOp[][], inverse: StoreOp[]): void => {
    stack.push(inverse);
    if (stack.length > limit) stack.shift();
  };

  const record = (batch: OpBatch): void => {
    if (applying) return; // an undo/redo's own emission must not re-enter history
    if (!batch.ops.length) return;
    push(undoStack, invertBatch(batch));
    redoStack.length = 0; // a fresh edit forks the timeline
    version.update((v) => v + 1);
  };

  // track the sync client's local stream when given, else self-diff every store change
  const unsub = (opt?.track ?? log).subscribe(record);

  const run = (from: StoreOp[][], to: StoreOp[][]): void => {
    const inverse = from.pop();
    if (!inverse) return;
    log.flush(); // settle pending local writes before applying
    applying = true;
    try {
      log.apply(inverse);
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
    clear: () => {
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
