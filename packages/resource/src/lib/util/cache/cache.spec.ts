/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { hashRequest } from '../hash-request';
import { Cache } from './cache';

describe('Cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should store and retrieve a value', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'hello');
    const entry = cache.getUntracked('key1');

    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('hello');
    expect(entry!.isStale).toBe(false);
  });

  it('should return null for missing keys', () => {
    const cache = new Cache<string>();

    expect(cache.getUntracked('missing')).toBeNull();
  });

  it('should invalidate a stored entry', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'hello');
    expect(cache.getUntracked('key1')).not.toBeNull();

    cache.invalidate('key1');
    expect(cache.getUntracked('key1')).toBeNull();
  });

  it('should invalidate no-op for missing key', () => {
    const cache = new Cache<string>();

    // Should not throw
    expect(() => cache.invalidate('nonexistent')).not.toThrow();
  });

  it('invalidatePrefix removes every matching key', () => {
    const cache = new Cache<string>();
    cache.store('GET /api/posts', 'list');
    cache.store('GET /api/posts/1', 'one');
    cache.store('GET /api/posts/2', 'two');
    cache.store('GET /api/users', 'users');

    const removed = cache.invalidatePrefix('GET /api/posts');

    expect(removed).toBe(3);
    expect(cache.getUntracked('GET /api/posts')).toBeNull();
    expect(cache.getUntracked('GET /api/posts/1')).toBeNull();
    expect(cache.getUntracked('GET /api/posts/2')).toBeNull();
    // unrelated key survives
    expect(cache.getUntracked('GET /api/users')).not.toBeNull();
  });

  it('invalidatePrefix returns 0 when no keys match', () => {
    const cache = new Cache<string>();
    cache.store('GET /api/posts', 'list');

    expect(cache.invalidatePrefix('GET /api/users')).toBe(0);
    // existing entry untouched
    expect(cache.getUntracked('GET /api/posts')).not.toBeNull();
  });

  it('invalidateWhere accepts arbitrary predicates', () => {
    const cache = new Cache<string>();
    cache.store('user:42:profile', 'p');
    cache.store('user:42:settings', 's');
    cache.store('user:99:profile', 'p2');

    const removed = cache.invalidateWhere((k) => k.includes(':42:'));

    expect(removed).toBe(2);
    expect(cache.getUntracked('user:42:profile')).toBeNull();
    expect(cache.getUntracked('user:42:settings')).toBeNull();
    expect(cache.getUntracked('user:99:profile')).not.toBeNull();
  });

  describe('invalidateUrlPrefix', () => {
    it('matches by URL regardless of method, plus params and subpaths', () => {
      const cache = new Cache<string>();
      const list = hashRequest({ url: '/api/posts' });
      const page2 = hashRequest({ url: '/api/posts', params: { page: '2' } });
      const detail = hashRequest({ url: '/api/posts/1' });
      const search = hashRequest({ method: 'POST', url: '/api/posts', body: { q: 'x' } });
      const users = hashRequest({ url: '/api/users' });
      [list, page2, detail, search, users].forEach((k) => cache.store(k, 'v'));

      const removed = cache.invalidateUrlPrefix('/api/posts');

      expect(removed).toBe(4);
      expect(cache.getUntracked(list)).toBeNull();
      expect(cache.getUntracked(page2)).toBeNull();
      expect(cache.getUntracked(detail)).toBeNull();
      expect(cache.getUntracked(search)).toBeNull();
      expect(cache.getUntracked(users)).not.toBeNull();
    });

    it('recovers the URL even when a namespace is prepended (default extractor)', () => {
      const cache = new Cache<string>();
      const key = `tenant-7:${hashRequest({ url: '/api/posts' })}`;
      cache.store(key, 'v');

      expect(cache.invalidateUrlPrefix('/api/posts')).toBe(1);
      expect(cache.getUntracked(key)).toBeNull();
    });

    it('uses a custom matcher for fully-foreign key schemes', () => {
      const cache = new Cache<string>();
      cache.store('tenant-7|url=/api/posts', 'v');
      cache.store('tenant-7|url=/api/users', 'v');

      const removed = cache.invalidateUrlPrefix(
        '/api/posts',
        (urlPrefix) => (key) => key.includes(`|url=${urlPrefix}`),
      );

      expect(removed).toBe(1);
      expect(cache.getUntracked('tenant-7|url=/api/posts')).toBeNull();
      expect(cache.getUntracked('tenant-7|url=/api/users')).not.toBeNull();
    });

    it('dev-warns once when nothing matched and every key is foreign-shaped', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const cache = new Cache<string>();
      cache.store('totally-custom-key-a', 'v');
      cache.store('totally-custom-key-b', 'v');

      expect(cache.invalidateUrlPrefix('/api/posts')).toBe(0);
      expect(cache.invalidateUrlPrefix('/api/users')).toBe(0);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('invalidateMatcher');
    });

    it('does NOT warn when an auto-shape key exists (default is working)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const cache = new Cache<string>();
      cache.store(hashRequest({ url: '/api/users' }), 'v');
      cache.store('totally-custom-key', 'v');

      // zero matches for this prefix, but auto-shape keys are present → no hint
      expect(cache.invalidateUrlPrefix('/api/posts')).toBe(0);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('should auto-expire entries after TTL', () => {
    const ttl = 1000;
    const cache = new Cache<string>(ttl);

    cache.store('key1', 'value');
    expect(cache.getUntracked('key1')).not.toBeNull();

    vi.advanceTimersByTime(ttl + 1);
    expect(cache.getUntracked('key1')).toBeNull();
  });

  it('should mark entries as stale after staleTime', () => {
    const ttl = 10000;
    const staleTime = 1000;
    const cache = new Cache<string>(ttl, staleTime);

    cache.store('key1', 'value');
    expect(cache.getUntracked('key1')!.isStale).toBe(false);

    vi.advanceTimersByTime(staleTime + 1);
    const entry = cache.getUntracked('key1');

    expect(entry).not.toBeNull();
    expect(entry!.isStale).toBe(true);
  });

  it('should allow custom staleTime and ttl per entry', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'value', 500, 2000);

    expect(cache.getUntracked('key1')!.isStale).toBe(false);

    vi.advanceTimersByTime(501);
    expect(cache.getUntracked('key1')!.isStale).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(cache.getUntracked('key1')).toBeNull();
  });

  it('should clamp staleTime to ttl when staleTime > ttl', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'value', 5000, 1000);

    // staleTime should be clamped to ttl (1000ms)
    vi.advanceTimersByTime(999);
    expect(cache.getUntracked('key1')!.isStale).toBe(false);

    vi.advanceTimersByTime(2);
    // stale and expired at the same time
    expect(cache.getUntracked('key1')).toBeNull();
  });

  it('should update existing entry on re-store', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'first');
    const first = cache.getUntracked('key1')!;
    expect(first.value).toBe('first');

    vi.advanceTimersByTime(10);
    cache.store('key1', 'second');
    const second = cache.getUntracked('key1')!;

    expect(second.value).toBe('second');
    expect(second.created).toBe(first.created); // created timestamp preserved
    expect(second.updated).toBeGreaterThan(first.updated);
    expect(second.useCount).toBeGreaterThan(first.useCount);
  });

  it('should increment useCount on get', () => {
    const cache = new Cache<string>();

    cache.store('key1', 'value');
    const first = cache.getUntracked('key1')!;
    const useCount1 = first.useCount;

    const second = cache.getUntracked('key1')!;
    expect(second.useCount).toBe(useCount1 + 1);
  });

  it('should throw for maxSize <= 0', () => {
    expect(
      () =>
        new Cache<string>(1000, 500, {
          type: 'lru',
          maxSize: 0,
          checkInterval: 1000,
        }),
    ).toThrow('maxSize must be greater than 0');

    expect(
      () =>
        new Cache<string>(1000, 500, {
          type: 'lru',
          maxSize: -1,
          checkInterval: 1000,
        }),
    ).toThrow('maxSize must be greater than 0');
  });

  describe('LRU cleanup', () => {
    it('should evict least recently used entries when exceeding maxSize', () => {
      const checkInterval = 1000;
      const cache = new Cache<number>(100000, 50000, {
        type: 'lru',
        maxSize: 3,
        checkInterval,
      });

      cache.store('a', 1);
      cache.store('b', 2);
      cache.store('c', 3);
      cache.store('d', 4); // now exceeds maxSize

      // Access 'c' and 'd' to increase their useCount
      cache.getUntracked('c');
      cache.getUntracked('d');

      // Trigger cleanup
      vi.advanceTimersByTime(checkInterval);

      // 'a' and 'b' should be evicted (least used)
      // keepCount = floor(3 / 2) = 1, so only 1 kept... but 'd' has most uses
      expect(cache.getUntracked('d')).not.toBeNull();
    });
  });

  describe('oldest cleanup', () => {
    it('should evict oldest entries when exceeding maxSize', () => {
      const checkInterval = 1000;
      const cache = new Cache<number>(100000, 50000, {
        type: 'oldest',
        maxSize: 3,
        checkInterval,
      });

      cache.store('a', 1);
      vi.advanceTimersByTime(10);
      cache.store('b', 2);
      vi.advanceTimersByTime(10);
      cache.store('c', 3);
      vi.advanceTimersByTime(10);
      cache.store('d', 4); // exceeds maxSize

      // Trigger cleanup
      vi.advanceTimersByTime(checkInterval);

      // 'a' should be evicted first (oldest)
      expect(cache.getUntracked('a')).toBeNull();
      // 'd' should survive (newest)
      expect(cache.getUntracked('d')).not.toBeNull();
    });
  });

  describe('cross-tab sync (BroadcastChannel)', () => {
    function waitForChannel() {
      // BroadcastChannel delivery uses the macrotask queue; one setTimeout(0)
      // is enough to let the message land.
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    it('drops stale store messages whose updated timestamp is older than the local entry', async () => {
      if (typeof BroadcastChannel === 'undefined') return;
      vi.useRealTimers();

      const channelId = `mmstack-sync-test-stale-${Math.random()}`;
      const cache = new Cache<string>(undefined, undefined, undefined, {
        id: channelId,
        serialize: (v) => v,
        deserialize: (v) => v,
      });

      cache.store('k', 'local-newer');
      const localUpdated = cache.getUntracked('k')!.updated;

      const otherTabChannel = new BroadcastChannel(channelId);
      otherTabChannel.postMessage({
        action: 'store',
        type: 'cache-sync-message',
        cacheId: 'some-other-cache',
        entry: {
          key: 'k',
          value: 'stale-from-other-tab',
          updated: localUpdated - 100,
          created: localUpdated - 100,
          stale: localUpdated - 100 + 60_000,
          expiresAt: localUpdated - 100 + 60_000,
          useCount: 1,
        },
      });

      await waitForChannel();

      expect(cache.getUntracked('k')!.value).toBe('local-newer');

      otherTabChannel.close();
      cache.destroy();
    });

    it('accepts store messages newer than the local entry', async () => {
      if (typeof BroadcastChannel === 'undefined') return;
      vi.useRealTimers();

      const channelId = `mmstack-sync-test-newer-${Math.random()}`;
      const cache = new Cache<string>(undefined, undefined, undefined, {
        id: channelId,
        serialize: (v) => v,
        deserialize: (v) => v,
      });

      cache.store('k', 'local-older');
      const localUpdated = cache.getUntracked('k')!.updated;

      const otherTabChannel = new BroadcastChannel(channelId);
      otherTabChannel.postMessage({
        action: 'store',
        type: 'cache-sync-message',
        cacheId: 'some-other-cache',
        // NOTE: deliberately no `lastAccessed` — simulates a message from a tab
        // running an older version; the restore path must default it to `updated`
        entry: {
          key: 'k',
          value: 'newer-from-other-tab',
          updated: localUpdated + 100,
          created: localUpdated,
          stale: localUpdated + 100 + 60_000,
          expiresAt: localUpdated + 100 + 60_000,
          useCount: 1,
        },
      });

      await waitForChannel();

      expect(cache.getUntracked('k')!.value).toBe('newer-from-other-tab');

      otherTabChannel.close();
      cache.destroy();
    });
  });

  describe('destroy', () => {
    it('should be idempotent', () => {
      const cache = new Cache<string>();

      expect(() => {
        cache.destroy();
        cache.destroy();
      }).not.toThrow();
    });
  });

  describe('timer-safe TTLs', () => {
    it('an Infinity ttl (immutable) must NOT self-destruct', () => {
      const cache = new Cache<string>();
      cache.store('immutable', 'forever', Infinity, Infinity);

      // regression: setTimeout(…, Infinity) coerces to 0 — the entry used to be
      // invalidated on the very next tick
      vi.advanceTimersByTime(60_000);

      const entry = cache.getUntracked('immutable');
      expect(entry).not.toBeNull();
      expect(entry!.isStale).toBe(false);
    });

    it('a ttl beyond the int32 timer bound must not wrap negative', () => {
      const cache = new Cache<string>();
      const sixtyDays = 1000 * 60 * 60 * 24 * 60; // > 2^31-1 ms
      cache.store('long', 'lived', 1000, sixtyDays);

      vi.advanceTimersByTime(10_000);

      expect(cache.getUntracked('long')).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('removes every entry', () => {
      const cache = new Cache<string>();
      cache.store('a', '1');
      cache.store('b', '2');
      cache.store('c', '3');

      cache.clear();

      expect(cache.getUntracked('a')).toBeNull();
      expect(cache.getUntracked('b')).toBeNull();
      expect(cache.getUntracked('c')).toBeNull();
    });
  });

  describe('cleanup interval configuration', () => {
    it('uses the merged defaults when a partial cleanup option omits checkInterval', () => {
      const spy = vi.spyOn(globalThis, 'setInterval');

      // regression: the raw partial was read directly → setInterval(fn, undefined)
      // → a ~4ms sweep storm
      const cache = new Cache<string>(undefined, undefined, { maxSize: 50 });

      const delays = spy.mock.calls.map((c) => c[1]);
      expect(delays).toContain(1000 * 60 * 60); // merged default: ONE_HOUR
      expect(delays).not.toContain(undefined);

      cache.destroy();
      spy.mockRestore();
    });
  });

  describe('LRU recency (not frequency)', () => {
    it('a recently-accessed entry outlives more-frequently-used older ones', () => {
      const checkInterval = 1000;
      const cache = new Cache<number>(100000, 50000, {
        type: 'lru',
        maxSize: 4,
        checkInterval,
      });

      cache.store('a', 1);
      vi.advanceTimersByTime(10);
      cache.store('b', 2);
      // pump b's frequency — under LFU this would protect it
      cache.getUntracked('b');
      cache.getUntracked('b');
      cache.getUntracked('b');
      vi.advanceTimersByTime(10);
      cache.store('c', 3);
      vi.advanceTimersByTime(10);
      cache.store('d', 4);
      vi.advanceTimersByTime(10);

      cache.getUntracked('a'); // 'a' becomes the most recently accessed
      vi.advanceTimersByTime(10);
      cache.store('e', 5); // exceeds maxSize

      vi.advanceTimersByTime(checkInterval); // sweep: keepCount = floor(4/2) = 2

      expect(cache.getUntracked('a')).not.toBeNull(); // recent access wins
      expect(cache.getUntracked('e')).not.toBeNull(); // newest write
      expect(cache.getUntracked('b')).toBeNull(); // frequent but old → evicted
      expect(cache.getUntracked('c')).toBeNull();
      expect(cache.getUntracked('d')).toBeNull();
    });
  });

  describe('hydration from persistence', () => {
    function makeStoredEntry(
      key: string,
      value: string,
      opt: { updated: number; stale: number; expiresAt: number },
    ) {
      return {
        key,
        value,
        created: opt.updated,
        updated: opt.updated,
        useCount: 1,
        lastAccessed: opt.updated,
        stale: opt.stale,
        expiresAt: opt.expiresAt,
      };
    }

    it('preserves ABSOLUTE freshness windows instead of re-anchoring to now', async () => {
      const now = Date.now();
      // persisted 2h ago: staleTime was 1h (already passed), ttl 3h (1h remaining)
      const entry = makeStoredEntry('k', 'v', {
        updated: now - 2 * 60 * 60 * 1000,
        stale: now - 60 * 60 * 1000,
        expiresAt: now + 60 * 60 * 1000,
      });

      const cache = new Cache<string>(
        undefined,
        undefined,
        undefined,
        undefined,
        Promise.resolve({
          getAll: async () => [entry],
          store: async () => undefined,
          remove: async () => undefined,
        }),
      );

      await vi.advanceTimersByTimeAsync(0); // flush hydration microtasks

      const hydrated = cache.getUntracked('k');
      expect(hydrated).not.toBeNull();
      // regression: re-anchoring used to make this FRESH for another full hour
      expect(hydrated!.isStale).toBe(true);

      // and the remaining lifetime is honored, not extended
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      expect(cache.getUntracked('k')).toBeNull();
    });

    it('does not resurrect keys invalidated while hydration was in flight', async () => {
      const now = Date.now();
      const entry = makeStoredEntry('k', 'v', {
        updated: now,
        stale: now + 60_000,
        expiresAt: now + 120_000,
      });

      let resolveGetAll!: (entries: (typeof entry)[]) => void;
      const cache = new Cache<string>(
        undefined,
        undefined,
        undefined,
        undefined,
        Promise.resolve({
          getAll: () =>
            new Promise<(typeof entry)[]>((res) => (resolveGetAll = res)),
          store: async () => undefined,
          remove: async () => undefined,
        }),
      );

      await vi.advanceTimersByTimeAsync(0); // let the cache call getAll

      cache.invalidate('k'); // logout-on-boot style invalidation

      resolveGetAll([entry]);
      await vi.advanceTimersByTimeAsync(0);

      // regression: hydration used to re-insert the just-invalidated entry
      expect(cache.getUntracked('k')).toBeNull();
    });
  });
});
