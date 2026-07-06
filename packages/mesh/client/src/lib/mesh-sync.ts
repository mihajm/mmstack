import {
  computed,
  DestroyRef,
  inject,
  Injector,
  isDevMode,
  runInInjectionContext,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  checkEnvelope,
  MESH_PROTO_VERSION,
  type OpPolicy,
  type PresenceState,
  type PrincipalCtx,
  type SeqEnvelope,
  type ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  opSync,
  registerResource,
  type AsyncStore,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type ResourceLike,
} from '@mmstack/primitives';
import type { MeshTransport, MeshTransportFactory } from './transport';

export type MeshStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ejected'
  | 'closed';

export type MeshPeer = PresenceState;

/**
 * A composed, user-facing health status for a synced store the surface that
 * turns a versioned reject from a dead socket into a speakable 'outdated' banner.
 */
export type SyncHealthStatus =
  | 'live'
  | 'offline'
  | 'outdated'
  | 'ejected'
  | 'degraded';

export type SyncHealth = {
  readonly status: SyncHealthStatus;
  /** Why, when the status is `outdated`/`ejected`/`degraded`. */
  readonly reason?:
    | 'proto'
    | 'policy-version'
    | 'schema'
    | 'quota'
    | 'worker'
    | (string & {});
  /** `Date.now()` of the last successful sync (welcome or applied env). */
  readonly lastSyncedAt?: number;
};

// a versioned reject means "your build is behind" → prompt an update, not a dead socket
const OUTDATED_REASONS: ReadonlySet<string> = new Set([
  'proto',
  'policy-version',
  'schema',
]);

export type MeshSyncOptions = {
  readonly room: string;
  /** Opaque principal pseudonym — provided, never minted. */
  readonly writer: string;
  readonly transport: MeshTransportFactory;
  /** Per-path merge policies for rebase/convergence (`lww` default). */
  readonly policies?: readonly MergePolicyEntry[];
  /** Emit-side validation, symmetric with the relay's (tripwire honesty). */
  readonly policy?: OpPolicy;
  /** kind/claims of this principal, so a shared policy evaluates identically on both sides. */
  readonly ctx?: Omit<PrincipalCtx, 'writer'>;
  readonly policyVersion?: number;
  /** The data shape this client speaks. Older-than-room → `outdated`, and a
   *  newer-schema migration envelope arriving mid-session flips this client to `outdated` too. */
  readonly schemaVersion?: number;
  /** Exponential backoff cap for reconnects (default 15s; base 500ms + jitter). */
  readonly reconnect?: { readonly maxDelayMs?: number };
  readonly injector?: Injector;
  /** Register with the nearest transition scope so (re)connection surfaces as `pending`. */
  readonly register?: 'track' | 'suspend';
  readonly onEject?: (reason: string) => void;
  /**
   * Hold the connection until the local base is assembled. `meshSync` awaits this before it connects
   * (and before it restores an `outbox`), so a store hydrated from another source first (a worker
   * graph, a disk snapshot) is in place when the room welcome arrives and rebases pending on top.
   * The status stays `connecting` while it is pending. A rejection is treated as ready, so a base
   * that fails to load never wedges the connection.
   */
  readonly whenReady?: () => PromiseLike<void> | void;
  /**
   * Persist the unacknowledged local outbox (and this client's stable origin) so offline writes
   * survive a REBOOT, not just a live reconnect: on boot they are restored and rebased onto the room
   * on the next welcome, instead of being lost with in-memory state. The payload is written to
   * `store` under `key`, debounced.
   *
   * By default (`crossTab: 'queue'`) a Web Lock on `key` makes this a single-writer-per-key resource:
   * a second tab sharing the key WAITS (stays `connecting`, surfaced via `status`/`health`) until the
   * first releases, rather than restoring the same origin and colliding on version mints. Set
   * `crossTab: 'off'` to skip the lock and coordinate ownership yourself (e.g. a per-tab key, or
   * leader election over `tabSync`). A debounced write means a hard crash within the debounce window
   * can drop the very last mint — a small, best-effort gap; tune it with `debounceMs`.
   */
  readonly outbox?: {
    readonly key: string;
    readonly store: AsyncStore;
    /** Coalesce outbox writes by this many ms (default 300; `0` = write on every change). */
    readonly debounceMs?: number;
    /**
     * Cross-tab contention for the shared `key`. `'queue'` (default) holds a Web Lock so only one tab
     * owns the durable outbox at a time; others wait. `'off'` skips the lock (you coordinate).
     * (A future `'ephemeral'` — non-leaders run live with a throwaway origin — is planned.)
     */
    readonly crossTab?: 'queue' | 'off';
  };
};

/** The shape persisted under `outbox.key`: the stable origin, the emit high-water, and the tail. */
type PersistedOutbox = {
  readonly origin: string;
  readonly version: number;
  readonly envs: readonly OpEnvelope[];
};

export type MeshSyncRef = {
  readonly status: Signal<MeshStatus>;
  /** Composed sync-health for a user-facing surface. */
  readonly health: Signal<SyncHealth>;
  readonly peers: Signal<readonly MeshPeer[]>;
  /** Publish this client's ephemeral presence payload (cursor, section, activity…). */
  setPresence(data: unknown): void;
  close(): void;
};

const RECONNECT_BASE_MS = 500;
const OUTBOX_DEBOUNCE_MS = 300;

/**
 * Replicates a signal store across clients through a relay room: local writes emit stamped
 * envelopes, remote envelopes fold in convergently, reconnects resume via delta or snapshot
 * with unacknowledged local writes rebased on top, and presence rides an ephemeral channel.
 * A synced store reads exactly like a local one — connection state surfaces only through
 * `status` and the transition scope.
 */
export function meshSync<T extends object>(
  source: WritableSignal<T>,
  opt: MeshSyncOptions,
): MeshSyncRef {
  const injector = opt.injector ?? inject(Injector);
  const status = signal<MeshStatus>('connecting');
  const lastReason = signal<string | undefined>(undefined);
  const lastSyncedAt = signal<number | undefined>(undefined);
  const peerMap = signal<ReadonlyMap<string, MeshPeer>>(new Map());
  const peers = computed(() => [...peerMap().values()]);
  const policyVersion = opt.policyVersion ?? 0;

  const health = computed<SyncHealth>(() => {
    const at = lastSyncedAt();
    switch (status()) {
      case 'live':
        return { status: 'live', lastSyncedAt: at };
      case 'ejected': {
        const reason = lastReason();
        return reason && OUTDATED_REASONS.has(reason)
          ? { status: 'outdated', reason, lastSyncedAt: at }
          : { status: 'ejected', reason, lastSyncedAt: at };
      }
      default: // connecting / reconnecting / closed — not reachable
        return { status: 'offline', lastSyncedAt: at };
    }
  });

  // Created lazily: with a persisted outbox we must adopt the stored origin BEFORE minting anything
  let sync!: OpSync<T>;
  let started = false;
  let unsubLocal: () => void = () => undefined;

  const unacked = new Map<number, OpEnvelope>();
  let highestAcked = 0;
  let lastSeq = 0;
  let epoch: string | undefined;
  let presenceData: unknown;
  let hasPresence = false;
  let transport: MeshTransport | null = null;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubs: (() => void)[] = [];
  let closed = false;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  // single-writer Web Lock (crossTab:'queue'): `release` frees it for the next tab once acquired;
  // `cancel` aborts a still-queued request if we tear down before the lock is ever granted.
  let releaseLock: (() => void) | undefined;
  let cancelLock: (() => void) | undefined;

  const doPersist = (): void => {
    if (!opt.outbox || !started) return;
    const payload: PersistedOutbox = {
      origin: sync.origin,
      version: sync.watermark()[sync.origin] ?? 0,
      envs: [...unacked.values()],
    };
    void Promise.resolve(opt.outbox.store.set(opt.outbox.key, payload));
  };
  // coalesce outbox writes; `immediate` forces a synchronous-path write (first boot, teardown)
  const persistOutbox = (immediate = false): void => {
    if (!opt.outbox) return;
    if (immediate) {
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      doPersist();
      return;
    }
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      doPersist();
    }, opt.outbox.debounceMs ?? OUTBOX_DEBOUNCE_MS);
  };

  const terminal = (state: 'ejected' | 'closed', reason?: string): void => {
    closed = true;
    cancelLock?.(); // drop a still-queued lock request so we never steal it after teardown
    releaseLock?.(); // free a held lock for the next waiting tab
    cancelLock = releaseLock = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    for (const unsub of unsubs.splice(0)) unsub();
    unsubLocal();
    persistOutbox(true); // save the still-unacked tail for the next boot before dropping it
    unacked.clear();
    transport?.close();
    transport = null;
    peerMap.set(new Map());
    lastReason.set(reason);
    status.set(state);
    if (reason !== undefined) opt.onEject?.(reason);
  };

  const sendEnv = (env: OpEnvelope): void => {
    transport?.send({ t: 'env', room: opt.room, env });
  };

  const flushUnacked = (): void => {
    for (const env of [...unacked.values()].sort(
      (a, b) => a.version - b.version,
    )) {
      sendEnv(env);
    }
  };

  const handle = (msg: ServerMsg): void => {
    if (msg.room !== opt.room) return;
    switch (msg.t) {
      case 'welcome': {
        if (epoch !== undefined && msg.epoch !== epoch) lastSeq = 0;
        epoch = msg.epoch;
        peerMap.set(new Map(msg.peers.map((p) => [p.origin, p])));
        if (msg.mode === 'delta') {
          for (const env of msg.envs) applyRemote(env);
        } else if (msg.mode === 'snapshot') {
          sync.hydrate(msg.root as T, { [sync.origin]: highestAcked });
          lastSeq = msg.seq;
        } else if (msg.seq === 0 && lastSeq === 0) {
          sync.seed();
        }
        lastSeq = Math.max(lastSeq, msg.seq);
        attempts = 0;
        lastSyncedAt.set(Date.now());
        status.set('live');
        flushUnacked();
        if (hasPresence)
          transport?.send({
            t: 'presence',
            room: opt.room,
            data: presenceData,
          });
        return;
      }
      case 'env':
        applyRemote(msg.env);
        return;
      case 'presence': {
        const next = new Map(peerMap());
        if (msg.gone) next.delete(msg.peer.origin);
        else next.set(msg.peer.origin, msg.peer);
        peerMap.set(next);
        return;
      }
      case 'eject':
        if (msg.writer === opt.writer) terminal('ejected', msg.reason);
        return;
      case 'reject':
        terminal('ejected', msg.reason);
        return;
    }
  };

  const applyRemote = (env: SeqEnvelope): void => {
    lastSeq = Math.max(lastSeq, env.seq);
    lastSyncedAt.set(Date.now());
    // a migration to a shape newer than ours: stop applying + surface 'outdated' (never downgrade-interpret newer data)
    if (
      opt.schemaVersion !== undefined &&
      env.schemaVersion !== undefined &&
      env.schemaVersion > opt.schemaVersion
    ) {
      terminal('ejected', 'schema');
      return;
    }
    if (env.origin === sync.origin) {
      unacked.delete(env.version);
      highestAcked = Math.max(highestAcked, env.version);
      persistOutbox();
      return;
    }
    sync.receive(env);
  };

  const connect = (): void => {
    if (closed) return;
    for (const unsub of unsubs.splice(0)) unsub();
    const t = opt.transport();
    transport = t;
    unsubs = [
      t.onMessage(handle),
      t.onClose(() => {
        if (closed || transport !== t) return;
        transport = null;
        status.set('reconnecting');
        const delay = Math.min(
          opt.reconnect?.maxDelayMs ?? 15_000,
          RECONNECT_BASE_MS * 2 ** attempts++,
        );
        reconnectTimer = setTimeout(
          () => {
            reconnectTimer = undefined;
            connect();
          },
          delay + Math.random() * 100,
        );
      }),
    ];
    t.send({
      t: 'hello',
      room: opt.room,
      origin: sync.origin,
      proto: MESH_PROTO_VERSION,
      policyVersion,
      seq: lastSeq > 0 ? lastSeq : undefined,
      schemaVersion: opt.schemaVersion,
    });
  };

  const wireLocal = (): void => {
    unsubLocal = sync.subscribe((env) => {
      const violation = checkEnvelope(opt.policy, env, {
        ...opt.ctx,
        writer: opt.writer,
      });
      if (violation) {
        if (isDevMode()) {
          console.warn(
            '[@mmstack/mesh] local write violates the room policy — not sent',
            violation,
          );
        }
        return;
      }
      unacked.set(env.version, env);
      persistOutbox();
      if (status() === 'live') sendEnv(env);
    });
  };

  const initCore = (restore?: PersistedOutbox): void => {
    if (closed) return;
    sync = opSync(source, {
      writer: opt.writer,
      policies: opt.policies,
      policyVersion,
      injector,
      origin: restore?.origin,
    });
    started = true;
    wireLocal();
    if (restore && (restore.envs.length > 0 || restore.version > 0)) {
      sync.restore(restore.envs, restore.version); // → subscribe repopulates `unacked` for resend
    }
    persistOutbox(true); // pin the (possibly freshly minted) origin so later boots reuse it
    connect();
  };

  if (opt.register) {
    const connection: ResourceLike = {
      status: computed(() => {
        const s = status();
        return s === 'connecting'
          ? 'loading'
          : s === 'reconnecting'
            ? 'reloading'
            : s === 'ejected'
              ? 'error'
              : 'resolved';
      }),
      isLoading: computed(
        () => status() === 'connecting' || status() === 'reconnecting',
      ),
      hasValue: () => true,
    };
    runInInjectionContext(injector, () =>
      registerResource(connection, { suspends: opt.register === 'suspend' }),
    );
  }

  injector.get(DestroyRef).onDestroy(() => {
    if (!closed) terminal('closed');
    unsubLocal();
    if (started) sync.destroy();
  });

  // Load the persisted outbox, then boot with the adopted origin. A fresh/unreadable slot boots clean.
  const bootFromDisk = async (): Promise<void> => {
    if (closed || !opt.outbox) return;
    let saved: PersistedOutbox | undefined;
    try {
      const raw = await opt.outbox.store.get(opt.outbox.key);
      saved =
        raw && typeof raw === 'object' && 'origin' in raw
          ? (raw as PersistedOutbox)
          : undefined;
    } catch {
      saved = undefined; // an unreadable slot must not wedge the boot
    }
    initCore(saved);
  };

  const beginConnect = (): void => {
    if (closed) return;
    if (!opt.outbox) {
      initCore();
    } else if ((opt.outbox.crossTab ?? 'queue') === 'off') {
      void bootFromDisk(); // no single-writer lock — the app coordinates ownership
    } else {
      // crossTab:'queue' — hold an exclusive Web Lock on the key for this tab's lifetime, so a
      // second tab sharing the key WAITS (stays 'connecting') instead of restoring the same origin
      // and colliding on version mints. The lock auto-releases if the tab crashes.
      const locks = globalThis.navigator?.locks;
      if (!locks) {
        if (isDevMode()) {
          console.warn(
            '[@mmstack/mesh] outbox crossTab:"queue" needs the Web Locks API (navigator.locks), unavailable here — running WITHOUT a single-writer lock. Two tabs sharing this key can diverge; coordinate ownership yourself, or set crossTab:"off" to silence this.',
          );
        }
        void bootFromDisk();
      } else {
        const abort = new AbortController();
        cancelLock = () => abort.abort();
        void locks
          .request(
            `@mmstack/mesh:outbox:${opt.outbox.key}`,
            { mode: 'exclusive', signal: abort.signal },
            () => {
              cancelLock = undefined; // granted — no longer abortable, only releasable
              if (closed) return Promise.resolve();
              // hold the lock until teardown resolves this promise
              return new Promise<void>((release) => {
                releaseLock = release;
                void bootFromDisk();
              });
            },
          )
          .catch((e: unknown) => {
            // an aborted request is our own teardown; any other failure → degrade to no-lock
            if (!closed && (e as { name?: string })?.name !== 'AbortError') {
              void bootFromDisk();
            }
          });
      }
    }
  };

  // Assemble the local base first (worker hydration, disk snapshot), THEN connect, so the room
  // welcome rebases pending onto a populated store instead of racing it. A rejection is treated as
  // ready so a failed base load never wedges the connection.
  if (opt.whenReady) {
    void Promise.resolve()
      .then(() => opt.whenReady?.())
      .then(
        () => beginConnect(),
        () => beginConnect(),
      );
  } else {
    beginConnect();
  }

  return {
    status: status.asReadonly(),
    health,
    peers,
    setPresence: (data) => {
      presenceData = data;
      hasPresence = true;
      if (status() === 'live') {
        transport?.send({ t: 'presence', room: opt.room, data });
      }
    },
    close: () => {
      if (!closed) terminal('closed');
      unsubLocal();
      if (started) sync.destroy();
    },
  };
}
