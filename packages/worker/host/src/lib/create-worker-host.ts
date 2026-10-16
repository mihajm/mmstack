import {
  isDevMode,
  isSignal,
  signal,
  untracked,
  type ResourceStatus,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { createWatch } from '@angular/core/primitives/signals';
import {
  createHlcClock,
  frontierEquals,
  opSync,
  type OpSync,
} from '@mmstack/primitives/core';
import {
  generateId,
  PROTO_VERSION,
  serializeError,
  type HasSchema,
  type StoreFrontier,
  type SignalValueOf,
  type WorkerEnvelope,
  type WorkerPortLike,
  type WorkerSchema,
} from '@mmstack/worker/protocol';
import { microtaskOpLogDriver } from './microtask-driver';

/** A named unit of compute a worker exposes (rung 1). `ctx.signal` aborts when the caller cancels. */
export type WorkerTaskHandler<I = any, O = any> = (
  input: I,
  ctx: { readonly signal: AbortSignal },
) => O | Promise<O>;

/** A published derivation: a plain signal, or a status-bearing one (a `latest()`) for pending propagation. */
export type PublishedSource<T> =
  | Signal<T>
  | (Signal<T | undefined> & { readonly status: Signal<ResourceStatus> });

/** Per owned store, the frontier its state was folded to (see {@link WorkerHost.frontiers}). */
export type WorkerHostFrontiers<K extends PropertyKey = string> = {
  readonly [P in K]: Signal<StoreFrontier>;
};

/** What a published factory receives: the host's owned-store frontiers, ready to read. */
export type PublishedHost<K extends PropertyKey = string> = {
  readonly frontiers: WorkerHostFrontiers<K>;
};

/**
 * A `published` entry: a source, or a factory the host calls once at creation with
 * {@link PublishedHost} (late binding), so a derivation can read the frontier of the stores it
 * derives from and carry it in its value.
 */
export type PublishedEntry<T, K extends PropertyKey = string> =
  PublishedSource<T> | ((host: PublishedHost<K>) => PublishedSource<T>);

/** The value type a `published` entry mirrors: the signal's, or the factory's returned signal's. */
export type PublishedValueOf<E> =
  E extends Signal<any>
    ? SignalValueOf<E>
    : E extends (host: never) => infer R
      ? SignalValueOf<R>
      : never;

export type CreateWorkerHostOptions = {
  /**
   * Store subtrees this worker OWNS — the single writer. Keys are the wire identifiers. Typed as
   * the plain writable-signal interface (any copy-on-write `WritableSignal<object>` qualifies, per
   * `opLog`); a concrete `store<T>` satisfies it without the mapped-store variance friction that
   * `WritableSignalStore<any>` would introduce.
   */
  readonly stores?: Record<string, WritableSignal<any>>;
  /**
   * Read-only DERIVED subtrees the worker PUBLISHES (rung 3) — a `Signal<T>` (e.g. a `computed` or
   * `projection`) or a status-bearing async derivation (a `latest()`). Main-thread `workerStore`s
   * mirror them like owned stores but cannot write; a status-bearing entry also propagates its
   * pending/error to the replica, so an in-flight worker computation shows as pending on the main
   * thread. An entry may also be a factory `({ frontiers }) => source`, called once at creation.
   */
  readonly published?: Record<string, PublishedEntry<any>>;
  /** Named tasks callable from the main thread (rung 1). */
  readonly tasks?: Record<string, WorkerTaskHandler>;
  /**
   * Transport to serve on. Defaults to the worker global scope (`self`) when running in a real
   * Worker, so `my.worker.ts` never touches `self`. Pass an explicit port for tests (a
   * `MessageChannel` port) or a SharedWorker fan-in.
   */
  readonly port?: WorkerPortLike;
};

export type WorkerHost<M extends WorkerSchema = WorkerSchema> = HasSchema<M> & {
  /** This host's transport identity — the `origin` of every store batch it emits. */
  readonly hostId: string;
  /**
   * Per OWNED store, what its state has applied: this host's generation (`instance` = {@link hostId})
   * and the highest stamp folded in from each writer (a `StoreFrontier`). Updated in the same synchronous step as the
   * store's own signal when a client write folds in, and when an owner write is stamped (a direct
   * owner write is stamped at the next microtask, `flush()`, or before any published derivation
   * emits). A `computed` reading a store and its frontier therefore sees a consistent pair at every
   * emission. A published derivation can carry it (`{ ..., of: frontiers.room() }`); a replica
   * compares it with its own `applied` via `storeFrontierEquals`. A replacement host is a new
   * generation: no frontier of the old one ever equals one of the new.
   */
  readonly frontiers: WorkerHostFrontiers<keyof M['stores']>;
  /** Serve an additional transport (multi-client / tests). Returns a disconnect handle. */
  connect(port: WorkerPortLike): () => void;
  /**
   * Apply an AUTHORITATIVE owner correction to an owned store: writes made inside `fn` are stamped
   * at a bumped epoch, so they deterministically win the merge against any concurrent replica write
   * (owner authority rides the epoch fold). Readers can gate effects on owner-settled values by the
   * winning op's epoch. No-op for a read-only (published) or unknown store.
   */
  override(store: string, fn: () => void): void;
  /**
   * Synchronously emit any pending owned-store changes to subscribers NOW, instead of waiting for
   * the microtask driver. Makes the mirror deterministic (tests call it before asserting) and is
   * the honest settle point before applying a routed write (phase 4). No-op when nothing is pending.
   */
  flush(): void;
  /** Stop every owned opLog and drop all connections. */
  dispose(): void;
};

type Connection = {
  readonly port: WorkerPortLike;
  clientId: string | null;
  readonly stores: Set<string>;
  readonly taskRuns: Map<number, AbortController>;
};

type Subtree = {
  readonly read: () => unknown;
  readonly sync: OpSync<any>;
  readonly writable: boolean;
  /** Re-read the sync core's applied frontier into the store's frontier signal (owned only). */
  readonly syncFrontier: () => void;
};

function toRemoteStatus(
  s: ResourceStatus,
): 'idle' | 'loading' | 'reloading' | 'resolved' | 'error' {
  return s === 'idle' || s === 'loading' || s === 'reloading' || s === 'error'
    ? s
    : 'resolved';
}

// dev-only: catch a non-cloneable store value before postMessage throws a context-free DataCloneError
function devAssertCloneable(value: unknown, what: string): void {
  if (!isDevMode()) return;
  try {
    structuredClone(value);
  } catch (err) {
    throw new Error(
      `[@mmstack/worker] ${what} holds a value that cannot be sent across the worker boundary. ` +
        `Synced state must be structured-clonable: functions, class instances, and opaque() values ` +
        `do not serialize. Keep it to plain JSON-like data.`,
      { cause: err },
    );
  }
}

function isWorkerGlobal(g: unknown): g is WorkerPortLike {
  const scope = (globalThis as { WorkerGlobalScope?: unknown })
    .WorkerGlobalScope;
  return (
    typeof scope === 'function' &&
    g instanceof (scope as new () => unknown) &&
    typeof (g as { postMessage?: unknown }).postMessage === 'function'
  );
}

/**
 * The worker-side runtime: owns store subtrees, hosts tasks, and mirrors owned state to every
 * connected client as op batches. Plain functions + signals — NO Angular DI (there is none in a
 * worker); each owned store is observed by a real {@link opLog} driven off the microtask queue.
 *
 * ```ts
 * // my.worker.ts
 * const todos = store<Todo[]>([], workerStoreContext());
 * createWorkerHost({ stores: { todos } });   // serves `self` by default
 * ```
 */
export function createWorkerHost<
  S extends Record<string, WritableSignal<any>> = Record<string, never>,
  P extends Record<string, PublishedEntry<any, keyof S>> = Record<
    string,
    never
  >,
  T extends Record<string, WorkerTaskHandler> = Record<string, never>,
>(options: {
  readonly stores?: S;
  // the NoInfer arm types a factory's `frontiers` from S while P is still being inferred
  readonly published?:
    P | NoInfer<Record<string, PublishedEntry<any, keyof S>>>;
  readonly tasks?: T;
  readonly port?: WorkerPortLike;
  // NoInfer: an expected return type (a host assigned into a typed slot) must not drive inference of
  // P through `PublishedValueOf`, which would widen an omitted `published` to `{ [x: string]: any }`
}): NoInfer<
  WorkerHost<{
    readonly stores: { [K in keyof S]: SignalValueOf<S[K]> };
    readonly published: { [K in keyof P]: PublishedValueOf<P[K]> };
    readonly tasks: T;
  }>
> {
  const hostId = generateId();
  const sources = (options.stores ?? {}) as Record<string, WritableSignal<any>>;
  const publishedEntries = (options.published ?? {}) as Record<
    string,
    PublishedEntry<any>
  >;
  const tasks = (options.tasks ?? {}) as Record<string, WorkerTaskHandler>;
  const taskNames = Object.keys(tasks);
  const storeKeys = Object.keys(sources);
  const publishedKeys = Object.keys(publishedEntries);

  const subtrees = new Map<string, Subtree>();
  const connections = new Set<Connection>();
  const publishedStatus = new Map<
    string,
    () => 'idle' | 'loading' | 'reloading' | 'resolved' | 'error'
  >();
  const statusWatches: { destroy(): void }[] = [];

  const fanout = (store: string, message: WorkerEnvelope) => {
    for (const conn of Array.from(connections))
      if (conn.stores.has(store)) conn.port.postMessage(message);
  };

  const frontiers: Record<string, Signal<StoreFrontier>> = {};

  // Owned stores emit before any published derivation does, so a derivation that reads a store and
  // its frontier never ships a value ahead of the frontier it carries (an unstamped owner write).
  const flushOwned = (): void => {
    for (const key of storeKeys) subtrees.get(key)?.sync.flush();
  };
  const publishedDriver = () => {
    const base = microtaskOpLogDriver();
    return (run: () => void) =>
      base(() => {
        untracked(flushOwned);
        run();
      });
  };

  const observe = (
    key: string,
    src: Signal<unknown>,
    writable: boolean,
  ): void => {
    // Each subtree runs the owner's opSync (a real origin + HLC): its batches are real envelopes,
    // so the whole main<->worker sync is opSync over the MessageChannel transport, no bespoke
    // sequencer. Owner writes emit host-origin envelopes; received client writes fold in and are
    // relayed on. Emission is driven off the microtask queue (no injector inside a worker).
    const sync = opSync(src as unknown as WritableSignal<any>, {
      writer: hostId,
      origin: `${hostId}:${key}`,
      instance: hostId, // the owner generation every envelope and frontier carries
      driver: writable ? microtaskOpLogDriver() : publishedDriver(),
      clock: createHlcClock(),
    });
    const frontierOf = (): StoreFrontier => ({
      instance: hostId,
      applied: sync.appliedFrontier(),
    });
    const frontier = signal<StoreFrontier>(frontierOf(), {
      equal: (a, b) => frontierEquals(a.applied, b.applied),
    });
    const syncFrontier = (): void => frontier.set(frontierOf());
    if (writable) frontiers[key] = frontier.asReadonly();
    sync.subscribe((env) => {
      syncFrontier(); // the stamped write is applied: same step as the emission
      devAssertCloneable(env, `store '${key}' update`);
      fanout(key, { type: 'store:sync', store: key, env });
    });
    subtrees.set(key, {
      read: () => untracked(src),
      sync,
      writable,
      syncFrontier,
    });
  };

  for (const key of storeKeys) observe(key, sources[key], true);

  const publishedHost: PublishedHost = { frontiers };

  for (const key of publishedKeys) {
    const entry = publishedEntries[key];
    const src: PublishedSource<any> =
      typeof entry === 'function' && !isSignal(entry)
        ? (entry as (host: PublishedHost) => PublishedSource<any>)(
            publishedHost,
          )
        : (entry as PublishedSource<any>);
    observe(key, src as Signal<unknown>, false);
    const statusSig = (src as { status?: Signal<ResourceStatus> }).status;
    if (statusSig) {
      publishedStatus.set(key, () => toRemoteStatus(untracked(statusSig)));
      let scheduled = false;
      let last: ResourceStatus | null = null;
      const w = createWatch(
        () => {
          const s = statusSig();
          if (s === last) return;
          last = s;
          fanout(key, {
            type: 'store:status',
            store: key,
            status: toRemoteStatus(s),
          });
        },
        (watch) => {
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            watch.run();
          });
        },
        false,
      );
      w.notify();
      statusWatches.push(w);
    }
  }

  const runTask = (
    conn: Connection,
    runId: number,
    handler: WorkerTaskHandler,
    input: unknown,
  ): void => {
    const ac = new AbortController();
    conn.taskRuns.set(runId, ac);
    Promise.resolve()
      .then(() => handler(input, { signal: ac.signal }))
      .then(
        (value) => {
          if (ac.signal.aborted)
            conn.port.postMessage({ type: 'task:aborted', runId });
          else conn.port.postMessage({ type: 'task:ok', runId, value });
        },
        (err) => {
          if (ac.signal.aborted)
            conn.port.postMessage({ type: 'task:aborted', runId });
          else
            conn.port.postMessage({
              type: 'task:error',
              runId,
              error: serializeError(err),
            });
        },
      )
      .finally(() => {
        if (conn.taskRuns.get(runId) === ac) conn.taskRuns.delete(runId);
      });
  };

  const handle = (conn: Connection, msg: WorkerEnvelope): void => {
    switch (msg.type) {
      case 'hello': {
        conn.clientId = msg.clientId;
        conn.port.postMessage({
          type: 'ready',
          proto: PROTO_VERSION,
          hostId,
          stores: storeKeys,
          published: publishedKeys,
          tasks: taskNames,
        });
        return;
      }
      case 'store:subscribe': {
        const sub = subtrees.get(msg.store);
        if (!sub) return;
        conn.stores.add(msg.store);
        if (!sub.writable) flushOwned(); // a derivation's checkpoint never runs ahead of its frontier
        sub.sync.flush(); // settle any pending owner change into the register state first
        const checkpoint = sub.sync.snapshot();
        devAssertCloneable(checkpoint, `store '${msg.store}' checkpoint`);
        conn.port.postMessage({
          type: 'store:checkpoint',
          store: msg.store,
          checkpoint,
          instance: hostId,
          applied: sub.sync.appliedFrontier(),
        });
        const currentStatus = publishedStatus.get(msg.store);
        if (currentStatus)
          conn.port.postMessage({
            type: 'store:status',
            store: msg.store,
            status: currentStatus(),
          });
        return;
      }
      case 'store:unsubscribe': {
        conn.stores.delete(msg.store);
        return;
      }
      case 'task:run': {
        const handler = tasks[msg.task];
        if (!handler) {
          conn.port.postMessage({
            type: 'task:error',
            runId: msg.runId,
            error: serializeError(
              new Error(`[@mmstack/worker] unknown task: ${msg.task}`),
            ),
          });
          return;
        }
        runTask(conn, msg.runId, handler, msg.input);
        return;
      }
      case 'task:abort': {
        conn.taskRuns.get(msg.runId)?.abort();
        conn.taskRuns.delete(msg.runId);
        return;
      }
      case 'store:sync': {
        // a routed client write: fold it into the owner store, then RELAY it to every subscriber
        // (including the sender, whose replica reads its own echo as the write acknowledgement).
        // Writes to a read-only (published) or unknown store are ignored: those never route.
        const sub = subtrees.get(msg.store);
        if (!sub || !sub.writable) return;
        sub.sync.receive(msg.env);
        sub.syncFrontier(); // same synchronous step as the store's fold
        fanout(msg.store, { type: 'store:sync', store: msg.store, env: msg.env });
        return;
      }
    }
  };

  const connect = (port: WorkerPortLike): (() => void) => {
    const conn: Connection = {
      port,
      clientId: null,
      stores: new Set(),
      taskRuns: new Map(),
    };
    connections.add(conn);
    port.onmessage = (ev) => handle(conn, ev.data as WorkerEnvelope);
    return () => {
      connections.delete(conn);
      port.onmessage = null;
      for (const ac of conn.taskRuns.values()) ac.abort();
      conn.taskRuns.clear();
    };
  };

  const defaultPort: WorkerPortLike | undefined =
    options.port ??
    (isWorkerGlobal(globalThis)
      ? (globalThis as unknown as WorkerPortLike)
      : undefined);
  if (defaultPort) connect(defaultPort);

  return {
    hostId,
    frontiers: frontiers as WorkerHostFrontiers<keyof S>,
    connect,
    override(store, fn) {
      const sub = subtrees.get(store);
      if (sub?.writable) sub.sync.override(fn);
    },
    flush() {
      for (const { sync } of subtrees.values()) sync.flush();
    },
    dispose() {
      for (const { sync } of subtrees.values()) sync.destroy();
      for (const w of statusWatches) w.destroy();
      connections.clear();
    },
  };
}
