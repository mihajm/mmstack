import {
  effect,
  inject,
  Injector,
  isDevMode,
  signal,
  type Signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { isMutable } from '../mutable';
import { STORE_KIND, type StoreKind } from './internals';
import { isOpaque } from './opaque';
import { isRecord } from './predicates';

type Key = string | number;

/**
 * One structural operation. `set` on a key that did not previously exist carries NO `prev`
 * property (an absent key is not the same as a key holding `undefined` — the merge3 lesson),
 * which is what lets {@link invertBatch} invert an add into a delete.
 */
export type StoreOp =
  | { kind: 'set'; path: readonly Key[]; next: unknown; prev?: unknown }
  | { kind: 'delete'; path: readonly Key[]; prev: unknown };

/** One emission: every op derived from one commit window (a tick), in path order. */
export type OpBatch = {
  /** Identifies the emitting log — filter your own batches on a shared transport. */
  readonly origin: string;
  /** Per-log monotonic batch counter. */
  readonly version: number;
  readonly ops: readonly StoreOp[];
};

export type CreateOpLogOptions = {
  /** Transport identity for emitted batches. Defaults to a random id. */
  readonly origin?: string;
  /** Injection context for the observing effect (required outside one). */
  readonly injector?: Injector;
};

export type OpLog<T extends object> = {
  /**
   * Ordered, lossless delivery of every emitted batch. Synchronous — don't write back into
   * the observed source from inside a callback (route remote data through {@link OpLog.apply}).
   */
  subscribe(cb: (batch: OpBatch) => void): () => void;
  /** The most recent batch — a lossy sampling view (devtools); use `subscribe` for transport. */
  readonly latest: Signal<OpBatch | null>;
  /**
   * Applies ops (a remote batch, a persisted journal entry, an {@link invertBatch} result)
   * atomically: ONE `set`, one notification wave. Also advances this log's diff baseline in
   * the same step, so an applied batch produces NO echo emission — sync loops terminate by
   * construction. Local writes pending in the current tick are flushed (emitted) first, so
   * they are never silently folded into the applied baseline.
   */
  apply(ops: OpBatch | readonly StoreOp[]): void;
  /** Stops observing and drops subscribers. Also happens when the injection context dies. */
  destroy(): void;
};

function generateOrigin(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).substring(2);
}

const isPlainArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && !isOpaque(v);

/**
 * Reference-identity-pruned structural diff — the same short-circuit discipline as `merge3`:
 * an untouched subtree kept its reference (the store's copy-on-write contract), so the walk
 * descends only where refs differ. O(changed paths), not O(tree).
 */
function diffNode(
  prev: unknown,
  next: unknown,
  path: readonly Key[],
  ops: StoreOp[],
): void {
  if (Object.is(prev, next)) return;

  if (isRecord(prev) && isRecord(next)) {
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key))
        ops.push({ kind: 'delete', path: [...path, key], prev: prev[key] });
    }
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(prev, key)) {
        // added key: deliberately NO `prev` property (absent ≠ undefined)
        ops.push({ kind: 'set', path: [...path, key], next: next[key] });
      } else {
        diffNode(prev[key], next[key], [...path, key], ops);
      }
    }
    return;
  }

  if (isPlainArray(prev) && isPlainArray(next)) {
    // same length → per-index descent (matches `arr[i].x.set(...)` writes); a length
    // change is a whole unit — index attribution lies under insert/remove/reorder
    if (prev.length === next.length) {
      for (let i = 0; i < next.length; i++)
        diffNode(prev[i], next[i], [...path, i], ops);
      return;
    }
    ops.push({ kind: 'set', path, prev, next });
    return;
  }

  // leaf / type change / opaque — one unit, prev present (the slot existed)
  ops.push({ kind: 'set', path, prev, next });
}

/** Immutably applies one op along its path, vivifying missing containers `'auto'`-style. */
function applyAt(
  container: unknown,
  path: readonly Key[],
  idx: number,
  op: StoreOp,
): unknown {
  const seg = path[idx];
  const base: Record<Key, unknown> | unknown[] = isPlainArray(container)
    ? container.slice()
    : isRecord(container)
      ? { ...container }
      : typeof seg === 'number'
        ? []
        : {};

  if (idx === path.length - 1) {
    if (op.kind === 'delete') {
      // arrays never receive deletes (length changes travel as whole-array sets)
      delete (base as Record<Key, unknown>)[seg];
    } else {
      (base as Record<Key, unknown>)[seg] = op.next;
    }
    return base;
  }

  (base as Record<Key, unknown>)[seg] = applyAt(
    (base as Record<Key, unknown>)[seg],
    path,
    idx + 1,
    op,
  );
  return base;
}

/**
 * Inverts a batch for undo: reversed order, `set`↔its own inverse (an add — a `set` with no
 * `prev` — inverts to a `delete`; a `delete` inverts to a `set` restoring `prev`). Feed the
 * result to {@link OpLog.apply}. Requires the ops' `prev`s, which in-memory batches always
 * carry — a wire-serialized batch that stripped them is not invertible.
 */
export function invertBatch(batch: OpBatch | readonly StoreOp[]): StoreOp[] {
  const ops = Array.isArray(batch) ? batch : (batch as OpBatch).ops;
  const inverted: StoreOp[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === 'delete') {
      inverted.push({ kind: 'set', path: op.path, next: op.prev, prev: undefined });
      continue;
    }
    if (!Object.hasOwn(op, 'prev')) {
      inverted.push({ kind: 'delete', path: op.path, prev: op.next });
    } else {
      inverted.push({ kind: 'set', path: op.path, next: op.prev, prev: op.next });
    }
  }
  return inverted;
}

/**
 * Observes a copy-on-write signal (a `store`'s root, or any `WritableSignal` holding
 * immutably-updated objects) and emits its changes as minimal structural op batches — the
 * shared substrate for sync (ship batches, `apply` remote ones), persistence (journal
 * batches, replay on boot), undo ({@link invertBatch}), and devtools (`latest`).
 *
 * Zero store-core involvement and zero cost when unused: emission is a reference-pruned diff
 * of the root value per tick (structural sharing makes it O(changed paths)), driven by one
 * effect. A batch therefore coalesces everything written in one tick — for coarser,
 * intentional units, stage writes on a `forkStore` and `commit()` (one set → one batch).
 *
 * NOT supported on mutable stores/signals: in-place mutation keeps reference identity, which
 * defeats the diff (same reason `forkStore`'s `'fine'` strategy refuses them) — a dev-mode
 * warning fires and nothing emits.
 *
 * ```ts
 * const s = store({ todos: [{ done: false }] });
 * const log = opLog(s, { origin: 'tab-a' });
 * log.subscribe((b) => channel.postMessage(encode(b)));   // ship
 * channel.onmessage = (m) => log.apply(decode(m.data));    // apply — echo-free
 * s.todos[0].done.set(true); // → { kind: 'set', path: ['todos', 0, 'done'], … }
 * ```
 */
export function opLog<T extends object>(
  source: WritableSignal<T>,
  opt?: CreateOpLogOptions,
): OpLog<T> {
  const injector = opt?.injector ?? inject(Injector);
  const origin = opt?.origin ?? generateOrigin();

  // a store proxy's `has` trap answers for the VALUE's keys, so `isMutable`'s `'mutate' in`
  // probe can't see the brand — ask the store's own kind symbol first
  const storeKind = (source as { [STORE_KIND]?: StoreKind })[STORE_KIND];
  const mutableSource = storeKind ? storeKind === 'mutable' : isMutable(source);

  if (isDevMode() && mutableSource) {
    console.warn(
      '[@mmstack/primitives] opLog observes copy-on-write updates via reference identity — a MUTABLE store/signal mutates in place, so changes are invisible to it. Use an immutable store, or set whole values.',
    );
  }

  let prevRoot: T = untracked(source);
  let version = 0;
  let destroyed = false;
  const subscribers = new Set<(batch: OpBatch) => void>();
  const latest = signal<OpBatch | null>(null);

  /** Diff now, emit if there's a delta, advance the baseline. */
  const flush = () => {
    if (destroyed) return;
    const next = untracked(source);
    if (Object.is(prevRoot, next)) return;
    const ops: StoreOp[] = [];
    diffNode(prevRoot, next, [], ops);
    prevRoot = next;
    if (!ops.length) return; // fresh refs, equal values — spurious-write tolerance
    const batch: OpBatch = { origin, version: ++version, ops };
    latest.set(batch);
    for (const cb of [...subscribers]) cb(batch);
  };

  const ref = effect(
    () => {
      source(); // track every commit…
      untracked(flush); // …and emit the delta since the last flush
    },
    { injector: opt?.injector },
  );

  return {
    latest: latest.asReadonly(),
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    apply: (batchOrOps) => {
      const ops = Array.isArray(batchOrOps)
        ? (batchOrOps as readonly StoreOp[])
        : (batchOrOps as OpBatch).ops;
      if (!ops.length) return;
      // pending local writes must emit BEFORE the baseline advances past them
      flush();
      let root: unknown = untracked(source);
      for (const op of ops) {
        if (op.path.length === 0) {
          if (op.kind === 'set') root = op.next;
          continue; // a root delete is meaningless — ignore
        }
        root = applyAt(root, op.path, 0, op);
      }
      source.set(root as T);
      prevRoot = root as T; // baseline advance: an applied batch never echoes
    },
    destroy: () => {
      destroyed = true;
      subscribers.clear();
      ref.destroy();
    },
  };
}
