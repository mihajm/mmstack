import {
  DestroyRef,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type Signal,
} from '@angular/core';
import {
  closePort,
  deserializeError,
  generateId,
  takeTransferables,
  type HasSchema,
  type SchemaOf,
  type TaskInput,
  type TaskOutput,
  type WorkerEnvelope,
  type WorkerPortLike,
  type WorkerSchema,
} from '@mmstack/worker/protocol';

/** What the worker advertised in its `ready` handshake. */
export type WorkerManifest = {
  readonly hostId: string;
  readonly stores: readonly string[];
  readonly published: readonly string[];
  readonly tasks: readonly string[];
};

/** Thrown into a task/write promise when it is aborted. `name` is `'AbortError'` (DOM convention). */
export class WorkerAbortError extends Error {
  constructor(message = 'The worker task was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Thrown into pending tasks/writes when the worker crashes. `name` is `'WorkerCrashedError'`. */
export class WorkerCrashedError extends Error {
  constructor(message = 'The worker crashed') {
    super(message);
    this.name = 'WorkerCrashedError';
  }
}

export type ConnectWorkerOptions = {
  readonly injector?: Injector;
  /** `'auto'` (default) respawns on crash; `'manual'` surfaces disconnect and stops. */
  readonly restart?: 'auto' | 'manual';
  /** Backoff before respawn attempt `n` (0-based). Default exponential 1s→30s. */
  readonly restartDelay?: (attempt: number) => number;
};

export type WorkerRef<M extends WorkerSchema = WorkerSchema> = HasSchema<M> & {
  /** True once the `ready` handshake has completed (and again after an auto-restart). */
  readonly connected: Signal<boolean>;
  /** The worker's advertised manifest, or `null` before the first `ready`. */
  readonly manifest: Signal<WorkerManifest | null>;
  /** Run a named task exposed by the worker host; resolves with its result (typed from the schema). */
  runTask<K extends keyof M['tasks'] & string>(
    task: K,
    input: TaskInput<M, K>,
    opt?: { signal?: AbortSignal; transfer?: Transferable[] },
  ): Promise<TaskOutput<M, K>>;
  destroy(): void;

  /** @internal Post an envelope to the worker. */
  _send(msg: WorkerEnvelope, transfer?: Transferable[]): void;
  /** @internal Receive every non-task envelope (store traffic). Returns an unsubscribe. */
  _subscribe(handler: (msg: WorkerEnvelope) => void): () => void;
  /** @internal Run `fn` on every (re)connection — used to re-subscribe stores after a restart. */
  _onReady(fn: () => void): () => void;
  /** @internal Run `fn` when the connection drops (crash) — replicas reject pending writes here. */
  _onDisconnect(fn: () => void): () => void;
  /** @internal This client's identity on the transport. */
  readonly clientId: string;
};

/**
 * Connects the main thread to a worker over a {@link WorkerPortLike} the caller provides via `spawn`
 * — typically `() => new Worker(new URL('./my.worker', import.meta.url), { type: 'module' })` (the
 * URL literal must live in APP code so the bundler emits the worker chunk). Performs the hello/ready
 * handshake, exposes `connected`/`manifest`, routes named-task runs, and (via internal seams)
 * carries the store-replication traffic for {@link workerStore}. On crash it respawns with backoff
 * when `restart: 'auto'`.
 */
export function connectWorker<H = WorkerSchema>(
  spawn: () => WorkerPortLike,
  opt?: ConnectWorkerOptions,
): WorkerRef<SchemaOf<H>> {
  const injector = opt?.injector ?? inject(Injector);
  return runInInjectionContext(injector, () =>
    build(spawn, opt),
  ) as unknown as WorkerRef<SchemaOf<H>>;
}

function build(
  spawn: () => WorkerPortLike,
  opt?: ConnectWorkerOptions,
): WorkerRef {
  const isServer = inject(PLATFORM_ID) === 'server';
  const clientId = generateId();
  const connected = signal(false);
  const manifest = signal<WorkerManifest | null>(null);

  const taskPending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  const storeHandlers = new Set<(msg: WorkerEnvelope) => void>();
  const readyHooks = new Set<() => void>();
  const disconnectHooks = new Set<() => void>();
  const restart = opt?.restart ?? 'auto';
  const restartDelay = opt?.restartDelay ?? ((n: number) => Math.min(30_000, 1000 * 2 ** n));
  let attempt = 0;
  let runIdSeq = 0;
  let destroyed = false;
  let crashed = false;
  let port: WorkerPortLike = null as unknown as WorkerPortLike;

  const send = (msg: WorkerEnvelope, transfer?: Transferable[]): void => {
    if (port) port.postMessage(msg, transfer);
  };

  const onMessage = (msg: WorkerEnvelope): void => {
    switch (msg.type) {
      case 'ready':
        attempt = 0;
        crashed = false;
        manifest.set({
          hostId: msg.hostId,
          stores: msg.stores,
          published: msg.published,
          tasks: msg.tasks,
        });
        connected.set(true);
        for (const hook of readyHooks) hook();
        return;
      case 'task:ok': {
        const p = taskPending.get(msg.runId);
        if (p) {
          taskPending.delete(msg.runId);
          p.resolve(msg.value);
        }
        return;
      }
      case 'task:error': {
        const p = taskPending.get(msg.runId);
        if (p) {
          taskPending.delete(msg.runId);
          p.reject(deserializeError(msg.error));
        }
        return;
      }
      case 'task:aborted':
        taskPending.delete(msg.runId);
        return;
      default:
        for (const h of storeHandlers) h(msg);
    }
  };

  const handleCrash = (): void => {
    if (destroyed) return;
    crashed = true;
    connected.set(false);
    for (const [, p] of taskPending) p.reject(new WorkerCrashedError());
    taskPending.clear();
    for (const fn of disconnectHooks) fn();
    if (restart === 'manual') return;
    const delay = restartDelay(attempt++);
    setTimeout(() => {
      if (!destroyed) openPort();
    }, delay);
  };

  const openPort = (): void => {
    if (port) closePort(port);
    port = spawn();
    port.onmessage = (ev) => onMessage(ev.data as WorkerEnvelope);
    // crash detection via property setters, not addEventListener (perturbs node MessagePort delivery)
    const evt = port as unknown as {
      onerror?: ((e?: unknown) => void) | null;
      onmessageerror?: ((e?: unknown) => void) | null;
    };
    if ('onerror' in evt) evt.onerror = handleCrash;
    if ('onmessageerror' in evt) evt.onmessageerror = handleCrash;
    send({ type: 'hello', proto: 1, clientId });
  };

  if (!isServer) openPort();

  inject(DestroyRef).onDestroy(() => teardown());

  const teardown = (): void => {
    destroyed = true;
    connected.set(false);
    for (const [, p] of taskPending) p.reject(new WorkerAbortError('worker connection destroyed'));
    taskPending.clear();
    for (const fn of disconnectHooks) fn();
    if (port) closePort(port);
  };

  return {
    connected,
    manifest,
    clientId,
    runTask(
      task: string,
      input: unknown,
      o?: { signal?: AbortSignal; transfer?: Transferable[] },
    ): Promise<unknown> {
      if (isServer) return Promise.reject(new WorkerCrashedError('no worker on the server'));
      if (destroyed) return Promise.reject(new WorkerAbortError('worker connection destroyed'));
      if (crashed) return Promise.reject(new WorkerCrashedError('worker is restarting'));
      if (o?.signal?.aborted) return Promise.reject(new WorkerAbortError());
      const runId = ++runIdSeq;
      return new Promise<unknown>((resolve, reject) => {
        taskPending.set(runId, { resolve, reject });
        send(
          { type: 'task:run', runId, task, input },
          o?.transfer ?? takeTransferables(input),
        );
        o?.signal?.addEventListener(
          'abort',
          () => {
            if (!taskPending.has(runId)) return;
            taskPending.delete(runId);
            send({ type: 'task:abort', runId });
            reject(new WorkerAbortError());
          },
          { once: true },
        );
      });
    },
    destroy: teardown,
    _send: send,
    _subscribe(handler) {
      storeHandlers.add(handler);
      return () => storeHandlers.delete(handler);
    },
    _onReady(fn) {
      readyHooks.add(fn);
      return () => readyHooks.delete(fn);
    },
    _onDisconnect(fn) {
      disconnectHooks.add(fn);
      return () => disconnectHooks.delete(fn);
    },
  };
}
