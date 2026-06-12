import { HttpHeaders, HttpResponse } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  PLATFORM_ID,
  type Provider,
  signal,
  type Signal,
  untracked,
} from '@angular/core';
import { mutable } from '@mmstack/primitives';
import { CacheDB, createNoopDB, createSingleStoreDB } from './persistence';

function generateID() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2);
}

type BaseSyncMessage<TEntry, TAction extends string> = {
  entry: TEntry;
  action: TAction;
};

type InvalidateMessage<T> = BaseSyncMessage<
  Pick<CacheEntry<T>, 'key'>,
  'invalidate'
>;

type StoreMessage<T> = BaseSyncMessage<Omit<CacheEntry<T>, 'timeout'>, 'store'>;

type InternalSyncMessage<T> = InvalidateMessage<T> | StoreMessage<T>;

/**
 * A message type used for synchronizing cache updates across tabs.
 * @internal
 * @template T - The type of data being cached.
 */
type SyncMessage<T> = InternalSyncMessage<T> & {
  cacheId: string;
  type: 'cache-sync-message';
};

function isSyncMessage<T>(msg: unknown): msg is SyncMessage<T> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as SyncMessage<T>).type === 'cache-sync-message'
  );
}

/**
 * Options for configuring the Least Recently Used (LRU) cache cleanup strategy.
 * @internal
 */
type LRUCleanupType = {
  type: 'lru';
  /**
   * How often to check for expired or excess entries, in milliseconds.
   */
  checkInterval: number;
  /**
   * The maximum number of entries to keep in the cache.  When the cache exceeds this size,
   * the least recently used entries will be removed.
   */
  maxSize: number;
};

/**
 * Options for configuring the "oldest first" cache cleanup strategy.
 * @internal
 */
type OldsetCleanupType = {
  type: 'oldest';
  /**
   * How often to check for expired or excess entries, in milliseconds.
   */
  checkInterval: number;
  /**
   * The maximum number of entries to keep in the cache.  When the cache exceeds this size,
   * the oldest entries will be removed.
   */
  maxSize: number;
};

/**
 * Represents an entry in the cache.
 * @internal
 */
export type CacheEntry<T> = {
  value: T;
  created: number;
  updated: number;
  stale: number;
  useCount: number;
  /** Timestamp of the last read/write — drives LRU eviction. */
  lastAccessed: number;
  expiresAt: number;
  /** Absent for non-finite/over-int32 TTLs — those rely on lazy expiry instead. */
  timeout?: ReturnType<typeof setTimeout>;
  key: string;
};

/**
 * setTimeout coerces its delay through a signed 32-bit conversion: `Infinity` becomes 0
 * (immediate!) and anything above 2^31-1 ms (~24.8 days) wraps negative. Entries beyond
 * this bound get NO timer and rely on lazy expiry (`expiresAt <= now` checks) plus the
 * periodic sweep instead.
 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Defines the types of cleanup strategies available for the cache.
 * - `lru`: Least Recently Used.  Removes the least recently accessed entries when the cache is full.
 * - `oldest`: Removes the oldest entries when the cache is full.
 */
export type CleanupType = LRUCleanupType | OldsetCleanupType;

const ONE_DAY = 1000 * 60 * 60 * 24;
const ONE_HOUR = 1000 * 60 * 60;

const DEFAULT_CLEANUP_OPT = {
  type: 'lru',
  maxSize: 200,
  checkInterval: ONE_HOUR,
} satisfies LRUCleanupType;

/**
 * A generic cache implementation that stores data with time-to-live (TTL) and stale-while-revalidate capabilities.
 *
 * @typeParam T - The type of data to be stored in the cache.
 */
export class Cache<T> {
  private readonly internal = mutable(new Map<string, CacheEntry<T>>());
  private readonly cleanupOpt: CleanupType;
  private readonly id = generateID();
  /** True once async hydration from the persistence layer has completed (or was empty). */
  private hydrated = false;
  /** Keys invalidated while hydration was still in flight — must not be resurrected by it. */
  private readonly hydrationTombstones = new Set<string>();

  private readonly hitCount = signal(0);
  private readonly missCount = signal(0);

  /**
   * Read-only cache statistics for debugging/observability — entry count plus
   * request-level hit/miss counters (counted on direct lookups, e.g. the cache
   * interceptor's, not on every reactive signal read). Render it in a debug
   * panel; it intentionally exposes no way to mutate the cache.
   */
  readonly stats: Signal<{ size: number; hits: number; misses: number }> =
    computed(() => ({
      size: this.internal().size,
      hits: this.hitCount(),
      misses: this.missCount(),
    }));

  /**
   * Destroys the cache instance, clearing the cleanup interval and closing the
   * cross-tab channel. Called automatically when the providing injector is destroyed
   * (wired up by `provideQueryCache`); call it manually for caches you construct yourself.
   */
  readonly destroy: () => void;

  private readonly broadcast: (msg: InternalSyncMessage<T>) => void = () => {
    // noop
  };

  /**
   * Creates a new `Cache` instance.
   *
   * @param ttl - The default Time To Live (TTL) for cache entries, in milliseconds.  Defaults to one day.
   * @param staleTime - The default duration, in milliseconds, during which a cache entry is considered
   *                    stale but can still be used while revalidation occurs in the background. Defaults to 1 hour.
   * @param cleanupOpt - Options for configuring the cache cleanup strategy.  Defaults to LRU with a
   *                     `maxSize` of 200 and a `checkInterval` of one hour.
   * @param syncTabs - If provided, the cache will use the options a BroadcastChannel to send updates between tabs.
   *                   Defaults to `undefined`, meaning no synchronization across tabs.
   */
  constructor(
    protected readonly ttl: number = ONE_DAY,
    protected readonly staleTime: number = ONE_HOUR,
    cleanupOpt: Partial<CleanupType> = DEFAULT_CLEANUP_OPT,
    syncTabs?: {
      id: string;
      serialize: (value: T) => string;
      deserialize: (value: string) => T | null;
    },

    private readonly db: Promise<CacheDB<T>> = Promise.resolve(
      createNoopDB<T>(),
    ),
  ) {
    this.cleanupOpt = {
      ...DEFAULT_CLEANUP_OPT,
      ...cleanupOpt,
    };

    if (this.cleanupOpt.maxSize <= 0)
      throw new Error('maxSize must be greater than 0');

    // a non-finite checkInterval disables the sweeper entirely (used by the shared NoopCache)
    const cleanupInterval = Number.isFinite(this.cleanupOpt.checkInterval)
      ? setInterval(() => {
          this.cleanup();
        }, this.cleanupOpt.checkInterval)
      : undefined;

    let destroySyncTabs = () => {
      // noop
    };

    if (syncTabs) {
      const channel = new BroadcastChannel(syncTabs.id);
      this.broadcast = (msg: InternalSyncMessage<T>) => {
        if (msg.action === 'invalidate')
          return channel.postMessage({
            action: 'invalidate',
            entry: { key: msg.entry.key },
            cacheId: this.id,
            type: 'cache-sync-message',
          } satisfies SyncMessage<string>);

        return channel.postMessage({
          ...msg,
          entry: {
            ...msg.entry,
            value: syncTabs.serialize(msg.entry.value),
          },
          cacheId: this.id,
          type: 'cache-sync-message',
        } satisfies SyncMessage<string>);
      };

      channel.onmessage = (event) => {
        const msg = event.data;
        if (!isSyncMessage<string>(msg)) return;
        if (msg.cacheId === this.id) return; // ignore messages from this cache

        if (msg.action === 'store') {
          const value = syncTabs.deserialize(msg.entry.value);
          if (value === null) return;

          // Last-write-wins by `updated` timestamp.
          const existing = untracked(this.internal).get(msg.entry.key);
          if (existing && existing.updated >= msg.entry.updated) return;

          this.restoreInternal({ ...msg.entry, value });
        } else if (msg.action === 'invalidate') {
          this.invalidateInternal(msg.entry.key, true);
        }
      };

      destroySyncTabs = () => {
        channel.close();
      };
    }

    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      if (cleanupInterval !== undefined) clearInterval(cleanupInterval);
      destroySyncTabs();
    };

    this.db
      .then(async (db) => {
        if (destroyed) return [];
        return db.getAll();
      })
      .then((entries) => {
        if (destroyed) return;
        const current = untracked(this.internal);
        entries.forEach((entry) => {
          if (current.has(entry.key)) return;
          // a key invalidated while hydration was in flight must stay dead
          if (this.hydrationTombstones.has(entry.key)) return;
          this.restoreInternal(entry);
        });
        this.hydrated = true;
        this.hydrationTombstones.clear();
      });

    this.destroy = destroy;
  }

  /** @internal */
  private getInternal(
    key: () => string | null,
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | null> {
    const keySignal = computed(() => key());

    return computed(
      () => {
        const key = keySignal();
        if (!key) return null;
        const found = this.internal().get(key);

        const now = Date.now();

        if (!found || found.expiresAt <= now) return null;
        return {
          ...found,
          isStale: found.stale <= now,
        };
      },
      {
        equal: (a, b) =>
          a === b ||
          (!!a &&
            !!b &&
            a.key === b.key &&
            a.value === b.value &&
            a.updated === b.updated &&
            a.isStale === b.isStale),
      },
    );
  }

  /** @internal Imperative access bookkeeping for LRU eviction. */
  private touch(entry: CacheEntry<T>) {
    entry.lastAccessed = Date.now();
    entry.useCount++;
  }

  /**
   * Retrieves a cache entry directly (non-reactively), updating its access bookkeeping
   * for LRU eviction.
   * @internal
   * @param key - The key of the entry to retrieve.
   * @returns The cache entry, or `null` if not found or expired.
   */
  getUntracked(key: string): (CacheEntry<T> & { isStale: boolean }) | null {
    const found = untracked(this.internal).get(key);
    const now = Date.now();
    if (!found || found.expiresAt <= now) {
      this.missCount.update((c) => c + 1);
      return null;
    }
    this.touch(found);
    this.hitCount.update((c) => c + 1);
    return {
      ...found,
      isStale: found.stale <= now,
    };
  }

  /**
   * Retrieves a cache entry as a signal.
   *
   * @param key - A function that returns the cache key. The key is a signal, allowing for dynamic keys. If the function returns null the value is also null.
   * @returns A signal that holds the cache entry, or `null` if not found or expired.  The signal
   *          updates whenever the cache entry changes (e.g., due to revalidation or expiration).
   */
  get(
    key: () => string | null,
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | null> {
    return this.getInternal(key);
  }

  /**
   * Retrieves a cache entry or an object with the key if not found.
   *
   * @param key - A function that returns the cache key. The key is a signal, allowing for dynamic keys. If the function returns null the value is also null.
   * @returns  A signal that holds the cache entry or an object with the key if not found. The signal
   *          updates whenever the cache entry changes (e.g., due to revalidation or expiration).
   */
  getEntryOrKey(
    key: () => string | null,
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | string | null> {
    const valueSig = this.getInternal(key);
    return computed(() => valueSig() ?? key());
  }

  /**
   * Stores a value in the cache.
   *
   * NOTE: cached values are shared by reference across all consumers (current and
   * future cache hits, persistence, cross-tab sync) — do not mutate a value after
   * storing it or after reading it from the cache.
   *
   * @param key - The key under which to store the value.
   * @param value - The value to store.
   * @param staleTime - (Optional) The stale time for this entry, in milliseconds. Overrides the default `staleTime`.
   * @param ttl - (Optional) The TTL for this entry, in milliseconds. Overrides the default `ttl`.
   * @param persist - (Optional) Whether to also write the entry to the persistence layer (IndexedDB). Defaults to `false`.
   */
  store(
    key: string,
    value: T,
    staleTime = this.staleTime,
    ttl = this.ttl,
    persist = false,
  ) {
    this.storeInternal(key, value, staleTime, ttl, false, persist);
  }

  private storeInternal(
    key: string,
    value: T,
    staleTime = this.staleTime,
    ttl = this.ttl,
    fromSync = false,
    persist = false,
  ) {
    const entry = untracked(this.internal).get(key);

    // ttl cannot be less than staleTime
    if (ttl < staleTime) staleTime = ttl;

    const now = Date.now();

    this.setEntry(
      {
        value,
        created: entry?.created ?? now,
        updated: now,
        useCount: (entry?.useCount ?? 0) + 1,
        lastAccessed: now,
        stale: now + staleTime,
        expiresAt: now + ttl,
        key,
      },
      fromSync,
      persist,
    );
  }

  /**
   * @internal
   * Inserts an entry that already carries ABSOLUTE timestamps — hydration from the
   * persistence layer and cross-tab sync messages. Never re-anchors freshness to
   * `Date.now()`, never persists, never broadcasts.
   */
  private restoreInternal(
    entry: Omit<CacheEntry<T>, 'timeout' | 'lastAccessed'> &
      Partial<Pick<CacheEntry<T>, 'lastAccessed'>>,
  ) {
    this.setEntry(
      {
        ...entry,
        // rows persisted by older versions may lack the field
        lastAccessed: entry.lastAccessed ?? entry.updated,
      },
      true,
      false,
    );
  }

  /** @internal Shared writer: arms the expiry timer only within the safe delay range. */
  private setEntry(
    next: Omit<CacheEntry<T>, 'timeout'>,
    fromSync: boolean,
    persist: boolean,
  ) {
    const existing = untracked(this.internal).get(next.key);
    if (existing) clearTimeout(existing.timeout); // stop the previous invalidation

    const remaining = next.expiresAt - Date.now();
    // already expired (clock skew on a synced/restored entry) — don't insert
    if (remaining <= 0) return;

    // Infinity (immutable) or > 2^31-1 would coerce to an IMMEDIATE timeout — such
    // entries get no timer and rely on lazy expiry + the periodic sweep instead
    const timeout =
      Number.isFinite(remaining) && remaining <= MAX_TIMER_DELAY
        ? setTimeout(() => this.invalidate(next.key), remaining)
        : undefined;

    this.internal.mutate((map) => {
      map.set(next.key, { ...next, timeout });
      return map;
    });

    if (!fromSync) {
      if (persist) this.db.then((db) => db.store(next));

      this.broadcast({
        action: 'store',
        entry: next,
      });
    }
  }

  /**
   * Invalidates (removes) a cache entry.
   *
   * @param key - The key of the entry to invalidate.
   */
  invalidate(key: string) {
    this.invalidateInternal(key);
  }

  /**
   * Invalidates every cache entry whose key starts with `prefix`. Common after a
   * list-mutating operation (e.g. invalidate every paginated `GET /api/posts*`
   * after a POST). Returns the number of entries removed.
   *
   * @example
   * cache.invalidatePrefix('GET https://api.example.com/posts');
   */
  invalidatePrefix(prefix: string): number {
    return this.invalidateWhere((key) => key.startsWith(prefix));
  }

  /**
   * Invalidates every cache entry whose key matches the predicate. Use for
   * arbitrary bulk invalidation that doesn't fit prefix matching (e.g.
   * "everything containing `userId=42`"). Returns the number of entries removed.
   *
   * @example
   * cache.invalidateWhere((key) => key.includes('/me/'));
   */
  invalidateWhere(predicate: (key: string) => boolean): number {
    const keys = Array.from(untracked(this.internal).keys()).filter(predicate);
    for (const key of keys) this.invalidateInternal(key);
    return keys.length;
  }

  private invalidateInternal(key: string, fromSync = false) {
    // a key invalidated before async hydration completes must not be resurrected by it
    if (!this.hydrated) this.hydrationTombstones.add(key);

    const entry = untracked(this.internal).get(key);
    if (entry) {
      clearTimeout(entry.timeout);
      this.internal.mutate((map) => {
        map.delete(key);
        return map;
      });
    }
    if (!fromSync) {
      this.db.then((db) => db.remove(key));
      this.broadcast({ action: 'invalidate', entry: { key } });
    }
  }

  /**
   * Removes EVERY entry — memory, persisted rows, and (via broadcast) other tabs.
   * Call on logout/auth changes so no prior user's responses survive.
   */
  clear() {
    for (const key of Array.from(untracked(this.internal).keys())) {
      this.invalidateInternal(key);
    }
  }

  /** @internal Drops expired entries, then enforces `maxSize` by the configured strategy. */
  private cleanup() {
    const now = Date.now();

    // expired entries first — their timers may never have fired (throttled background
    // tabs, or timer-less long-TTL entries)
    const expired = Array.from(untracked(this.internal).entries()).filter(
      ([, e]) => e.expiresAt <= now,
    );
    if (expired.length) {
      expired.forEach(([, e]) => clearTimeout(e.timeout));
      this.internal.mutate((map) => {
        expired.forEach(([key]) => map.delete(key));
        return map;
      });
    }

    if (untracked(this.internal).size <= this.cleanupOpt.maxSize) return;

    const sorted = Array.from(untracked(this.internal).entries()).toSorted(
      (a, b) => {
        if (this.cleanupOpt.type === 'lru') {
          return a[1].lastAccessed - b[1].lastAccessed; // least recently accessed first
        } else {
          return a[1].created - b[1].created; // oldest first
        }
      },
    );

    const keepCount = Math.max(1, Math.floor(this.cleanupOpt.maxSize / 2));

    const removed = sorted.slice(0, sorted.length - keepCount);
    const keep = sorted.slice(removed.length, sorted.length);

    removed.forEach(([, e]) => {
      clearTimeout(e.timeout);
    });

    this.internal.set(new Map(keep));
  }
}

/**
 * Options for configuring the cache.
 */
type CacheOptions = {
  /**
   * The default Time To Live (TTL) for cache entries, in milliseconds.
   */
  ttl?: number;
  /**
   * The default duration, in milliseconds, during which a cache entry is considered
   * stale but can still be used while revalidation occurs in the background.
   */
  staleTime?: number;
  /**
   * Options for configuring the cache cleanup strategy.
   */
  cleanup?: Partial<CleanupType>;
  /**
   * Whether to synchronize cache across tabs. If true, the cache will use a BroadcastChannel to send updates between tabs.
   */
  syncTabs?: boolean;
  /**
   * Globally disable persistence of cache entries.
   * If set to `false`, cache entries will not be persisted to the database.
   * `true` means, cache entries can be persisted, they must still be opted into on the resource level & allowed by server headers.
   * @default true
   */
  persist?: boolean;
  /**
   * Version of the caches database, increment this if the interfaces change, this will cause the old data to be deleted.
   * Minimum value is 1, so first increment should be 2.
   * @default 1
   */
  version?: number;
};

const CLIENT_CACHE_TOKEN = new InjectionToken<Cache<HttpResponse<unknown>>>(
  'INTERNAL_CLIENT_CACHE',
);

/**
 * Provides the instance of the QueryCache for queryResource. This should probably be called
 * in your application's root configuration, but can also be overriden with component/module providers.
 *
 * @param options - Optional configuration options for the cache.
 * @returns An Angular `Provider` for the cache.
 *
 * @example
 * // In your app.config.ts or AppModule providers:
 *
 * import { provideQueryCache } from './your-cache';
 *
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideQueryCache({
 *       ttl: 60000, // Default TTL of 60 seconds
 *       staleTime: 30000, // Default staleTime of 30 seconds
 *     }),
 *     // ... other providers
 *   ]
 * };
 */
export function provideQueryCache(opt?: CacheOptions): Provider {
  const serialize = (value: HttpResponse<unknown>) => {
    const headersRecord: Record<string, string[]> = {};

    const headerKeys = value.headers.keys();
    headerKeys.forEach((key) => {
      const values = value.headers.getAll(key);
      if (!values) return;
      headersRecord[key] = values;
    });

    return JSON.stringify({
      body: value.body,
      status: value.status,
      // statusText intentionally omitted: deprecated in Angular, meaningless under
      // HTTP/2+ (HttpResponse defaults it to 'OK' on reconstruction)
      headers: headerKeys.length > 0 ? headersRecord : undefined,
      url: value.url,
    });
  };

  const deserialize = (value: string) => {
    try {
      const parsed = JSON.parse(value);

      if (!parsed || typeof parsed !== 'object' || !('body' in parsed))
        throw new Error('Invalid cache entry format');

      const headers = parsed.headers
        ? new HttpHeaders(parsed.headers)
        : undefined;

      return new HttpResponse({
        body: parsed.body,
        status: parsed.status,
        headers: headers,
        url: parsed.url,
      });
    } catch (err) {
      if (isDevMode()) console.error('Failed to deserialize cache entry:', err);
      return null;
    }
  };

  // version-suffixed so two deploys with incompatible schemas in adjacent tabs don't
  // push entries into each other's caches (the `version` option only fences IndexedDB)
  const syncChannelId = `mmstack-query-cache-sync_v${opt?.version ?? 1}`;

  return {
    provide: CLIENT_CACHE_TOKEN,
    useFactory: () => {
      const onServer = inject(PLATFORM_ID) === 'server';

      // no IndexedDB / BroadcastChannel on the server — each request gets an
      // isolated, request-lived, memory-only cache
      const syncTabsOpt =
        !onServer && opt?.syncTabs
          ? {
              id: syncChannelId,
              serialize,
              deserialize,
            }
          : undefined;

      const db =
        onServer || opt?.persist === false
          ? undefined
          : createSingleStoreDB<string>(
              'mmstack-query-cache-db',
              (version) => `query-store_v${version}`,
              opt?.version,
            ).then((db): CacheDB<HttpResponse<unknown>> => {
              return {
                getAll: () => {
                  return db.getAll().then((entries) => {
                    return entries
                      .map((entry) => {
                        const value = deserialize(entry.value);
                        if (value === null) return null;
                        return {
                          ...entry,
                          value,
                        };
                      })
                      .filter((e) => e !== null);
                  });
                },
                store: (entry) => {
                  return db.store({ ...entry, value: serialize(entry.value) });
                },
                remove: db.remove,
              };
            });

      const cache = new Cache(
        opt?.ttl,
        opt?.staleTime,
        opt?.cleanup,
        syncTabsOpt,
        db,
      );

      // release the sweep interval / channel with the providing injector
      inject(DestroyRef, { optional: true })?.onDestroy(() => cache.destroy());

      return cache;
    },
  };
}

class NoopCache<T> extends Cache<T> {
  constructor() {
    // Infinity checkInterval → no sweep interval is ever armed, so the shared
    // instance below never pins a timer
    super(undefined, undefined, {
      type: 'lru',
      maxSize: 200,
      checkInterval: Infinity,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override store(_: string, __: T, ___ = super.staleTime, ____ = super.ttl) {
    // noop
  }
}

// one shared instance — minting a NoopCache per injectQueryCache() miss would leak
// an instance (and previously an interval) on every prod call without a provider
let NOOP_CACHE: NoopCache<unknown> | undefined;

/**
 * Injects the `QueryCache` instance that is used within queryResource.
 * Allows for direct modification of cached data, but is mostly meant for internal use.
 *
 * @param injector - (Optional) The injector to use.  If not provided, the current
 *                   injection context is used.
 * @returns The `QueryCache` instance.
 *
 * @example
 * // In your component or service:
 *
 * import { injectQueryCache } from './your-cache';
 *
 * constructor() {
 *   const cache = injectQueryCache();
 *
 *   const myData = cache.get(() => 'my-data-key');
 *   if (myData() !== null) {
 *     // ... use cached data ...
 *   }
 * }
 */
export function injectQueryCache<TRaw = unknown>(
  injector?: Injector,
): Cache<HttpResponse<TRaw>> {
  const cache = injector
    ? injector.get(CLIENT_CACHE_TOKEN, null, {
        optional: true,
      })
    : inject(CLIENT_CACHE_TOKEN, {
        optional: true,
      });

  if (!cache) {
    if (isDevMode())
      throw new Error(
        'Cache not provided, please add provideQueryCache() to providers array',
      );
    else return (NOOP_CACHE ??= new NoopCache()) as Cache<HttpResponse<TRaw>>;
  }

  return cache as Cache<HttpResponse<TRaw>>;
}

/**
 * Injects the cache statistics, including the current size of the cache and the number of hits and misses.
 *
 * @param injector - (Optional) The injector to use.  If not provided, the current
 *                   injection context is used.
 * @returns A signal containing the cache statistics.
 */
export function injectCacheStats(injector?: Injector) {
  const cache = injectQueryCache(injector);
  return cache.stats;
}
