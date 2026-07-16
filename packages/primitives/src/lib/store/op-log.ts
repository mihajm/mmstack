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
 *
 * `clear` is a sync-layer intent, not a value change: it retires a per-path register (the
 * observed-remove half of a subtree replace) and contributes NOTHING to a value: {@link applyOps}
 * treats it as a no-op and the structural diff ({@link diffOps}) never emits one. Only the sync
 * emission layer produces clears; they ride batches so undo/rebase plumbing can pass them through.
 */
export type StoreOp =
  | { kind: 'set'; path: readonly Key[]; next: unknown; prev?: unknown }
  | { kind: 'delete'; path: readonly Key[]; prev: unknown }
  | { kind: 'clear'; path: readonly Key[] };

/** One emission: every op derived from one commit window (a tick), in path order. */
export type OpBatch = {
  /** Identifies the emitting log — filter your own batches on a shared transport. */
  readonly origin: string;
  /** Per-log monotonic batch counter. */
  readonly version: number;
  readonly ops: readonly StoreOp[];
};

/**
 * Drives an {@link opLog}'s emission reaction. Given the `run` closure (which reads the source in
 * a tracking context and flushes the delta), a driver arranges for `run` to execute now and again
 * on every subsequent change, returning a handle that stops it. The default driver is an Angular
 * `effect` (needs an injector). Supply a custom driver to run an opLog with NO injector; a
 * renderer-independent one built on `@angular/core/primitives/signals` `createWatch` ships as
 * `microtaskOpLogDriver` from `@mmstack/worker/host` (the Web Worker seam).
 */
export type OpLogDriver = (run: () => void) => { destroy(): void };

export type CreateOpLogOptions = {
  /** Transport identity for emitted batches. Defaults to a random id. */
  readonly origin?: string;
  /** Injection context for the default effect-based driver (required outside one). */
  readonly injector?: Injector;
  /**
   * Replaces the default Angular-`effect` emission driver. Supply a custom driver (e.g.
   * `microtaskOpLogDriver` from `@mmstack/worker/host`) to run an opLog with NO injector. When
   * given, `injector` is ignored and no injection context is required.
   */
  readonly driver?: OpLogDriver;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type OpLog<T extends object> = {
  /**
   * Ordered, lossless delivery of every emitted batch. Synchronous — don't write back into
   * the observed source from inside a callback (route remote data through {@link OpLog.apply}).
   */
  subscribe(cb: (batch: OpBatch) => void): () => void;
  /** The most recent batch — a lossy sampling view (devtools); use `subscribe` for transport. */
  readonly latest: Signal<OpBatch | null>;
  /**
   * Synchronously diff the source and emit any pending change NOW, rather than waiting for the
   * driver's scheduled run (an app tick, or a custom driver's microtask). Idempotent
   * and coalescing: writes since the last emission compose into one batch, and a `flush()` with
   * nothing pending is a no-op. Use it to make emission deterministic — the worker host calls it
   * to settle its mirror synchronously (tests), and it underpins the flush-before-apply honesty of
   * {@link OpLog.apply}. Independent of the driver: a later scheduled run simply finds no diff.
   */
  flush(): void;
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
  op: Exclude<StoreOp, { kind: 'clear' }>,
): unknown {
  const seg = path[idx];
  if (seg === '__proto__') return container;
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
 * Pure, store-free application of ops onto a plain root value, returning the next immutable root
 * (structural-sharing along op paths, missing containers vivified `'auto'`-style). This is the
 * same transform {@link OpLog.apply} runs, extracted so a replica can fold a received batch into
 * a value WITHOUT owning a diffing {@link opLog} — e.g. the worker-graph read-replica seam.
 * Accepts a batch or a bare op list.
 */
export function applyOps<T>(root: T, ops: OpBatch | readonly StoreOp[]): T {
  const list = Array.isArray(ops) ? ops : (ops as OpBatch).ops;
  let next: unknown = root;
  for (const op of list) {
    if (op.kind === 'clear') continue; // register retirement, never a value change
    if (op.path.length === 0) {
      if (op.kind === 'set') next = op.next;
      continue; // a root delete is meaningless — ignore (mirrors OpLog.apply)
    }
    next = applyAt(next, op.path, 0, op);
  }
  return next as T;
}

/**
 * Pure reference-pruned structural diff of two roots into minimal ops (the emission core of
 * {@link opLog}, exported so code outside a log can produce a batch — e.g. diffing a scratch
 * draft against a replica's current value to route a write to its owner). Trusts the
 * copy-on-write contract: an untouched subtree that kept its reference is skipped. Emits only
 * `set` and `delete`; `clear` is an emission-layer intent, never a diff product.
 */
export function diffOps(prev: unknown, next: unknown): StoreOp[] {
  const ops: StoreOp[] = [];
  diffNode(prev, next, [], ops);
  return ops;
}

/**
 * Inverts a batch for undo: reversed order, `set`↔its own inverse (an add — a `set` with no
 * `prev` — inverts to a `delete`; a `delete` inverts to a `set` restoring `prev`). Feed the
 * result to {@link OpLog.apply}. Requires the ops' `prev`s, which in-memory batches always
 * carry (a wire-serialized batch that stripped them is not invertible). A `clear` is skipped:
 * it never changed a value, so it has no independent inverse (the accompanying subtree `set`'s
 * `prev` subsumes restoration).
 */
export function invertBatch(batch: OpBatch | readonly StoreOp[]): StoreOp[] {
  const ops = Array.isArray(batch) ? batch : (batch as OpBatch).ops;
  const inverted: StoreOp[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === 'clear') continue;
    if (op.kind === 'delete') {
      // no `prev`: the key is ABSENT once the delete applied, so this inverse is an add —
      // inverting it again yields the delete back (redo removes the key, not sets undefined)
      inverted.push({ kind: 'set', path: op.path, next: op.prev });
      continue;
    }
    if (!Object.hasOwn(op, 'prev')) {
      inverted.push({ kind: 'delete', path: op.path, prev: op.next });
    } else {
      inverted.push({
        kind: 'set',
        path: op.path,
        next: op.prev,
        prev: op.next,
      });
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
  const origin = opt?.origin ?? generateOrigin();

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

  const run = () => {
    source(); // track every commit…
    untracked(flush); // …and emit the delta since the last flush
  };

  // default driver is an Angular effect (needs an injector); a supplied driver runs injector-free
  // (the worker-side seam, e.g. microtaskOpLogDriver from @mmstack/worker/host)
  const ref = opt?.driver
    ? opt.driver(run)
    : effect(run, { injector: opt?.injector ?? inject(Injector) });

  return {
    latest: latest.asReadonly(),
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    // the emission core, callable on demand — reads the source untracked, so it never disturbs the
    // driver's subscription; a subsequent scheduled run just finds the baseline already advanced
    flush: () => flush(),
    apply: (batchOrOps) => {
      const ops = Array.isArray(batchOrOps)
        ? (batchOrOps as readonly StoreOp[])
        : (batchOrOps as OpBatch).ops;
      if (!ops.length) return;
      // pending local writes must emit BEFORE the baseline advances past them
      flush();
      const root = applyOps(untracked(source), ops); // one atomic root, structural-shared
      source.set(root);
      prevRoot = root; // baseline advance: an applied batch never echoes
    },
    destroy: () => {
      destroyed = true;
      subscribers.clear();
      ref.destroy();
    },
  };
}
