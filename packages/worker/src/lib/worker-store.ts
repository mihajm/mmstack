import {
  computed,
  DestroyRef,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  type ResourceStatus,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { createWatch } from '@angular/core/primitives/signals';
import {
  injectTransitionScope,
  opSync,
  toStore,
  type OpEnvelope,
  type OpLogDriver,
  type SignalStore,
  type WritableSignalStore,
} from '@mmstack/primitives';
import {
  deserializeError,
  type IsWritableKey,
  type StoreKeys,
  type StoreValueOf,
  type WorkerEnvelope,
  type WorkerSchema,
} from '@mmstack/worker/protocol';
import {
  WorkerAbortError,
  WorkerCrashedError,
  type WorkerRef,
} from './connect-worker';

// An injector-free opLog driver (schedules emission off the microtask queue via `createWatch`), so
// the replica's `opSync` emits without depending on an application tick. Writes force a synchronous
// `flush()` at the call site; between writes, owner envelopes drive apply, never local emission.
const microtaskDriver = (): OpLogDriver => (run) => {
  let scheduled = false;
  const watch = createWatch(
    () => run(),
    (w) => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        w.run();
      });
    },
    false,
  );
  watch.notify();
  return { destroy: () => watch.destroy() };
};

export type WorkerStoreOptions<T> = {
  readonly injector?: Injector;
  /** Value the replica holds before the first snapshot arrives. */
  readonly defaultValue?: T;
  /** Register into the nearest transition scope while hydrating/reloading. */
  readonly register?: false | 'indicator' | 'suspend';
};

/** The write path — present only on OWNED (writable) subtrees; absent on published (read-only) ones. */
export type WorkerStoreWrite<T> = {
  /**
   * Route a write to the OWNER: `recipe` applies optimistically to the store, its diff ships as a
   * stamped op envelope, and the owner folds it in and echoes it back. Resolves once the owner has
   * acknowledged it (its echo reconciles this replica). The owner can override with a higher-epoch
   * correction that wins the merge. To hide the value until the owner confirms it, fork the store
   * and reveal on resolve. Rejects if the worker is disconnected or the store is read-only.
   */
  write(recipe: (draft: WritableSignalStore<T>) => void): Promise<void>;
};

export type WorkerStoreRef<T, W extends boolean = true> = {
  /**
   * The live store. For an OWNED subtree it is a full {@link WritableSignalStore}: writes apply
   * optimistically and route to the owner, and other op-log readers (`meshSync`, `persist`) can
   * attach to it. For a PUBLISHED subtree it is a read-only {@link SignalStore} mirror.
   */
  readonly store: W extends true ? WritableSignalStore<T> : SignalStore<T>;
  /** The replica root value (undefined before hydration). */
  readonly value: Signal<T | undefined>;
  readonly status: Signal<ResourceStatus>;
  readonly error: Signal<unknown>;
  readonly isLoading: Signal<boolean>;
  /** The underlying worker connection's liveness. */
  readonly connected: Signal<boolean>;
  hasValue(): boolean;
  destroy(): void;
} & (W extends true ? WorkerStoreWrite<T> : object);

/**
 * A live replica of a store subtree OWNED by the worker. It runs its own `opSync` over the worker
 * transport: it hydrates from the owner's checkpoint, then folds each owner (or peer) envelope into
 * a main-thread `store` convergently. For an owned subtree the store is WRITABLE: a write applies
 * optimistically and its stamped envelope routes to the owner (which folds it and echoes it back),
 * and any op-log reader — `meshSync`, `persist` — can attach to the same store, so a persisted,
 * meshed, worker-owned graph is just extra readers. Satisfies `ResourceLike`/`UseSource`, so it
 * participates in transition scopes and nests in `latest()`/`use()`.
 */
export function workerStore<M extends WorkerSchema, K extends StoreKeys<M>>(
  worker: WorkerRef<M>,
  key: K,
  opt?: WorkerStoreOptions<StoreValueOf<M, K> & object>,
): WorkerStoreRef<StoreValueOf<M, K> & object, IsWritableKey<M, K>>;
export function workerStore<T extends object>(
  worker: WorkerRef,
  key: string,
  opt?: WorkerStoreOptions<T>,
): WorkerStoreRef<T, true>;
export function workerStore(
  worker: WorkerRef,
  key: string,
  opt?: WorkerStoreOptions<any>,
): WorkerStoreRef<any, boolean> {
  const injector = opt?.injector ?? inject(Injector);
  return runInInjectionContext(injector, () => build(worker, key, opt));
}

function build<T extends object>(
  worker: WorkerRef,
  key: string,
  opt?: WorkerStoreOptions<T>,
): WorkerStoreRef<T, true> {
  const injector = inject(Injector);
  const root = signal<T | undefined>(opt?.defaultValue);
  const s = toStore(root as unknown as WritableSignal<T>, {
    injector,
  }) as unknown as WritableSignalStore<T>;
  // The replica runs its own opSync over the worker transport: local writes emit stamped envelopes
  // routed to the owner, owner envelopes fold in convergently. A driver (not the injector) so
  // emission stays synchronous under an explicit `flush()`, matching the DI-free worker model.
  const sync = opSync(root as unknown as WritableSignal<T>, {
    writer: worker.clientId,
    driver: microtaskDriver(),
    onGap: () => resync(),
  });

  const status = signal<ResourceStatus>('loading');
  const error = signal<unknown>(undefined);
  const isLoading = computed(() => {
    const st = status();
    return st === 'loading' || st === 'reloading';
  });
  let hasSnapshot = false;
  let lastEmitted = 0; // highest own-origin version emitted; the write() ack key
  // own writes awaiting the owner's echo (resolve), plus the raw envelopes to resend after a resync
  const writePending = new Map<
    number,
    { resolve: () => void; reject: (e: unknown) => void }
  >();
  const unacked = new Map<number, OpEnvelope>();

  const hasValue = () => hasSnapshot;

  const isOwned = () => worker.manifest()?.stores.includes(key) ?? false;

  const ackUpTo = (version: number): void => {
    for (const [v, p] of writePending) {
      if (v <= version) {
        writePending.delete(v);
        p.resolve();
      }
    }
    for (const v of [...unacked.keys()]) if (v <= version) unacked.delete(v);
  };

  const shipUnsub = sync.subscribe((env) => {
    lastEmitted = env.version;
    unacked.set(env.version, env);
    if (isOwned() && untracked(worker.connected)) {
      worker._send({ type: 'store:sync', store: key, env });
    }
  });

  const onStoreMessage = (msg: WorkerEnvelope): void => {
    if (!('store' in msg) || msg.store !== key) return;
    switch (msg.type) {
      case 'store:checkpoint': {
        // rebase from the full unacked outbox, not opSync's bounded recent-local ring, so a burst
        // of writes larger than that ring is never dropped from the local rebase on re-hydrate
        sync.hydrate(msg.checkpoint as Parameters<typeof sync.hydrate>[0], [
          ...unacked.values(),
        ]);
        hasSnapshot = true;
        status.set('resolved');
        error.set(undefined);
        // writes the owner already applied are covered by the checkpoint watermark; resolve them,
        // then resend any still-unacked tail so a write made before the (re)hydrate is never lost
        ackUpTo(msg.checkpoint.wm?.[sync.origin] ?? 0);
        if (isOwned() && untracked(worker.connected)) {
          for (const env of [...unacked.values()].sort(
            (a, b) => a.version - b.version,
          )) {
            worker._send({ type: 'store:sync', store: key, env });
          }
        }
        return;
      }
      case 'store:sync': {
        const env = msg.env;
        if (env.origin === sync.origin) {
          ackUpTo(env.version); // the owner echoed our own write back: acknowledgement
          return;
        }
        sync.receive(env); // owner or peer envelope; a version gap triggers onGap -> resync
        return;
      }
      case 'store:status': {
        switch (msg.status) {
          case 'error':
            error.set(
              msg.error
                ? deserializeError(msg.error)
                : new Error('remote computation error'),
            );
            status.set('error');
            return;
          case 'loading':
          case 'reloading':
            error.set(undefined);
            status.set(hasSnapshot ? 'reloading' : 'loading');
            return;
          case 'resolved':
            error.set(undefined);
            if (hasSnapshot) status.set('resolved');
            return;
          default:
            return;
        }
      }
    }
  };

  const subscribe = (): void => {
    if (hasSnapshot) status.set('reloading');
    worker._send({
      type: 'store:subscribe',
      store: key,
      clientId: worker.clientId,
    });
  };

  const resync = (): void => {
    status.set('reloading');
    worker._send({
      type: 'store:subscribe',
      store: key,
      clientId: worker.clientId,
    });
  };

  const unsub = worker._subscribe(onStoreMessage);
  const offReady = worker._onReady(subscribe);
  if (untracked(worker.connected)) subscribe(); // already up (created post-handshake): _onReady won't fire
  const offDisconnect = worker._onDisconnect(() => {
    for (const [, p] of writePending) p.reject(new WorkerCrashedError());
    writePending.clear();
    unacked.clear();
  });

  const self: WorkerStoreRef<T> = {
    store: s,
    value: root.asReadonly(),
    status,
    error,
    isLoading,
    connected: worker.connected,
    hasValue,
    write: (recipe) => {
      const base = untracked(root);
      if (base === undefined)
        return Promise.reject(
          new Error(
            '[@mmstack/worker] cannot write before the replica has hydrated',
          ),
        );
      if (!untracked(worker.connected))
        return Promise.reject(
          new WorkerCrashedError('worker is not connected'),
        );
      if (!isOwned())
        return Promise.reject(
          new Error(`[@mmstack/worker] store is read-only (published): ${key}`),
        );
      recipe(s);
      const before = lastEmitted;
      sync.flush(); // emit the routed write synchronously (driver-backed opSync)
      if (lastEmitted === before) return Promise.resolve(); // no-op recipe: nothing shipped
      const version = lastEmitted;
      return new Promise<void>((resolve, reject) => {
        writePending.set(version, { resolve, reject });
      });
    },
    destroy: () => {
      shipUnsub();
      sync.destroy();
      unsub();
      offReady();
      offDisconnect();
      for (const [, p] of writePending)
        p.reject(new WorkerAbortError('worker store destroyed'));
      writePending.clear();
      unacked.clear();
      worker._send({
        type: 'store:unsubscribe',
        store: key,
        clientId: worker.clientId,
      });
    },
  };

  inject(DestroyRef).onDestroy(() => self.destroy());

  if (opt?.register) {
    const scope = injectTransitionScope();
    scope.add(self, { suspends: opt.register === 'suspend' });
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      scope.remove(self);
    };
    inject(DestroyRef).onDestroy(remove);
    const destroy = self.destroy;
    self.destroy = () => {
      remove();
      destroy();
    };
  }

  return self;
}
