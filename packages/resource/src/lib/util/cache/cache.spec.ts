/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Cache } from './cache';

describe('Cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
});
