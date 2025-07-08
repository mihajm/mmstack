import type { HttpResponse } from '@angular/common/http';
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
import { v7 } from 'uuid';

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

  /**
   * Creates a new `Cache` instance.
   *
   * @param ttl - The default Time To Live (TTL) for cache entries, in milliseconds.  Defaults to one day.
   * @param staleTime - The default duration, in milliseconds, during which a cache entry is considered
   *                    stale but can still be used while revalidation occurs in the background. Defaults to 1 hour.
   * @param cleanupOpt - Options for configuring the cache cleanup strategy.  Defaults to LRU with a
   *                     `maxSize` of 200 and a `checkInterval` of one hour.
   */
  constructor(
    protected readonly ttl: number = ONE_DAY,
    protected readonly staleTime: number = ONE_HOUR,
    cleanupOpt: Partial<CleanupType> = {
      type: 'lru',
      maxSize: 1000,
      checkInterval: ONE_HOUR,
    },
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

    const destroyId = v7();

    // cleanup if object is garbage collected, this is because the cache can be quite large from a memory standpoint & we dont want all that floating garbage
    const registry = new FinalizationRegistry((id: string) => {
      if (id === destroyId) {
        clearInterval(cleanupInterval);
      }
    });

    registry.register(this, destroyId);
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
  store(key: string, value: T, staleTime = this.staleTime, ttl = this.ttl) {
    const entry = this.getUntracked(key);
    if (entry) {
      clearTimeout(entry.timeout); // stop invalidation
    }

    const prevCount = entry?.useCount ?? 0;

    // ttl cannot be less than staleTime
    if (ttl < staleTime) staleTime = ttl;

    const now = Date.now();

    this.internal.mutate((map) => {
      map.set(key, {
        value,
        created: entry?.created ?? now,
        useCount: prevCount + 1,
        stale: now + staleTime,
        expiresAt: now + ttl,
        timeout: setTimeout(() => this.invalidate(key), ttl),
        key,
      });
      return map;
    });
  }

  /**
   * Invalidates (removes) a cache entry.
   *
   * @param key - The key of the entry to invalidate.
   */
  invalidate(key: string) {
    const entry = this.getUntracked(key);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.internal.mutate((map) => {
      map.delete(key);
      return map;
    });
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
  return {
    provide: CLIENT_CACHE_TOKEN,
    useValue: new Cache(opt?.ttl, opt?.staleTime, opt?.cleanup),
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
