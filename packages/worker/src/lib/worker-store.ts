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
  applyOps,
  diffOps,
  injectTransitionScope,
  toStore,
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
   * Route a write to the OWNER: run `recipe` against a writable draft of the current replica, diff
   * it to ops, ship them. Resolves once the owner's authoritative batch carrying this write has been
   * applied to THIS replica (honest async — the value is not applied locally first; for optimistic
   * UI, fork the replica and reconcile on resolve). Rejects if the owner reports a write error.
   */
  write(recipe: (draft: WritableSignalStore<T>) => void): Promise<void>;
};

export type WorkerStoreRef<T, W extends boolean = true> = {
  /** The live, READ-ONLY replica — deep per-leaf reads, mirrored from the worker-owned subtree. */
  readonly store: SignalStore<T>;
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
 * A live READ-ONLY replica of a store subtree OWNED by the worker. Subscribes over the
 * {@link WorkerRef}, hydrates from the owner's snapshot, then applies each authoritative op batch
 * into a main-thread `store` — one `set` per batch, so a batch of N ops is a single notification
 * wave. Satisfies `ResourceLike`/`UseSource`, so it participates in transition scopes and nests in
 * `latest()`/`use()`. Writes are not local: they route to the owner (added in the next step).
 */
// manifest-driven: key constrained to the worker's stores/published, value inferred, and `write()`
// present only for OWNED keys
export function workerStore<M extends WorkerSchema, K extends StoreKeys<M>>(
  worker: WorkerRef<M>,
  key: K,
  opt?: WorkerStoreOptions<StoreValueOf<M, K> & object>,
): WorkerStoreRef<StoreValueOf<M, K> & object, IsWritableKey<M, K>>;
// explicit-value: for an untyped connection, or to override the inferred type
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
  const injector = inject(Injector); // captured for use in write() (called outside injection context)
  const root = signal<T | undefined>(opt?.defaultValue);
  // shape-adaptive: the store reflects `root` even as it goes undefined → object on first snapshot
  const replica = toStore(root as unknown as WritableSignal<T>, {
    injector,
  }) as SignalStore<T>;

  const status = signal<ResourceStatus>('loading');
  const error = signal<unknown>(undefined);
  const isLoading = computed(() => {
    const s = status();
    return s === 'loading' || s === 'reloading';
  });
  let hasSnapshot = false;
  let resyncing = false; // awaiting a fresh snapshot after a detected gap
  let lastVersion = 0;
  let writeSeq = 0;
  const writePending = new Map<
    number,
    { resolve: () => void; reject: (e: unknown) => void; version: number | null }
  >();

  const hasValue = () => hasSnapshot;

  // resolve any write whose acked authoritative version has now been applied to this replica
  const settleWrites = () => {
    for (const [id, p] of writePending) {
      if (p.version !== null && lastVersion >= p.version) {
        writePending.delete(id);
        p.resolve();
      }
    }
  };

  const onStoreMessage = (msg: WorkerEnvelope): void => {
    if (!('store' in msg) || msg.store !== key) return;
    switch (msg.type) {
      case 'store:snapshot': {
        root.set(msg.value as T);
        lastVersion = msg.version;
        hasSnapshot = true;
        resyncing = false; // a fresh snapshot ends any resync
        status.set('resolved');
        error.set(undefined);
        settleWrites();
        return;
      }
      case 'store:ops': {
        if (!hasSnapshot || resyncing) return; // pre-hydration, or dropping until a fresh snapshot
        if (msg.batch.version <= lastVersion) return; // stale/duplicate (at-least-once transport)
        if (msg.batch.version > lastVersion + 1) {
          // GAP: a batch was lost — re-hydrate from a fresh snapshot rather than apply out of order
          resync();
          return;
        }
        root.set(applyOps(untracked(root) as T, msg.batch.ops));
        lastVersion = msg.batch.version;
        settleWrites();
        return;
      }
      case 'store:write:ack': {
        const p = writePending.get(msg.writeId);
        if (!p) return;
        if (lastVersion >= msg.version) {
          writePending.delete(msg.writeId);
          p.resolve(); // the authoritative batch already landed (FIFO: ops precede the ack)
        } else {
          p.version = msg.version; // resolve once a batch reaches this version
        }
        return;
      }
      case 'store:write:error': {
        const p = writePending.get(msg.writeId);
        if (p) {
          writePending.delete(msg.writeId);
          p.reject(deserializeError(msg.error));
        }
        return;
      }
      case 'store:status': {
        // rung 3: a published derivation's remote status → this replica's status, so an in-flight
        // worker computation shows as pending on the main thread (holding the last value)
        switch (msg.status) {
          case 'error':
            error.set(msg.error ? deserializeError(msg.error) : new Error('remote computation error'));
            status.set('error');
            return;
          case 'loading':
          case 'reloading':
            error.set(undefined);
            status.set(hasSnapshot ? 'reloading' : 'loading'); // hold the value while recomputing
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
    if (hasSnapshot) status.set('reloading'); // holding stale while the fresh snapshot lands
    worker._send({ type: 'store:subscribe', store: key, clientId: worker.clientId });
  };

  // a lost batch left a version gap — hold the stale value and re-subscribe for a fresh snapshot
  const resync = (): void => {
    resyncing = true;
    status.set('reloading');
    worker._send({ type: 'store:subscribe', store: key, clientId: worker.clientId });
  };

  const unsub = worker._subscribe(onStoreMessage);
  // subscribe on each `ready` — the first connection and every auto-restart re-hydration; if the
  // connection is ALREADY up (created post-handshake), `_onReady` won't fire, so subscribe now
  const offReady = worker._onReady(subscribe);
  if (untracked(worker.connected)) subscribe();
  // a crash can't be delivered — pending writes reject (the caller holds the value + recipe to retry)
  const offDisconnect = worker._onDisconnect(() => {
    for (const [, p] of writePending) p.reject(new WorkerCrashedError());
    writePending.clear();
  });

  const self: WorkerStoreRef<T> = {
    store: replica,
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
          new Error('[@mmstack/worker] cannot write before the replica has hydrated'),
        );
      // hydrated but disconnected = the worker crashed (or is restarting) — a write posted now
      // vanishes into a dead port and its echo can never arrive. Reject; the caller retries.
      if (!untracked(worker.connected))
        return Promise.reject(new WorkerCrashedError('worker is not connected'));
      // fork-diff: a scratch store seeded with the CURRENT value (same ref → copy-on-write keeps
      // untouched subtrees shared), so diffOps against the base is O(changed paths)
      const scratch = signal(base);
      const scratchStore = toStore(scratch as unknown as WritableSignal<T>, {
        injector,
      }) as unknown as WritableSignalStore<T>;
      recipe(scratchStore);
      const ops = diffOps(base, untracked(scratch));
      if (!ops.length) return Promise.resolve();

      const writeId = ++writeSeq;
      return new Promise<void>((resolve, reject) => {
        writePending.set(writeId, { resolve, reject, version: null });
        worker._send({
          type: 'store:write',
          store: key,
          writeId,
          clientId: worker.clientId,
          ops,
        });
      });
    },
    destroy: () => {
      unsub();
      offReady();
      offDisconnect();
      // acks can no longer be received — settle any in-flight write instead of dangling it
      for (const [, p] of writePending)
        p.reject(new WorkerAbortError('worker store destroyed'));
      writePending.clear();
      worker._send({ type: 'store:unsubscribe', store: key, clientId: worker.clientId });
    },
  };

  inject(DestroyRef).onDestroy(() => self.destroy());

  if (opt?.register) {
    const scope = injectTransitionScope();
    scope.add(self, { suspends: opt.register === 'suspend' });
    // deregister on manual destroy() too, not only on context teardown — a
    // long-lived context destroying a ref by hand must not leave a zombie entry
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
