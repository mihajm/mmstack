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
import {
  injectTransitionScope,
  opLog,
  toStore,
  type SignalStore,
  type StoreOp,
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
   * Route a write to the OWNER: `recipe` applies optimistically to the store, its diff ships as ops,
   * and the owner sequences and re-emits it. Resolves once that authoritative batch reconciles this
   * replica. To hide the value until the owner confirms it, fork the store and reveal on resolve.
   * Rejects if the owner reports a write error.
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
 * A live replica of a store subtree OWNED by the worker. Subscribes over the {@link WorkerRef},
 * hydrates from the owner's snapshot, then folds each authoritative op batch into a main-thread
 * `store` through an echo-free `opLog.apply`. For an owned subtree the store is WRITABLE: a write
 * applies optimistically and its diff routes to the owner (which reconciles it back), and any
 * op-log reader — `meshSync`, `persist` — can attach to the same store, so a persisted, meshed,
 * worker-owned graph is just extra readers. Satisfies `ResourceLike`/`UseSource`, so it participates
 * in transition scopes and nests in `latest()`/`use()`.
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
  const log = opLog(root as unknown as WritableSignal<T>, { injector });

  const status = signal<ResourceStatus>('loading');
  const error = signal<unknown>(undefined);
  const isLoading = computed(() => {
    const st = status();
    return st === 'loading' || st === 'reloading';
  });
  let hasSnapshot = false;
  let resyncing = false;
  let lastVersion = 0;
  let writeSeq = 0;
  const writePending = new Map<
    number,
    {
      version: number | null;
      resolve?: () => void;
      reject?: (e: unknown) => void;
    }
  >();

  const hasValue = () => hasSnapshot;

  const isOwned = () => worker.manifest()?.stores.includes(key) ?? false;

  const settleWrites = () => {
    for (const [id, p] of writePending) {
      if (p.version !== null && lastVersion >= p.version) {
        writePending.delete(id);
        p.resolve?.();
      }
    }
  };

  const shipLocal = (ops: readonly StoreOp[]): void => {
    if (!ops.length || !isOwned() || !untracked(worker.connected)) return;
    const id = ++writeSeq;
    writePending.set(id, { version: null });
    worker._send({
      type: 'store:write',
      store: key,
      writeId: id,
      clientId: worker.clientId,
      ops,
    });
  };
  const shipUnsub = log.subscribe((batch) => shipLocal(batch.ops));

  const onStoreMessage = (msg: WorkerEnvelope): void => {
    if (!('store' in msg) || msg.store !== key) return;
    switch (msg.type) {
      case 'store:snapshot': {
        log.apply([{ kind: 'set', path: [], next: msg.value }]);
        lastVersion = msg.version;
        hasSnapshot = true;
        resyncing = false;
        status.set('resolved');
        error.set(undefined);
        settleWrites();
        return;
      }
      case 'store:ops': {
        if (!hasSnapshot || resyncing) return;
        if (msg.batch.version <= lastVersion) return;
        if (msg.batch.version > lastVersion + 1) {
          resync(); // gap: re-hydrate rather than apply out of order
          return;
        }
        log.apply(msg.batch.ops);
        lastVersion = msg.batch.version;
        settleWrites();
        return;
      }
      case 'store:write:ack': {
        const p = writePending.get(msg.writeId);
        if (!p) return;
        if (lastVersion >= msg.version) {
          writePending.delete(msg.writeId);
          p.resolve?.();
        } else {
          p.version = msg.version;
        }
        return;
      }
      case 'store:write:error': {
        const p = writePending.get(msg.writeId);
        if (p) {
          writePending.delete(msg.writeId);
          p.reject?.(deserializeError(msg.error));
        }
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
    resyncing = true;
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
    for (const [, p] of writePending) p.reject?.(new WorkerCrashedError());
    writePending.clear();
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
      const before = writeSeq;
      log.flush();
      if (writeSeq === before) return Promise.resolve();
      const writeId = writeSeq;
      return new Promise<void>((resolve, reject) => {
        const p = writePending.get(writeId);
        if (!p) return resolve();
        p.resolve = resolve;
        p.reject = reject;
      });
    },
    destroy: () => {
      shipUnsub();
      log.destroy();
      unsub();
      offReady();
      offDisconnect();
      for (const [, p] of writePending)
        p.reject?.(new WorkerAbortError('worker store destroyed'));
      writePending.clear();
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
