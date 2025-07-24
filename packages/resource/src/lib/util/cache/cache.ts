import { HttpHeaders, HttpResponse } from '@angular/common/http';
import {
  computed,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  type Provider,
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
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
  key: string;
};

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

  /**
   * Destroys the cache instance, cleaning up any resources used by the cache.
   * This method is called automatically when the cache instance is garbage collected.
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
    cleanupOpt: Partial<CleanupType> = {
      type: 'lru',
      maxSize: 1000,
      checkInterval: ONE_HOUR,
    },
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

    // cleanup cache based on provided options regularly
    const cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupOpt.checkInterval);

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
          this.storeInternal(
            msg.entry.key,
            value,
            msg.entry.stale - msg.entry.updated,
            msg.entry.expiresAt - msg.entry.updated,
            true,
            false,
          );
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
      clearInterval(cleanupInterval);
      destroySyncTabs();
    };

    this.db
      .then(async (db) => {
        if (destroyed) return [];
        return db.getAll();
      })
      .then((entries) => {
        if (destroyed) return;
        // load entries into the cache

        const current = untracked(this.internal);
        entries.forEach((entry) => {
          if (current.has(entry.key)) return;
          this.storeInternal(
            entry.key,
            entry.value,
            entry.stale - entry.updated,
            entry.expiresAt - entry.updated,
            true, // like from sync because we dont want to trigger sync or db writes
          );
        });
      });

    this.destroy = destroy;

    // cleanup if object is garbage collected, this is because the cache can be quite large from a memory standpoint & we dont want all that floating garbage
    const registry = new FinalizationRegistry((id: string) => {
      if (id === this.id) {
        destroy();
      }
    });

    registry.register(this, this.id);
  }

  /** @internal */
  private getInternal(
    key: () => string | null,
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | null> {
    const keySignal = computed(() => key());

    return computed(() => {
      const key = keySignal();
      if (!key) return null;
      const found = this.internal().get(key);

      const now = Date.now();

      if (!found || found.expiresAt <= now) return null;
      found.useCount++;
      return {
        ...found,
        isStale: found.stale <= now,
      };
    });
  }

  /**
   * Retrieves a cache entry without affecting its usage count (for LRU).  This is primarily
   * for internal use or debugging.
   * @internal
   * @param key - The key of the entry to retrieve.
   * @returns The cache entry, or `null` if not found or expired.
   */
  getUntracked(key: string): (CacheEntry<T> & { isStale: boolean }) | null {
    return untracked(this.getInternal(() => key));
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
   * @param key - The key under which to store the value.
   * @param value - The value to store.
   * @param staleTime - (Optional) The stale time for this entry, in milliseconds. Overrides the default `staleTime`.
   * @param ttl - (Optional) The TTL for this entry, in milliseconds. Overrides the default `ttl`.
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
    const entry = this.getUntracked(key);
    if (entry) {
      clearTimeout(entry.timeout); // stop invalidation
    }

    const prevCount = entry?.useCount ?? 0;

    // ttl cannot be less than staleTime
    if (ttl < staleTime) staleTime = ttl;

    const now = Date.now();

    const next: Omit<CacheEntry<T>, 'timeout'> = {
      value,
      created: entry?.created ?? now,
      updated: now,
      useCount: prevCount + 1,
      stale: now + staleTime,
      expiresAt: now + ttl,
      key,
    };

    this.internal.mutate((map) => {
      map.set(key, {
        ...next,
        timeout: setTimeout(() => this.invalidate(key), ttl),
      });
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

  private invalidateInternal(key: string, fromSync = false) {
    const entry = this.getUntracked(key);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.internal.mutate((map) => {
      map.delete(key);
      return map;
    });
    if (!fromSync) {
      this.db.then((db) => db.remove(key));
      this.broadcast({ action: 'invalidate', entry: { key } });
    }
  }

  /** @internal */
  private cleanup() {
    if (untracked(this.internal).size <= this.cleanupOpt.maxSize) return;

    const sorted = Array.from(untracked(this.internal).entries()).toSorted(
      (a, b) => {
        if (this.cleanupOpt.type === 'lru') {
          return a[1].useCount - b[1].useCount; // least used first
        } else {
          return a[1].created - b[1].created; // oldest first
        }
      },
    );

    const keepCount = Math.floor(this.cleanupOpt.maxSize / 2);

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
      statusText: value.statusText,
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
        statusText: parsed.statusText,
        headers: headers,
        url: parsed.url,
      });
    } catch (err) {
      if (isDevMode()) console.error('Failed to deserialize cache entry:', err);
      return null;
    }
  };

  const syncTabsOpt = opt?.syncTabs
    ? {
        id: 'mmstack-query-cache-sync',
        serialize,
        deserialize,
      }
    : undefined;

  let db =
    opt?.persist === false
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

  return {
    provide: CLIENT_CACHE_TOKEN,
    useValue: new Cache(
      opt?.ttl,
      opt?.staleTime,
      opt?.cleanup,
      syncTabsOpt,
      db,
    ),
  };
}

class NoopCache<T> extends Cache<T> {
  override store(_: string, __: T, ___ = super.staleTime, ____ = super.ttl) {
    // noop
  }
}

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
    else return new NoopCache();
  }

  return cache as Cache<HttpResponse<TRaw>>;
}
