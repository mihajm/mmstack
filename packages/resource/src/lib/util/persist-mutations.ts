import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  type Injector,
  isDevMode,
  PLATFORM_ID,
  type Provider,
  type Signal,
  untracked,
} from '@angular/core';
import { mutable } from '@mmstack/primitives';
import {
  type CacheDB,
  createNoopDB,
  createSingleStoreDB,
} from './cache/persistence';

/**
 * Opt-in mutation persistence: queued/in-flight mutations survive an app close and replay
 * when a `mutationResource` with the same `key` is next instantiated (and online).
 *
 * Activation is at RESOURCE INSTANTIATION — the only point that preserves the lexical scope
 * of the configured hooks: `onMutate`/`onError`/`onSuccess` closures can't be serialized, so
 * replay happens where they exist. A stored mutation whose resource never instantiates stays
 * visible in {@link injectPendingMutations} but inert.
 *
 * CROSS-TAB: replay is arbitrated across tabs by a per-key `navigator.locks` exclusive
 * lock — one tab is the replayer; the others' stashed rows stay visible but untouched. When
 * the holding tab closes or crashes the lock releases (a Web Locks guarantee) and the next
 * claiming tab takes over: it re-syncs its in-memory mirror from the DB first, so rows the
 * previous holder settled don't re-send and rows it left behind do replay. Live tabs also
 * keep each other's `pending` mirrors current over a `BroadcastChannel` (stash/settle
 * events) — but a sibling-announced row is display-only until its owner is gone: replay
 * eligibility always comes from the lock + the disk re-sync, never from the broadcast.
 * Where Web Locks are unavailable (non-secure context, very old browsers) the claim falls
 * back to per-instance — the pre-lock behavior.
 *
 * KNOWN LIMITS:
 * - **At-least-once**: independent of tabs, a close between sending a replay and settling
 *   it re-sends on the next replay — replayed requests should be idempotent (e.g. an
 *   idempotency-key header derived from the stash).
 * - **Write window**: the IndexedDB write behind `mutate()` is asynchronous — an app closed
 *   within milliseconds of accepting a mutation can lose that stash.
 */
export type PersistMutationsOptions<TMutation, TICTX = void> = {
  /** Stable identity of this mutation KIND across sessions (e.g. `'user-update'`). */
  readonly key: string;
  /**
   * Convert a mutation (+ its initial context) into a storable value. Defaults to storing
   * both as-is — sufficient whenever they're structured-clone compatible.
   */
  readonly serialize?: (mutation: TMutation, ctx: TICTX | undefined) => unknown;
  /** Inverse of `serialize`. Defaults to the identity envelope. */
  readonly deserialize?: (raw: unknown) => {
    mutation: TMutation;
    ctx?: TICTX;
  };
  /** How long a stashed mutation stays replayable, in ms. Default: 7 days. */
  readonly ttl?: number;
  /**
   * Whether a mutation that settles with an ERROR keeps its stash for another replay attempt
   * (next instantiation / network regain / manual flush), instead of being dropped as settled
   * (the default). Pass a predicate to keep only transient failures — a permanently-failing
   * mutation kept unconditionally retries on every trigger until its `ttl` expires:
   *
   * ```ts
   * keepOnError: (err) => err instanceof HttpErrorResponse && err.status >= 500
   * ```
   */
  readonly keepOnError?:
    | boolean
    | ((error: unknown, meta: MutationErrorMeta) => boolean);
};

/** Passed to `onError` so a handler can distinguish a replayed-from-persistence failure. */
export type MutationErrorMeta = { readonly replayed: boolean };

/** One stashed mutation, as surfaced by {@link injectPendingMutations}. */
export type PendingMutation = {
  /** The persist key it belongs to. */
  readonly key: string;
  /** The serialized payload (output of the resource's `serialize`). */
  readonly raw: unknown;
  readonly created: number;
  /** Row identity — stable across sessions. */
  readonly id: string;
};

/** @internal The stored row payload (rides the cache DB row shape). */
type Envelope = {
  readonly persistKey: string;
  readonly seq: number;
  readonly raw: unknown;
  /**
   * The writing registry instance's id. Its liveness (probed via that instance's session
   * lock) decides whether a disk row is replayable or still owned by a living tab.
   * Absent on legacy rows → treated as ownerless (replayable).
   */
  readonly session?: string;
};

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/**
 * @internal DB seam — the default rides the same IndexedDB machinery as the query cache,
 * under its own database. Overridable for tests via {@link provideMockMutationPersistence}.
 */
export const MUTATION_PERSISTENCE_DB = new InjectionToken<
  Promise<CacheDB<Envelope>>
>(
  '@mmstack/resource:mutation-persistence-db',
  {
    providedIn: 'root',
    factory: () => {
      if (inject(PLATFORM_ID) === 'server')
        return Promise.resolve(createNoopDB<Envelope>());
      return createSingleStoreDB<Envelope>(
        'mmstack-mutation-queue-db',
        (version) => `mutations_v${version}`,
        1,
      );
    },
  },
);

/**
 * @internal Cross-tab lock seam — `navigator.locks` where available, `null` on the server
 * and in environments without Web Locks (the claim then degrades to per-instance).
 */
export const MUTATION_REPLAY_LOCKS = new InjectionToken<LockManager | null>(
  '@mmstack/resource:mutation-replay-locks',
  {
    providedIn: 'root',
    factory: () =>
      inject(PLATFORM_ID) === 'server'
        ? null
        : (globalThis.navigator?.locks ?? null),
  },
);

/** @internal The structural slice of {@link BroadcastChannel} the mirror sync needs. */
export type MutationSyncChannel = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

/**
 * @internal Cross-tab mirror-sync seam — a `BroadcastChannel` where available, `null` on
 * the server and in environments without it (sibling mirrors then stay hydration-stale,
 * which is display-only: replay correctness rides the lock + refresh, not the mirror).
 */
export const MUTATION_SYNC = new InjectionToken<MutationSyncChannel | null>(
  '@mmstack/resource:mutation-sync-channel',
  {
    providedIn: 'root',
    factory: () =>
      inject(PLATFORM_ID) === 'server' ||
      typeof globalThis.BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel('mmstack-mutation-queue-sync'),
  },
);

/**
 * An in-memory, deterministic mutation-persistence store for unit tests — no IndexedDB.
 * The returned `db` is inspectable; pass `seed` to simulate rows persisted by a previous
 * session (they hydrate on first use, exactly like real rows would).
 */
export function provideMockMutationPersistence(seed?: {
  rows?: { key: string; raw: unknown; created?: number; session?: string }[];
}): Provider {
  const map = new Map<string, Parameters<CacheDB<Envelope>['store']>[0]>();
  let seq = 0;
  for (const row of seed?.rows ?? []) {
    const created = row.created ?? Date.now();
    const id = `${row.key}#${++seq}`;
    map.set(id, {
      key: id,
      value: { persistKey: row.key, seq, raw: row.raw, session: row.session },
      created,
      updated: created,
      stale: created + SEVEN_DAYS,
      expiresAt: created + SEVEN_DAYS,
      useCount: 0,
      lastAccessed: created,
    });
  }
  const db: CacheDB<Envelope> = {
    getAll: async () =>
      Array.from(map.values()).filter((e) => e.expiresAt > Date.now()),
    store: async (entry) => {
      map.set(entry.key, entry);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
  return { provide: MUTATION_PERSISTENCE_DB, useValue: Promise.resolve(db) };
}

/**
 * @internal In-memory row: the envelope plus its row id + timestamps, tagged with where
 * this tab learned of it:
 * - `'local'` — created by THIS session's `enqueue`. Authoritative here: a re-sync must
 *   never drop one just because its async IDB write hasn't landed yet.
 * - `'disk'` — read from the DB with a dead (or unknown) owner. Replayable.
 * - `'broadcast'` — owned by a LIVING sibling tab (announced over the channel, or found
 *   on disk with a live session lock). Visible in `pending` (that's the point of the
 *   sync) but NOT replayable: its owner sends it through its own in-session queue —
 *   replaying it here would double-send. The owner's death (its session lock releasing)
 *   upgrades it to `'disk'`; the owner settling it removes it.
 */
type Row = PendingMutation & {
  readonly seq: number;
  readonly expiresAt: number;
  readonly origin: 'local' | 'disk' | 'broadcast';
  /** Session id of the row's writer, when known — the liveness/death-watch handle. */
  readonly owner?: string;
};

/** @internal Cross-tab mirror-sync message (rides the sibling {@link BroadcastChannel}). */
type SyncMessage =
  | {
      readonly type: 'mmstack-mutation-sync';
      readonly sender: string;
      readonly action: 'enqueue';
      readonly row: {
        readonly id: string;
        readonly key: string;
        readonly raw: unknown;
        readonly created: number;
        readonly seq: number;
        readonly expiresAt: number;
      };
    }
  | {
      readonly type: 'mmstack-mutation-sync';
      readonly sender: string;
      readonly action: 'remove';
      readonly id: string;
    };

const isSyncMessage = (msg: unknown): msg is SyncMessage =>
  typeof msg === 'object' &&
  msg !== null &&
  (msg as SyncMessage).type === 'mmstack-mutation-sync';

/**
 * @internal Each registry instance holds its session lock (exclusive) for its lifetime.
 * Siblings probe it (`ifAvailable`) to tell live-owned disk rows from orphaned ones, and
 * queue on it (`shared`) to learn of the owner's death the moment it happens.
 */
const sessionLockName = (id: string) => `mmstack-mutation-session:${id}`;

/**
 * @internal Root registry backing mutation persistence: the in-memory mirror of stashed
 * mutations (hydrated once from the DB), enqueue/remove plumbing, and the per-key replayer
 * claims. One per application, like the query cache.
 */
@Injectable({ providedIn: 'root' })
export class MutationPersistence {
  private readonly db = inject(MUTATION_PERSISTENCE_DB);
  private readonly locks = inject(MUTATION_REPLAY_LOCKS);
  private readonly sync = inject(MUTATION_SYNC);
  /** Distinguishes this instance's own sync messages (two instances can share a tab). */
  private readonly instanceId = Math.random().toString(36).slice(2);

  private readonly rows = mutable(new Map<string, Row>());
  /** Rows removed before hydration finished must not be resurrected by it. */
  private readonly tombstones = new Set<string>();
  /** Same guard for {@link refresh}: rows removed while a re-sync's `getAll` is in flight. */
  private readonly refreshTombstones = new Set<string>();
  private activeRefreshes = 0;
  private hydrated = false;
  private seqCounter = 0;

  private readonly replayers = new Map<string, () => void>();
  /** Keys whose cross-tab replay lock THIS tab currently holds. */
  private readonly heldLocks = new Set<string>();

  /** Aborts pending lock requests (session hold, death-watches) at instance teardown. */
  private readonly destroyed = new AbortController();
  private releaseSessionLock: (() => void) | undefined;
  private readonly watchedSessions = new Set<string>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed.abort();
      this.releaseSessionLock?.();
      this.sync?.close();
    });

    const channel = this.sync;
    if (channel) {
      channel.onmessage = (event) => {
        const msg: unknown = event.data;
        if (!isSyncMessage(msg) || msg.sender === this.instanceId) return;
        if (msg.action === 'enqueue')
          this.applyForeignEnqueue(msg.sender, msg.row);
        else this.applyForeignRemove(msg.id);
      };
    }

    // announce liveness: held until teardown, so siblings can classify our rows as
    // live-owned and be notified (via their shared death-watch) the moment we're gone
    if (this.locks) {
      this.locks
        .request(
          sessionLockName(this.instanceId),
          { mode: 'exclusive', signal: this.destroyed.signal },
          () =>
            new Promise<void>((resolve) => (this.releaseSessionLock = resolve)),
        )
        .catch(() => undefined);
    }
  }

  /** True when `session`'s owner still holds its lock — its rows are not ours to replay. */
  private isSessionLive(session: string): Promise<boolean> {
    const locks = this.locks;
    if (!locks) return Promise.resolve(false);
    return new Promise((resolve) =>
      locks
        .request(
          sessionLockName(session),
          { mode: 'shared', ifAvailable: true },
          // shared join refused → the owner's exclusive hold is still up → alive
          async (lock) => resolve(lock === null),
        )
        .catch(() => resolve(false)),
    );
  }

  /** Live sessions among the writers of `entries` (probed once per unique session). */
  private async probeSessions(
    entries: readonly { value: Envelope }[],
  ): Promise<ReadonlySet<string>> {
    const alive = new Set<string>();
    if (!this.locks) return alive;
    const sessions = new Set<string>();
    for (const e of entries) {
      const s = e.value.session;
      if (s && s !== this.instanceId) sessions.add(s);
    }
    await Promise.all(
      Array.from(sessions, async (s) => {
        if (await this.isSessionLive(s)) alive.add(s);
      }),
    );
    return alive;
  }

  /**
   * Queue on a living sibling's session lock in shared mode: the grant arrives exactly
   * when the owner dies (and to every watcher at once — shared grants coexist), turning
   * Web Locks into a cross-tab death notification. Death makes that session's rows
   * replayable and pokes the affected replayers (each still gated by its key lock).
   */
  private watchSession(session: string): void {
    if (!this.locks || session === this.instanceId) return;
    if (this.watchedSessions.has(session)) return;
    this.watchedSessions.add(session);
    this.locks
      .request(
        sessionLockName(session),
        { mode: 'shared', signal: this.destroyed.signal },
        async () => this.onSessionDead(session),
      )
      .catch(() => undefined);
  }

  private onSessionDead(session: string): void {
    const keys = new Set<string>();
    untracked(() =>
      this.rows.inline((map) => {
        for (const [id, row] of map) {
          if (row.owner !== session || row.origin !== 'broadcast') continue;
          map.set(id, { ...row, origin: 'disk' });
          keys.add(row.key);
        }
      }),
    );
    for (const key of keys) this.replayers.get(key)?.();
  }

  /**
   * A sibling tab stashed a row: mirror it as `'broadcast'` — visible in {@link pending},
   * excluded from replay while its owner lives (see the {@link Row} origin contract).
   */
  private applyForeignEnqueue(
    sender: string,
    row: Extract<SyncMessage, { action: 'enqueue' }>['row'],
  ): void {
    this.watchSession(sender);
    untracked(() =>
      this.rows.inline((map) => {
        if (map.has(row.id) || this.tombstones.has(row.id)) return;
        map.set(row.id, {
          id: row.id,
          key: row.key,
          raw: row.raw,
          created: row.created,
          seq: row.seq,
          expiresAt: row.expiresAt,
          origin: 'broadcast',
          owner: sender,
        });
        this.seqCounter = Math.max(this.seqCounter, row.seq);
      }),
    );
  }

  /**
   * A sibling tab settled/dropped a row: mirror the delete only — the sender owns the DB
   * write. Same anti-resurrection guards as {@link remove}.
   */
  private applyForeignRemove(id: string): void {
    if (!this.hydrated) this.tombstones.add(id);
    if (this.activeRefreshes > 0) this.refreshTombstones.add(id);
    untracked(() => this.rows.inline((map) => map.delete(id)));
  }

  /** Resolves once persisted rows from previous sessions are visible. */
  readonly whenHydrated: Promise<void> = this.db
    .then((db) => db.getAll())
    .then(async (entries) => {
      // rows written by a still-living tab are ITS to send — mirror them held-back
      const liveSessions = await this.probeSessions(entries);
      untracked(() =>
        this.rows.inline((map) => {
          for (const entry of entries) {
            if (map.has(entry.key) || this.tombstones.has(entry.key)) continue;
            const owner = entry.value.session;
            const ownerLive = owner !== undefined && liveSessions.has(owner);
            if (ownerLive) this.watchSession(owner);
            map.set(entry.key, {
              id: entry.key,
              key: entry.value.persistKey,
              raw: entry.value.raw,
              created: entry.created,
              seq: entry.value.seq,
              expiresAt: entry.expiresAt,
              origin: ownerLive ? 'broadcast' : 'disk',
              owner,
            });
            this.seqCounter = Math.max(this.seqCounter, entry.value.seq);
          }
        }),
      );
      this.hydrated = true;
      this.tombstones.clear();
    });

  /** All stashed mutations, across every key — including keys with no live resource. */
  readonly pending: Signal<readonly PendingMutation[]> = computed(() =>
    Array.from(this.rows().values())
      .toSorted((a, b) => a.seq - b.seq)
      .map(({ id, key, raw, created }) => ({ id, key, raw, created })),
  );

  /** Stash a mutation. Synchronous in memory; the IDB write follows. */
  enqueue(key: string, raw: unknown, ttl = SEVEN_DAYS): string {
    const seq = ++this.seqCounter;
    const now = Date.now();
    const id = `${key}#${now}:${seq}`;
    const row: Row = {
      id,
      key,
      raw,
      created: now,
      seq,
      expiresAt: now + ttl,
      origin: 'local',
    };
    untracked(() => this.rows.inline((map) => map.set(id, row)));
    this.db.then((db) =>
      db.store({
        key: id,
        value: { persistKey: key, seq, raw, session: this.instanceId },
        created: now,
        updated: now,
        stale: row.expiresAt,
        expiresAt: row.expiresAt,
        useCount: 0,
        lastAccessed: now,
      }),
    );
    this.sync?.postMessage({
      type: 'mmstack-mutation-sync',
      sender: this.instanceId,
      action: 'enqueue',
      row: { id, key, raw, created: now, seq, expiresAt: row.expiresAt },
    } satisfies SyncMessage);
    return id;
  }

  /** Drop a stashed mutation (it settled, was superseded, or was explicitly cleared). */
  remove(id: string): void {
    if (!this.hydrated) this.tombstones.add(id);
    if (this.activeRefreshes > 0) this.refreshTombstones.add(id);
    untracked(() => this.rows.inline((map) => map.delete(id)));
    this.db.then((db) => db.remove(id));
    this.sync?.postMessage({
      type: 'mmstack-mutation-sync',
      sender: this.instanceId,
      action: 'remove',
      id,
    } satisfies SyncMessage);
  }

  /**
   * @internal Re-sync the in-memory mirror for one key from the DB — run when this tab is
   * granted the cross-tab replay lock, possibly long after its own hydration: the previous
   * holder may have settled rows (drop them — they must not re-send) or stashed new ones
   * before dying (add them — they must replay). Rows created by this session's `enqueue`
   * are authoritative locally and never dropped (their IDB write may still be in flight).
   * Sibling-owned (`'broadcast'`) rows are their owner's business either way: the owner's
   * remove message drops them, the owner's death (watched session lock) upgrades them —
   * a re-sync neither deletes nor promotes them, and disk rows whose writer still lives
   * enter held-back, exactly like hydration.
   */
  async refresh(key: string): Promise<void> {
    this.activeRefreshes++;
    try {
      await this.whenHydrated;
      const db = await this.db;
      const entries = (await db.getAll()).filter(
        (e) => e.value.persistKey === key,
      );
      const liveSessions = await this.probeSessions(entries);
      const disk = new Map(entries.map((e) => [e.key, e]));
      untracked(() =>
        this.rows.inline((map) => {
          for (const [id, row] of Array.from(map)) {
            if (row.key !== key || row.origin !== 'disk') continue;
            if (!disk.has(id)) map.delete(id);
          }
          for (const entry of disk.values()) {
            if (map.has(entry.key) || this.refreshTombstones.has(entry.key))
              continue;
            const owner = entry.value.session;
            const ownerLive = owner !== undefined && liveSessions.has(owner);
            if (ownerLive) this.watchSession(owner);
            map.set(entry.key, {
              id: entry.key,
              key,
              raw: entry.value.raw,
              created: entry.created,
              seq: entry.value.seq,
              expiresAt: entry.expiresAt,
              origin: ownerLive ? 'broadcast' : 'disk',
              owner,
            });
            this.seqCounter = Math.max(this.seqCounter, entry.value.seq);
          }
        }),
      );
    } finally {
      if (--this.activeRefreshes === 0) this.refreshTombstones.clear();
    }
  }

  /**
   * REPLAYABLE stashed rows for one key, replay order (oldest first). Read after
   * `whenHydrated`. Rows a living sibling tab announced (`'broadcast'` origin) are
   * excluded — their owner sends them itself; they join the feed only after a takeover
   * {@link refresh} finds them on disk.
   */
  rowsFor(key: string): PendingMutation[] {
    return Array.from(untracked(this.rows).values())
      .filter((r) => r.key === key && r.origin !== 'broadcast')
      .toSorted((a, b) => a.seq - b.seq)
      .map(({ id, key: k, raw, created }) => ({ id, key: k, raw, created }));
  }

  /**
   * Claim the replayer role for a key — the ONE live resource instance that replays its
   * stashed rows. A second concurrent claim IN THIS TAB is refused (dev warn): replaying
   * the same rows through two resources would double-send. Across tabs the claim is
   * arbitrated by {@link acquireReplayLock}; claiming also schedules the initial replay
   * (once hydrated and, where Web Locks exist, once the lock is granted).
   */
  claim(key: string, replay: () => void): (() => void) | null {
    if (this.replayers.has(key)) {
      if (isDevMode())
        console.warn(
          `[@mmstack/resource] multiple live mutationResources persist under key '${key}' — only the first replays stashed mutations. Give each resource its own key.`,
        );
      return null;
    }
    this.replayers.set(key, replay);
    const releaseLock = this.acquireReplayLock(key, replay);
    return () => {
      if (this.replayers.get(key) !== replay) return;
      this.replayers.delete(key);
      releaseLock();
    };
  }

  /** True while THIS tab may replay stashed rows for `key` — replays elsewhere must no-op. */
  holdsReplayLock(key: string): boolean {
    return this.heldLocks.has(key);
  }

  /**
   * Acquire the cross-tab exclusive replay lock for `key`. The grant may be immediate (no
   * other tab holds it) or arrive much later — a holding tab closed or crashed and Web
   * Locks released it, which is exactly the takeover story. On grant the mirror is
   * {@link refresh}ed from the DB before anything replays. Without a lock API the claim
   * degrades to per-instance: held immediately, replay scheduled after hydration.
   */
  private acquireReplayLock(key: string, replay: () => void): () => void {
    const invokeIfCurrent = () => {
      if (this.replayers.get(key) === replay) replay();
    };

    if (!this.locks) {
      this.heldLocks.add(key);
      this.whenHydrated.then(invokeIfCurrent);
      return () => this.heldLocks.delete(key);
    }

    const controller = new AbortController();
    let releaseHold: (() => void) | undefined;
    let released = false;
    this.locks
      .request(
        `mmstack-mutation-replay:${key}`,
        { mode: 'exclusive', signal: controller.signal },
        async () => {
          if (released) return;
          await this.refresh(key);
          if (released) return;
          this.heldLocks.add(key);
          invokeIfCurrent();
          // hold the lock until release — its lifetime IS the claim's lifetime
          await new Promise<void>((resolve) => {
            releaseHold = resolve;
            if (released) resolve();
          });
        },
      )
      .catch(() => undefined); // released while still queued → AbortError, expected
    return () => {
      released = true;
      this.heldLocks.delete(key);
      controller.abort();
      releaseHold?.();
    };
  }

  /**
   * Ask the claiming resource(s) to replay now — e.g. from a "sync 3 pending changes"
   * button. No-ops for keys with no live resource or nothing stashed; replayers themselves
   * skip when offline or when ANOTHER TAB holds the replay lock (that tab's own triggers
   * cover the rows).
   */
  flush(key?: string): void {
    if (key !== undefined) {
      this.replayers.get(key)?.();
      return;
    }
    for (const replay of this.replayers.values()) replay();
  }
}

export function injectMutationPersistence(
  injector?: Injector,
): MutationPersistence {
  return injector
    ? injector.get(MutationPersistence)
    : inject(MutationPersistence);
}

/**
 * The global pending-mutations surface: every stashed (persisted, not-yet-settled) mutation
 * across the app, as a live signal — for "3 changes waiting to sync" UX. The count stays
 * current across OTHER TABS too (stash/settle events sync over a `BroadcastChannel`).
 * Entries whose resource hasn't instantiated yet are visible but inert (nothing replays
 * them until a `mutationResource` with that `persist.key` exists). Use the returned
 * `flush` to force a replay attempt (e.g. a manual "sync now" button); it no-ops while
 * offline and in tabs that don't hold the cross-tab replay lock.
 */
export function injectPendingMutations(injector?: Injector): {
  readonly entries: Signal<readonly PendingMutation[]>;
  readonly count: Signal<number>;
  flush(key?: string): void;
} {
  const persistence = injectMutationPersistence(injector);
  return {
    entries: persistence.pending,
    count: computed(() => persistence.pending().length),
    flush: (key?: string) => persistence.flush(key),
  };
}
