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
import type {
  IceServer,
  OpPolicy,
  PresenceState,
  PrincipalCtx,
  ServerMsg,
} from '@mmstack/mesh-protocol';
import {
  forkStore,
  OP_PROTO_VERSION,
  opSync,
  registerResource,
  type AsyncStore,
  type DotFrontier,
  type ForkStoreOptions,
  type MergePolicyEntry,
  type OpEnvelope,
  type OpSync,
  type ResourceLike,
  type SyncedFork,
  type SyncOp,
  type WritableSignalStore,
  type Hlc,
} from '@mmstack/primitives/core';
import { meshSession, type MeshSession, type MeshStatus } from './session';
import type { MeshTransportFactory } from './transport';
import type { SignalingPort } from './peer-links';

export type { MeshStatus } from './session';

export type MeshPeer = PresenceState;

/**
 * A composed, user-facing health status for a synced store the surface that
 * turns a versioned reject from a dead socket into a speakable 'outdated' banner.
 */
export type SyncHealthStatus =
  'live' | 'waiting' | 'offline' | 'outdated' | 'ejected' | 'degraded';

export type SyncHealth = {
  readonly status: SyncHealthStatus;
  /** Why, when the status is `outdated`/`ejected`/`degraded`. */
  readonly reason?:
    'proto' | 'policy-version' | 'schema' | 'quota' | 'worker' | (string & {});
  /** `Date.now()` of the last successful sync (welcome or applied env). */
  readonly lastSyncedAt?: number;
  /**
   * Offline writes persisted by an older build that could not be restored on boot. Envelopes
   * from a previous wire-protocol version lack the citation metadata current merging needs,
   * so they are dropped (loudly) instead of being upgraded with fabricated citations.
   */
  readonly droppedOfflineWrites?: number;
  /**
   * Writes the relay refused on this session: they are not in the room. Each was handed to
   * `onRefused` with its values, and the store was rehydrated from a fresh snapshot after it.
   */
  readonly refusedWrites?: number;
  /**
   * Received envelopes rejected as malformed by the deterministic well-formedness check (a bad id
   * or path segment, a non-integer version, an unknown op kind, a negative epoch, forged cites, a
   * root delete). Direct peer-to-peer rooms are trust-full for authority, so this is a peer's line
   * against a malformed neighbor; through a relay these are also rejected at the relay.
   */
  readonly droppedInvalidEnvelopes?: number;
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
  /**
   * The room's shared configuration pin, checked at hello against the relay's. Bump it
   * together whenever anything peers must agree on changes: the write policy, and just as
   * importantly the merge/fold configuration (`policies`). Peers folding the same register
   * state with different rules read different values, so one room means one fold config; a
   * client pinned to an older version is rejected `policy-version` and surfaces `outdated`.
   */
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
  /** A write the relay refused (see `MeshSessionHooks.onRefused`); the envelope carries its values. */
  readonly onRefused?: (
    env: OpEnvelope,
    reason: 'generation' | 'schema' | 'order',
  ) => void;
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
   * The persisted outbox under `key` is a single-writer slot: every persist overwrites it whole, so
   * two tabs writing one key would each drop the other's tail from disk. A Web Lock on `key` elects
   * the one tab that restores from the slot and writes to it; origins are fresh on every boot either
   * way, so the lock guards the slot, not the origin. `crossTab` sets what a tab that did not get the
   * lock does: `'queue'` (default) waits (`status` reads `'waiting'`) and takes over when the owner
   * closes; `'ephemeral'` runs live at once and never touches the slot. `'off'` skips the lock and
   * leaves ownership to you (e.g. a per-tab key, or leader election over `tabSync`). A debounced
   * write means a hard crash within the debounce window can drop the very last mint — a small,
   * best-effort gap; tune it with `debounceMs`.
   */
  readonly outbox?: {
    readonly key: string;
    readonly store: AsyncStore;
    /** Coalesce outbox writes by this many ms (default 300; `0` = write on every change). */
    readonly debounceMs?: number;
    /**
     * Cross-tab contention for the shared `key`. The persisted outbox is a single-writer slot: the
     * Web Lock elects the one tab that restores from it and writes to it.
     * `'queue'` (default): a tab that did not get the lock WAITS (`status` reads `'waiting'`) and
     * takes over when the owner closes. `'ephemeral'`: it runs live at once on its own fresh origin
     * and never touches the slot — its unacknowledged writes live in memory only and are lost if that
     * tab terminates before the room acknowledges them — online or offline, and it stays ephemeral
     * for life, also after the owner leaves. When the lock is free both behave the same (take it,
     * restore, persist). `'off'` skips the lock (you coordinate ownership).
     */
    readonly crossTab?: 'queue' | 'off' | 'ephemeral';
  };
};

/** The shape persisted under `outbox.key`: the writing boot's origin, the emit high-water, and the tail. */
type PersistedOutbox = {
  /** The origin of the boot that wrote the slot; the next boot mints its own and resends the tail verbatim. */
  readonly origin: string;
  readonly version: number;
  readonly envs: readonly OpEnvelope[];
  /** The room generation the tail was written in; the first welcome decides whether it still holds. */
  readonly instance?: string;
  /** Emission epoch floors: a floor whose own sibling was collected has no other source on reload. */
  readonly floors?: readonly {
    readonly path: readonly (string | number)[];
    readonly epoch: number;
  }[];
  /** The last stamp minted: an acked, dropped tail still moved the clock. */
  readonly clock?: Hlc;
};

/**
 * The authority surface of a peer's op-sync, for callers that compose over a seat rather than
 * inside it: `override` for authority-bumped writes (`rebalanceContainer`, an owner's
 * authoritative commit), `captureFrontier` + `commitScope` for a commit that cites what was
 * observed earlier (a fork whose base is kept elsewhere), `liveUnder` / `liveAt` to read live
 * registers and `appliedFrontier` for the observation vector they are compared against (a
 * conflict projection: "did the writer see this sibling", answered by causality, never by order).
 * Deliberately narrow: no `receive`, `flush`, or `destroy` — those stay the seat's own.
 */
export type SeatSync<T = unknown> = Pick<
  OpSync<T>,
  | 'override'
  | 'captureFrontier'
  | 'commitScope'
  | 'liveUnder'
  | 'liveAt'
  | 'appliedFrontier'
>;

export type MeshSyncRef<T extends object = Record<string, unknown>> = {
  readonly status: Signal<MeshStatus>;
  /** Origin used by the current session's hello; null until hello, including while waiting on an outbox. */
  readonly origin: Signal<string | null>;
  /** Other relay members, including peers with no presence; empty before welcome and while disconnected. */
  readonly members: Signal<readonly string[]>;
  /** Peer signaling on this session's connection; buffers up to 256 early signals until the first listener. */
  readonly signaling: SignalingPort;
  /** Composed sync-health for a user-facing surface. */
  readonly health: Signal<SyncHealth>;
  /**
   * Every local write is acknowledged by the room. `false` while a write is still in the
   * unacknowledged tail, and it stays `false` once a session ends with writes outstanding —
   * those never landed, and no later echo can arrive to change that.
   */
  readonly acked: Signal<boolean>;
  /**
   * Resolves when the unacknowledged tail is empty (immediately if it already is), rejects
   * with the terminal reason if the session ends while writes are outstanding. The barrier
   * to await before publishing something that must contain every edit; `synced()` is a
   * connection indicator, not a save barrier.
   */
  whenAcked(): Promise<void>;
  readonly peers: Signal<readonly MeshPeer[]>;
  /** Publish this client's ephemeral presence payload (cursor, section, activity…). */
  setPresence(data: unknown): void;
  /**
   * Fork the synced store for isolated, reviewable edits (an agent branch, a staged change). The
   * fork observes the room as it is now; committing emits its diff citing only those observed
   * writes, so an edit that lands on the room while the fork is open stays a concurrent value the
   * merge policy decides rather than being overwritten by the commit. Call `rebase()` to re-observe
   * the room and commit on top of the latest instead. `discard()` drops the staged edits.
   */
  fork(
    opt?: ForkStoreOptions<T & Record<string, any>>,
  ): SyncedFork<T & Record<string, any>>;
  /** Authority surface over the CURRENT op-sync (it is rebuilt on restore); see {@link SeatSync}. */
  readonly sync: SeatSync<T>;
  close(): void;
};

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
): MeshSyncRef<T> {
  const injector = opt.injector ?? inject(Injector);
  const status = signal<MeshStatus>('connecting');
  const origin = signal<string | null>(null);
  const members = signal<readonly string[]>([]);
  let membership: readonly string[] | undefined;
  // the last roster the links on the port were given; a socket drop blanks the session's, not this
  let roster: readonly string[] = [];
  const signalingListeners = new Set<(msg: ServerMsg) => void>();
  let earlySignals: ServerMsg[] | null = [];
  // the ICE servers of the last welcome, for peer links that attach after it
  let welcomeIce: readonly IceServer[] | undefined;
  const deliverSignal = (
    cb: (msg: ServerMsg) => void,
    msg: ServerMsg,
  ): void => {
    try {
      cb(msg);
    } catch {
      // A failed peer link must never interrupt the room's sync session or other listeners.
    }
  };
  const signalMessage = (msg: ServerMsg): void => {
    if (msg.t === 'welcome') welcomeIce = msg.ice;
    if (msg.t === 'welcome' && earlySignals !== null) earlySignals = [];
    if (msg.t === 'member' && msg.gone && earlySignals !== null) {
      earlySignals = earlySignals.filter(
        (held) => held.t !== 'signal' || held.from !== msg.origin,
      );
    }
    if (
      msg.t === 'signal' &&
      earlySignals !== null &&
      earlySignals.length < 256
    ) {
      earlySignals.push(msg);
    }
    for (const cb of [...signalingListeners]) deliverSignal(cb, msg);
  };
  const lastReason = signal<string | undefined>(undefined);
  const lastSyncedAt = signal<number | undefined>(undefined);
  const droppedOffline = signal(0);
  const acked = signal(true); // nothing has been written yet
  const refused = signal(0);
  const droppedInvalid = signal(0);
  const peerMap = signal<ReadonlyMap<string, MeshPeer>>(new Map());
  const peers = computed(() => [...peerMap().values()]);
  const policyVersion = opt.policyVersion ?? 0;

  const health = computed<SyncHealth>(() => {
    const at = lastSyncedAt();
    const dropped = droppedOffline();
    const invalid = droppedInvalid();
    const extra = {
      ...(dropped > 0 ? { droppedOfflineWrites: dropped } : undefined),
      ...(refused() > 0 ? { refusedWrites: refused() } : undefined),
      ...(invalid > 0 ? { droppedInvalidEnvelopes: invalid } : undefined),
    };
    switch (status()) {
      case 'live':
        return { status: 'live', lastSyncedAt: at, ...extra };
      case 'waiting':
        return { status: 'waiting', lastSyncedAt: at, ...extra };
      case 'ejected': {
        const reason = lastReason();
        return reason && OUTDATED_REASONS.has(reason)
          ? { status: 'outdated', reason, lastSyncedAt: at, ...extra }
          : { status: 'ejected', reason, lastSyncedAt: at, ...extra };
      }
      default: // connecting / reconnecting / closed — not reachable
        return { status: 'offline', lastSyncedAt: at, ...extra };
    }
  });

  // Created lazily: with a persisted outbox the slot lock and the restored tail come first, so the
  // engine never mints before it knows the generation it is in
  let sync!: OpSync<T>;
  let session: MeshSession | undefined;
  let started = false;
  let closed = false;
  let pendingPresence: { data: unknown } | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPersist: Promise<void> | undefined;
  let releaseLock: (() => void) | undefined;
  let cancelLock: (() => void) | undefined;
  // this tab owns the persisted slot ('off', no Web Locks, or a granted lock); an ephemeral boot never does
  let durable = false;
  // the slot's clock high-water as restored: persisted back until this boot mints its own stamp
  let restoredClock: Hlc | undefined;

  // resolves when the store has the payload (a failed write resolves too: persistence is best-effort)
  const doPersist = (): Promise<void> => {
    if (closed || !opt.outbox || !started || !session || !durable)
      return Promise.resolve(); // ephemeral: never writes
    const instance = session.instance();
    const clock = sync.lastStamp() ?? restoredClock;
    const payload: PersistedOutbox = {
      origin: sync.origin,
      version: sync.watermark()[sync.origin] ?? 0,
      envs: session.unackedEnvs(),
      ...(instance ? { instance } : {}),
      floors: sync.floors(),
      ...(clock ? { clock } : {}),
    };
    const { store, key } = opt.outbox;
    // Capture before queueing: teardown clears the session's tail immediately after this call.
    const write = (): Promise<void> => {
      try {
        return Promise.resolve(store.set(key, payload)).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve(); // a failed save must not block later saves or lock release
      }
    };
    // Keep the idle path synchronous, but never let an older save land after a newer one.
    const pending = pendingPersist ? pendingPersist.then(write) : write();
    pendingPersist = pending;
    void pending.then(() => {
      if (pendingPersist === pending) pendingPersist = undefined;
    });
    return pending;
  };
  // coalesce outbox writes; `immediate` bypasses the debounce, but waits for earlier saves
  const persistOutbox = (immediate = false): Promise<void> => {
    if (!opt.outbox) return Promise.resolve();
    if (immediate) {
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      return doPersist();
    }
    if (persistTimer === undefined) {
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        void doPersist();
      }, opt.outbox.debounceMs ?? OUTBOX_DEBOUNCE_MS);
    }
    return Promise.resolve(); // the debounced path is not awaited
  };

  const dropLocks = (): void => {
    cancelLock?.(); // drop a still-queued lock request so we never steal it after teardown
    releaseLock?.(); // free a held lock for the next waiting tab
    cancelLock = releaseLock = undefined;
  };

  // Only a tail this boot could actually get admitted is worth resending: recorded under
  // this writer, on the current proto and policyVersion pins (the relay rejects a stale pin
  // per envelope, so restoring one would eject the boot, persist the tail intact, and brick
  // every boot after). Anything else drops loudly instead.
  const restorable = (env: OpEnvelope): boolean =>
    env.proto === OP_PROTO_VERSION &&
    env.writer === opt.writer &&
    env.policyVersion === policyVersion &&
    env.ops.every(
      (op) =>
        Array.isArray((op as SyncOp).cites) &&
        typeof (op as SyncOp).epoch === 'number',
    );

  const initCore = (restore?: PersistedOutbox): void => {
    if (closed) return;
    restoredClock = restore?.clock;
    sync = opSync(source, {
      writer: opt.writer,
      instance: restore?.instance,
      policies: opt.policies,
      policyVersion,
      injector,
      onReject: (_env, reason) => {
        droppedInvalid.update((n) => n + 1);
        if (isDevMode()) {
          console.warn(
            `[@mmstack/mesh] dropped malformed envelope from a peer (${reason})`,
          );
        }
      },
    });
    started = true;
    // set once this session ends: only then are the links riding on its port retired
    let ended = false;
    session = meshSession({
      room: opt.room,
      writer: opt.writer,
      transport: opt.transport,
      sync,
      policies: opt.policies,
      policy: opt.policy,
      ctx: opt.ctx,
      policyVersion,
      schemaVersion: opt.schemaVersion,
      instance: restore?.instance,
      reconnect: opt.reconnect,
      hooks: {
        onOrigin: (value) => origin.set(value),
        onMembers: (value) => {
          membership = value;
          members.set(value ?? []);
          if (value !== undefined) {
            roster = value;
            return;
          }
          if (earlySignals !== null) earlySignals = [];
          // Peer links outlive a socket drop: the next welcome re-lists who is still there. A
          // borrowed port has no close of its own, so the session's end retires them here, from
          // the last roster the links saw (a drop before the close already blanked the session's).
          if (!ended) return;
          const retired = roster;
          roster = [];
          for (const origin of retired) {
            signalMessage({ t: 'member', room: opt.room, origin, gone: true });
          }
        },
        onMessage: signalMessage,
        onRefused: (env, reason) => {
          refused.update((n) => n + 1);
          opt.onRefused?.(env, reason);
          if (isDevMode()) {
            console.warn(
              `[@mmstack/mesh] the relay refused a write (${reason}); it is not in the room and the store was rehydrated`,
            );
          }
        },
        onStatus: (s, reason) => {
          if (s === 'ejected' || s === 'closed') {
            closed = true;
            lastReason.set(reason);
          }
          status.set(s);
          if ((s === 'ejected' || s === 'closed') && reason !== undefined) {
            opt.onEject?.(reason);
          }
        },
        onSynced: () => lastSyncedAt.set(Date.now()),
        onPeers: (map) => peerMap.set(map),
        onOutboxChange: () => {
          void persistOutbox();
          acked.set(!session?.hasUnacked());
        },
        onTerminal: () => {
          ended = true;
          // latched: the tail is about to be dropped from the session, but it was never
          // acknowledged, so the answer to "is everything I wrote in the room" stays no
          if (session?.hasUnacked()) acked.set(false);
          // save the still-unacked tail for the next boot, and release the lock only once the store
          // has it: a successor granted earlier could restore the slot before this write lands
          let saved: Promise<void>;
          try {
            saved = persistOutbox(true);
          } catch {
            saved = Promise.resolve(); // a failed capture must still hand the slot on
          }
          void saved.finally(dropLocks);
        },
        onLocalReject: (violation) => {
          if (isDevMode()) {
            console.warn(
              '[@mmstack/mesh] local write violates the room policy — not sent',
              violation,
            );
          }
        },
      },
    });
    if (
      restore &&
      (restore.envs.length > 0 ||
        restore.version > 0 ||
        (restore.floors?.length ?? 0) > 0 ||
        restore.clock !== undefined)
    ) {
      const kept = restore.envs.filter(restorable);
      const dropped = restore.envs.length - kept.length;
      if (dropped > 0) {
        droppedOffline.set(dropped);
        if (isDevMode()) {
          console.warn(
            `[@mmstack/mesh] dropped ${dropped} persisted offline write(s) that cannot be resent: recorded under a different writer, or from an older protocol version (citations are never fabricated)`,
          );
        }
      }

      sync.restore(kept, restore.version, restore.floors, restore.clock); // → the session's subscribe repopulates its unacked tail for resend
    }
    void persistOutbox(true); // pin the freshly minted origin immediately, so a crash before any write is safe
    if (pendingPresence) {
      session.setPresence(pendingPresence.data);
      pendingPresence = undefined;
    }
    session.connect();
  };

  if (opt.register) {
    const connection: ResourceLike = {
      status: computed(() => {
        const s = status();
        return s === 'connecting' || s === 'waiting'
          ? 'loading'
          : s === 'reconnecting'
            ? 'reloading'
            : s === 'ejected'
              ? 'error'
              : 'resolved';
      }),
      isLoading: computed(
        () =>
          status() === 'connecting' ||
          status() === 'waiting' ||
          status() === 'reconnecting',
      ),
      hasValue: () => true,
    };
    runInInjectionContext(injector, () =>
      registerResource(connection, { suspends: opt.register === 'suspend' }),
    );
  }

  const teardown = (): void => {
    if (session) {
      session.close(); // no-op if already terminal; onTerminal handled locks + persist
    } else if (!closed) {
      // closed before the (async) boot ever created the session
      closed = true;
      dropLocks();
      status.set('closed');
    }
    if (started) sync.destroy();
  };

  injector.get(DestroyRef).onDestroy(teardown);

  // Load the persisted outbox, then boot with the adopted origin. A fresh/unreadable slot boots clean.
  const bootFromDisk = async (): Promise<void> => {
    durable = true; // every caller owns the slot
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
      const locks = globalThis.navigator?.locks;
      const mode = opt.outbox.crossTab ?? 'queue';
      if (!locks) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/mesh] outbox crossTab:"${mode}" needs the Web Locks API (navigator.locks), unavailable here — running WITHOUT a single-writer lock ('queue' and 'ephemeral' both own the slot). Two tabs sharing this key can diverge; coordinate ownership yourself, or set crossTab:"off" to silence this.`,
          );
        }
        void bootFromDisk();
        return;
      }
      const name = `@mmstack/mesh:outbox:${opt.outbox.key}`;
      // hold a granted lock until teardown resolves this promise
      const hold = (queued = false): Promise<void> => {
        cancelLock = undefined; // granted — no longer abortable, only releasable
        if (closed) return Promise.resolve();
        if (queued) status.set('connecting'); // the wait ends with the grant
        return new Promise<void>((release) => {
          releaseLock = release;
          void bootFromDisk();
        });
      };
      const queueUp = (): void => {
        status.set('waiting');
        const abort = new AbortController();
        cancelLock = () => abort.abort();
        void locks
          .request(name, { mode: 'exclusive', signal: abort.signal }, () =>
            hold(true),
          )
          .catch((e: unknown) => {
            // an aborted request is our own teardown; any other failure → degrade to no-lock
            if (
              !closed &&
              !started &&
              (e as { name?: string })?.name !== 'AbortError'
            ) {
              status.set('connecting'); // no longer waiting on anyone
              void bootFromDisk();
            }
          });
      };
      // Web Locks forbids `signal` together with `ifAvailable`, hence the probe first
      void locks
        .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (lock === null) {
            // another tab owns the slot
            if (closed) return Promise.resolve();
            if (mode === 'ephemeral') {
              initCore(); // live at once on a fresh origin; never reads or writes the slot
              return Promise.resolve();
            }
            queueUp();
            return Promise.resolve();
          }
          return hold();
        })
        .catch(() => {
          if (!closed && !started) void bootFromDisk(); // a broken lock manager degrades to no-lock
        });
    }
  };

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
    origin: origin.asReadonly(),
    members: members.asReadonly(),
    signaling: {
      members: () => membership,
      iceServers: () => welcomeIce,
      send: (msg) => session?.sendSignal(msg),
      onMessage: (cb) => {
        signalingListeners.add(cb);
        const held = earlySignals ?? [];
        earlySignals = null;
        for (const msg of held) deliverSignal(cb, msg);
        return () => signalingListeners.delete(cb);
      },
    },
    health,
    acked: acked.asReadonly(),
    whenAcked: () => (session ? session.whenAcked() : Promise.resolve()), // nothing written yet
    peers,
    setPresence: (data) => {
      if (session) session.setPresence(data);
      else pendingPresence = { data };
    },
    fork: (forkOpt) => {
      const f = forkStore(
        source as unknown as WritableSignalStore<T & Record<string, any>>,
        forkOpt,
      );

      let frontier: DotFrontier = started ? sync.captureFrontier() : { seq: 0 };
      const recapture = (): void => {
        frontier = started ? sync.captureFrontier() : { seq: 0 };
      };
      return {
        store: f.store,
        ops: f.ops,
        commit: () =>
          started ? sync.commitScope(frontier, () => f.commit()) : f.commit(),
        discard: () => {
          f.discard();
          recapture();
        },
        rebase: recapture,
      };
    },
    sync: {
      override: (fn) => (started ? sync.override(fn) : fn()),
      captureFrontier: () => (started ? sync.captureFrontier() : { seq: 0 }),
      commitScope: (frontier, fn) =>
        started ? sync.commitScope(frontier, fn) : fn(),
      liveUnder: (path) => (started ? sync.liveUnder(path) : []),
      liveAt: (path) => (started ? sync.liveAt(path) : []),
      appliedFrontier: () => (started ? sync.appliedFrontier() : {}),
    },
    close: teardown,
  };
}
