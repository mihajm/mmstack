import { Cache } from './cache';
import { type CacheDB } from './persistence';

const DAY = 24 * 60 * 60 * 1000;

type Row = Parameters<CacheDB<string>['store']>[0];

function mockDB(rows: Row[] = []) {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const db = {
    getAll: vi.fn(async (): Promise<Row[]> => {
      await gate;
      return rows;
    }),
    store: vi.fn(async (_row: Row) => undefined),
    remove: vi.fn(async (_key: string) => undefined),
    clear: vi.fn(async () => undefined),
  };
  return { db, hydrate: () => release?.() };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('Cache contract (memory)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stats counts entries, hits and misses', () => {
    const cache = new Cache<string>();
    cache.store('a', '1');
    cache.store('b', '2');
    cache.getUntracked('a');
    cache.getUntracked('x');
    expect(cache.stats()).toEqual({ size: 2, hits: 1, misses: 1 });
  });

  it.each([{}, undefined])('builds without crypto.randomUUID (%s)', (c) => {
    vi.stubGlobal('crypto', c);
    expect(() => new Cache<string>().destroy()).not.toThrow();
  });

  it('get() reads entries and null keys', () => {
    const cache = new Cache<string>();
    cache.store('k', 'v');
    expect(cache.get(() => 'k')()!.value).toBe('v');
    expect(cache.get(() => null)()).toBeNull();
  });

  it('get().isStale follows the stale time', () => {
    const cache = new Cache<string>();
    cache.store('k', 'v', 1000, 10_000);
    expect(cache.get(() => 'k')()!.isStale).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(cache.get(() => 'k')()!.isStale).toBe(true);
  });

  it('an entry beyond the timer bound expires lazily on read', () => {
    const cache = new Cache<string>();
    cache.store('k', 'v', 1000, 30 * DAY);
    vi.setSystemTime(Date.now() + 31 * DAY);
    expect(cache.getUntracked('k')).toBeNull();
    expect(cache.get(() => 'k')()).toBeNull();
  });

  it('the default ttl is one day', () => {
    const cache = new Cache<string>();
    cache.store('k', 'v');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(cache.getUntracked('k')).not.toBeNull();
    vi.advanceTimersByTime(DAY - 10 * 60 * 1000 + 1);
    expect(cache.getUntracked('k')).toBeNull();
  });

  it('a held get() signal and stats drop an entry at expiry', () => {
    const cache = new Cache<string>();
    cache.store('k', 'v', 500, 1000);
    const s = cache.get(() => 'k');
    expect(s()).not.toBeNull();
    vi.advanceTimersByTime(1001);
    expect(s()).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  it('a replaced entry keeps its own expiry, not the old timer', () => {
    const cache = new Cache<string>();
    cache.store('k', 'a', 500, 1000);
    cache.store('k', 'b', 500, 5000);
    vi.advanceTimersByTime(1001);
    expect(cache.getUntracked('k')!.value).toBe('b');
  });

  it('an invalidated entry stored again keeps its new expiry', () => {
    const cache = new Cache<string>();
    cache.store('k', 'a', 500, 1000);
    cache.invalidate('k');
    cache.store('k', 'b', 500, 5000);
    vi.advanceTimersByTime(1001);
    expect(cache.getUntracked('k')!.value).toBe('b');
  });

  it('storing an already expired entry removes the old one', () => {
    const { db } = mockDB();
    const cache = new Cache<string>(
      undefined,
      undefined,
      undefined,
      undefined,
      Promise.resolve(db),
    );
    cache.store('k', 'old', 1000, 5000);
    const s = cache.get(() => 'k');
    expect(s()!.value).toBe('old');
    cache.store('k', 'new', 0, 0);
    expect(cache.getUntracked('k')).toBeNull();
    expect(s()).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  it('persists only when asked', async () => {
    const { db } = mockDB();
    const cache = new Cache<string>(
      undefined,
      undefined,
      undefined,
      undefined,
      Promise.resolve(db),
    );
    cache.store('k', 'v');
    await flush();
    expect(db.store).not.toHaveBeenCalled();
    cache.store('j', 'v', undefined, undefined, true);
    await flush();
    expect(db.store).toHaveBeenCalledTimes(1);
    expect(db.store.mock.calls[0][0]).toMatchObject({ key: 'j', value: 'v' });
  });

  it('a local invalidation removes the persisted row', async () => {
    const { db } = mockDB();
    const cache = new Cache<string>(
      undefined,
      undefined,
      undefined,
      undefined,
      Promise.resolve(db),
    );
    cache.store('k', 'v', undefined, undefined, true);
    cache.invalidate('k');
    await flush();
    expect(db.remove).toHaveBeenCalledWith('k');
  });

  it('evicts only above maxSize', () => {
    const cache = new Cache<number>(100_000, 50_000, {
      type: 'lru',
      maxSize: 3,
      checkInterval: 1000,
    });
    cache.store('a', 1);
    cache.store('b', 2);
    cache.store('c', 3);
    vi.advanceTimersByTime(1000);
    expect(cache.stats().size).toBe(3);
  });

  it("'oldest' evicts by creation time, not by access", () => {
    const cache = new Cache<number>(100_000, 50_000, {
      type: 'oldest',
      maxSize: 2,
      checkInterval: 1000,
    });
    cache.store('a', 1);
    vi.advanceTimersByTime(10);
    cache.store('b', 2);
    vi.advanceTimersByTime(10);
    cache.store('c', 3);
    cache.getUntracked('a');
    vi.advanceTimersByTime(1000);
    expect(cache.getUntracked('a')).toBeNull();
    expect(cache.getUntracked('c')).not.toBeNull();
  });

  it('the sweep reclaims expired entries that have no timer', () => {
    const cache = new Cache<number>(100_000, 50_000, {
      type: 'lru',
      maxSize: 2,
      checkInterval: 1000,
    });
    cache.store('x', 0, 1000, 25.5 * DAY);
    cache.store('a', 1, 1000, 60 * DAY);
    cache.store('b', 2, 1000, 60 * DAY);
    vi.setSystemTime(Date.now() + 26 * DAY);
    vi.advanceTimersByTime(1000);
    expect(cache.stats().size).toBe(2);
    expect(cache.getUntracked('a')).not.toBeNull();
    expect(cache.getUntracked('b')).not.toBeNull();
  });

  it('destroy() stops the sweep interval', () => {
    const cache = new Cache<string>(undefined, undefined, {
      checkInterval: 1000,
    });
    cache.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the foreign-key hint ignores an empty cache, then fires once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = new Cache<string>();
    cache.invalidateUrlPrefix('/api');
    expect(warn).not.toHaveBeenCalled();
    cache.store('custom-key', 'v');
    cache.invalidateUrlPrefix('/api');
    cache.invalidateUrlPrefix('/api');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
