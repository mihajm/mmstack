import { Cache } from './cache';
import { type CacheDB } from './persistence';

type Row = Parameters<CacheDB<string>['store']>[0];

function row(key: string, value: string, opt: Partial<Row> = {}): Row {
  const now = Date.now();
  return {
    key,
    value,
    created: now,
    updated: now,
    useCount: 1,
    lastAccessed: now,
    stale: now + 60_000,
    expiresAt: now + 120_000,
    ...opt,
  };
}

function mockDB(rows: Row[] = [], withClear = true) {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const db = {
    getAll: vi.fn(async (): Promise<Row[]> => {
      await gate;
      return rows;
    }),
    store: vi.fn(async (_row: Row) => undefined),
    remove: vi.fn(async (_key: string) => undefined),
    clear: withClear ? vi.fn(async () => undefined) : undefined,
  };
  return { db, hydrate: () => release?.() };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const cacheWith = (
  db: CacheDB<string>,
  cleanup?: Partial<{ type: 'lru'; maxSize: number; checkInterval: number }>,
) =>
  new Cache<string>(
    undefined,
    undefined,
    cleanup,
    undefined,
    Promise.resolve(db),
  );

describe('Cache contract (persistence)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a write made before hydration wins over an older persisted row', async () => {
    const { db, hydrate } = mockDB([row('k', 'persisted')]);
    const cache = cacheWith(db);
    cache.store('k', 'fresh');
    hydrate();
    await flush();
    expect(cache.getUntracked('k')!.value).toBe('fresh');
  });

  it('hydration keeps the persisted lastAccessed for LRU', async () => {
    const t = Date.now();
    const { db, hydrate } = mockDB([
      row('old', '1', { updated: t, lastAccessed: t - 3000 }),
      row('newest', '2', { updated: t, lastAccessed: t - 1000 }),
      row('mid', '3', { updated: t, lastAccessed: t - 2000 }),
    ]);
    const cache = cacheWith(db, {
      type: 'lru',
      maxSize: 2,
      checkInterval: 1000,
    });
    hydrate();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(cache.getUntracked('newest')).not.toBeNull();
    expect(cache.stats().size).toBe(1);
  });

  it('clear() before hydration keeps every persisted row out', async () => {
    const { db, hydrate } = mockDB([row('a', '1'), row('b', '2')]);
    const cache = cacheWith(db);
    cache.clear();
    hydrate();
    await flush();
    expect(cache.stats().size).toBe(0);
    expect(db.clear).toHaveBeenCalled();
  });

  it('clear() removes persisted rows that are not in memory', async () => {
    const { db, hydrate } = mockDB([]);
    const cache = cacheWith(db);
    hydrate();
    await flush();
    cache.clear();
    await flush();
    expect(db.clear).toHaveBeenCalledTimes(1);
  });

  it('clear() falls back to removing every row when the db has no clear', async () => {
    const { db, hydrate } = mockDB([row('a', '1'), row('b', '2')], false);
    const cache = cacheWith(db);
    hydrate();
    await flush();
    cache.invalidate('a');
    await flush();
    db.remove.mockClear();
    cache.clear();
    await flush();
    expect(db.remove.mock.calls.map((c) => c[0]).toSorted()).toEqual([
      'a',
      'b',
    ]);
  });

  it('invalidateWhere before hydration keeps matching rows out and deletes them', async () => {
    const { db, hydrate } = mockDB([
      row('/posts/1', '1'),
      row('/users/1', '2'),
    ]);
    const cache = cacheWith(db);
    cache.invalidatePrefix('/posts');
    hydrate();
    await flush();
    expect(cache.getUntracked('/posts/1')).toBeNull();
    expect(cache.getUntracked('/users/1')).not.toBeNull();
    expect(db.remove).toHaveBeenCalledWith('/posts/1');
  });

  it('the sweep deletes the rows it evicts', async () => {
    const { db, hydrate } = mockDB();
    const cache = cacheWith(db, {
      type: 'lru',
      maxSize: 2,
      checkInterval: 1000,
    });
    hydrate();
    await flush();
    cache.store('a', '1', undefined, undefined, true);
    vi.advanceTimersByTime(10);
    cache.store('b', '2', undefined, undefined, true);
    vi.advanceTimersByTime(10);
    cache.store('c', '3', undefined, undefined, true);
    await vi.advanceTimersByTimeAsync(1000);
    const removed = db.remove.mock.calls.map((c) => c[0]);
    expect(removed).toContain('a');
    expect(removed).toContain('b');
    expect(removed).not.toContain('c');
  });

  it('storing an already expired entry deletes the persisted row', async () => {
    const { db, hydrate } = mockDB();
    const cache = cacheWith(db);
    hydrate();
    await flush();
    cache.store('k', 'v', 1000, 5000, true);
    cache.store('k', 'gone', 0, 0, true);
    await flush();
    expect(db.remove).toHaveBeenCalledWith('k');
  });
});

describe('Cache contract (cross-tab)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const identity = (id: string, deserialize = (v: unknown) => v as string) => ({
    id,
    serialize: (v: string) => v,
    deserialize,
  });

  function pair() {
    const id = `cache-contract-${Math.random()}`;
    const a = new Cache<string>(undefined, undefined, undefined, identity(id));
    const b = new Cache<string>(undefined, undefined, undefined, identity(id));
    return { id, a, b, done: () => (a.destroy(), b.destroy()) };
  }

  it('a store and an invalidate reach the other tab', async () => {
    const { a, b, done } = pair();
    a.store('k', 'v');
    await tick();
    expect(b.getUntracked('k')!.value).toBe('v');
    a.invalidate('k');
    await tick();
    expect(b.getUntracked('k')).toBeNull();
    done();
  });

  it('a store with broadcast off stays in its tab', async () => {
    const { a, b, done } = pair();
    a.store('j', 'v', undefined, undefined, false, false);
    await tick();
    expect(b.getUntracked('j')).toBeNull();
    done();
  });

  it('a received invalidation is not sent back', async () => {
    const { id, a, b, done } = pair();
    const seen: unknown[] = [];
    const observer = new BroadcastChannel(id);
    observer.onmessage = (e) => seen.push(e.data);
    a.store('k', 'v');
    await tick();
    seen.length = 0;
    a.invalidate('k');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(1);
    expect(b.getUntracked('k')).toBeNull();
    observer.close();
    done();
  });

  it('clear() empties the other tab too', async () => {
    const { a, b, done } = pair();
    b.store('only-b', 'v', undefined, undefined, false, false);
    a.clear();
    await tick();
    expect(b.getUntracked('only-b')).toBeNull();
    done();
  });

  it('a row the deserializer rejects is dropped', async () => {
    const id = `cache-contract-null-${Math.random()}`;
    const cache = new Cache<string>(
      undefined,
      undefined,
      undefined,
      identity(id, () => null as never),
    );
    const other = new BroadcastChannel(id);
    other.postMessage({
      action: 'store',
      type: 'cache-sync-message',
      cacheId: 'other',
      entry: row('k', 'v'),
    });
    await tick();
    expect(cache.getUntracked('k')).toBeNull();
    other.close();
    cache.destroy();
  });

  it('a destroyed cache stops applying other tabs’ writes', async () => {
    const id = `cache-contract-destroy-${Math.random()}`;
    const cache = new Cache<string>(
      undefined,
      undefined,
      undefined,
      identity(id),
    );
    cache.destroy();
    const other = new BroadcastChannel(id);
    other.postMessage({
      action: 'store',
      type: 'cache-sync-message',
      cacheId: 'other',
      entry: row('k', 'v'),
    });
    await tick();
    expect(cache.getUntracked('k')).toBeNull();
    other.close();
  });
});
