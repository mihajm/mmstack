import {
  isDevMode,
  untracked,
  type ResourceStatus,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { createWatch } from '@angular/core/primitives/signals';
import { applyOps, opLog, type OpLog } from '@mmstack/primitives';
import {
  generateId,
  PROTO_VERSION,
  serializeError,
  type HasSchema,
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
   * thread.
   */
  readonly published?: Record<string, PublishedSource<any>>;
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
  /** Serve an additional transport (multi-client / tests). Returns a disconnect handle. */
  connect(port: WorkerPortLike): () => void;
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
  /** In-flight named-task runs for THIS client, keyed by its runId (client runIds aren't global). */
  readonly taskRuns: Map<number, AbortController>;
};

type Subtree = {
  /** Untracked read of the current root value (for snapshots). */
  readonly read: () => unknown;
  readonly log: OpLog<any>;
  /** The version of the last batch emitted — a fresh subscriber's snapshot carries it. */
  version: number;
  /** The writable store for an OWNED subtree; `null` for a PUBLISHED (read-only) one. */
  readonly writable: WritableSignal<any> | null;
};

/** Maps an Angular ResourceStatus to the wire status; only the states the protocol carries. */
function toRemoteStatus(
  s: ResourceStatus,
): 'idle' | 'loading' | 'reloading' | 'resolved' | 'error' {
  return s === 'idle' || s === 'loading' || s === 'reloading' || s === 'error'
    ? s
    : 'resolved';
}

/**
 * Dev-only guard: a store value that is not structured-clonable (a function, a class instance, an
 * `opaque()` value) throws a bare `DataCloneError` from `postMessage` with no context. Catch it
 * before it hits the wire and name the store, so the fix is obvious. Stripped in production.
 */
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
  P extends Record<string, PublishedSource<any>> = Record<string, never>,
  T extends Record<string, WorkerTaskHandler> = Record<string, never>,
>(options: {
  readonly stores?: S;
  readonly published?: P;
  readonly tasks?: T;
  readonly port?: WorkerPortLike;
}): WorkerHost<{
  readonly stores: { [K in keyof S]: SignalValueOf<S[K]> };
  readonly published: { [K in keyof P]: SignalValueOf<P[K]> };
  readonly tasks: T;
}> {
  const hostId = generateId();
  // the S/P/T generics drive the RETURN type only; the body works over loose records
  const sources = (options.stores ?? {}) as Record<string, WritableSignal<any>>;
  const publishedSources = (options.published ?? {}) as Record<
    string,
    PublishedSource<any>
  >;
  const tasks = (options.tasks ?? {}) as Record<string, WorkerTaskHandler>;
  const taskNames = Object.keys(tasks);
  const storeKeys = Object.keys(sources);
  const publishedKeys = Object.keys(publishedSources);

  const subtrees = new Map<string, Subtree>();
  const connections = new Set<Connection>();
  // current wire status of each status-bearing published entry, read at subscribe time so a late
  // subscriber sees an in-flight computation as pending instead of waiting for the next transition
  const publishedStatus = new Map<
    string,
    () => 'idle' | 'loading' | 'reloading' | 'resolved' | 'error'
  >();
  const statusWatches: { destroy(): void }[] = [];

  const fanout = (store: string, message: WorkerEnvelope) => {
    for (const conn of Array.from(connections))
      if (conn.stores.has(store)) conn.port.postMessage(message);
  };

  // observe a signal's value → snapshot/ops. Owned stores also route writes; published are read-only.
  // Applied remote writes ride this same emission, echo-free (the owner is the single sequencer).
  const observe = (
    key: string,
    src: Signal<unknown>,
    writable: WritableSignal<any> | null,
  ): void => {
    const entry: Subtree = {
      read: () => untracked(src),
      log: null as unknown as OpLog<any>,
      version: 0,
      writable,
    };
    (entry as { log: OpLog<any> }).log = opLog(
      // a published (read-only) signal is only ever READ by the log — apply() is never called on it
      src as unknown as WritableSignal<any>,
      { driver: microtaskOpLogDriver(), origin: hostId },
    );
    entry.log.subscribe((batch) => {
      entry.version = batch.version;
      devAssertCloneable(batch, `store '${key}' update`);
      fanout(key, { type: 'store:ops', store: key, batch });
    });
    subtrees.set(key, entry);
  };

  for (const key of storeKeys) observe(key, sources[key], sources[key]);

  for (const key of publishedKeys) {
    const src = publishedSources[key];
    observe(key, src as Signal<unknown>, null);
    // rung 3: a status-bearing derivation (a latest()) propagates its pending/error to replicas
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
        if (!sub) return; // unknown store — silently ignore (a client typo, not fatal)
        // synchronous: read snapshot + version and register the client in one turn — no batch can
        // interleave in a single-threaded worker, so every later op carries version > this one
        conn.stores.add(msg.store);
        const snapshot = sub.read();
        devAssertCloneable(snapshot, `store '${msg.store}' snapshot`);
        conn.port.postMessage({
          type: 'store:snapshot',
          store: msg.store,
          version: sub.version,
          value: snapshot,
        });
        // a status-bearing published entry also reports its CURRENT status, so a subscriber
        // arriving mid-computation shows pending now, not on the next transition
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
      case 'store:write': {
        const sub = subtrees.get(msg.store);
        if (!sub || !sub.writable) {
          conn.port.postMessage({
            type: 'store:write:error',
            store: msg.store,
            writeId: msg.writeId,
            error: serializeError(
              new Error(
                sub
                  ? `[@mmstack/worker] store is read-only (published): ${msg.store}`
                  : `[@mmstack/worker] unknown store: ${msg.store}`,
              ),
            ),
          });
          return;
        }
        try {
          // the owner is the single sequencer: apply the routed ops through the store root, then
          // FLUSH so its opLog emits ONE authoritative owner-origin batch (fanned to every client,
          // the writer included — the echo that IS the write's confirmation). No baseline-advance
          // trick: this is a genuine owner write, indistinguishable from the worker writing itself.
          sub.writable.set(applyOps(sub.read(), msg.ops));
          sub.log.flush();
          conn.port.postMessage({
            type: 'store:write:ack',
            store: msg.store,
            writeId: msg.writeId,
            version: sub.version,
          });
        } catch (err) {
          conn.port.postMessage({
            type: 'store:write:error',
            store: msg.store,
            writeId: msg.writeId,
            error: serializeError(err),
          });
        }
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
    // assigning onmessage starts a MessagePort; a Worker/self delivers the same way
    port.onmessage = (ev) => handle(conn, ev.data as WorkerEnvelope);
    return () => {
      connections.delete(conn);
      port.onmessage = null; // a disconnected client must not keep invoking tasks/writes
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
    connect,
    flush() {
      for (const { log } of subtrees.values()) log.flush();
    },
    dispose() {
      for (const { log } of subtrees.values()) log.destroy();
      for (const w of statusWatches) w.destroy();
      connections.clear();
    },
  };
}
