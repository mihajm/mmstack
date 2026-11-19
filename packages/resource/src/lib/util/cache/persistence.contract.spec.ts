import { IDBFactory } from 'fake-indexeddb';
import { type CacheDB, createSingleStoreDB } from './persistence';

type Row = Parameters<CacheDB<string>['store']>[0];

function row(key: string, value: string, expiresIn = 60_000): Row {
  const now = Date.now();
  return {
    key,
    value,
    created: now,
    updated: now,
    useCount: 1,
    lastAccessed: now,
    stale: now + expiresIn / 2,
    expiresAt: now + expiresIn,
  };
}

const storeName = (v: number) => `s_v${v}`;
const open = (version = 1, name = 'db') =>
  createSingleStoreDB<string>(name, storeName, version);

function raw(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function rawKeys(name: string, store: string): Promise<string[]> {
  const db = await raw(name);
  const keys = await new Promise<string[]>((res) => {
    const req = db
      .transaction(store, 'readonly')
      .objectStore(store)
      .getAllKeys();
    req.onsuccess = () => res(req.result as string[]);
  });
  db.close();
  return keys;
}

describe('createSingleStoreDB (IndexedDB)', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips store, getAll and remove', async () => {
    const db = await open();
    await db.store(row('a', '1'));
    await db.store(row('b', '2'));
    expect((await db.getAll()).map((r) => r.key).toSorted()).toEqual([
      'a',
      'b',
    ]);
    await db.remove('a');
    expect((await db.getAll()).map((r) => r.value)).toEqual(['2']);
  });

  it('a second connection sees rows written by the first', async () => {
    const first = await open();
    await first.store(row('k', 'v'));
    const second = await open();
    expect((await second.getAll())[0]).toMatchObject({ key: 'k', value: 'v' });
  });

  it('getAll skips expired rows and deletes them', async () => {
    const db = await open();
    await db.store(row('live', '1'));
    await db.store(row('dead', '2', -1000));
    expect((await db.getAll()).map((r) => r.key)).toEqual(['live']);
    await new Promise((r) => setTimeout(r, 10));
    expect(await rawKeys('db', storeName(1))).toEqual(['live']);
  });

  it('clear() removes every row', async () => {
    const db = await open();
    await db.store(row('a', '1'));
    await db.store(row('b', '2'));
    await db.clear?.();
    expect(await db.getAll()).toEqual([]);
  });

  it('a version bump drops the old rows and keeps working', async () => {
    const v1 = await open(1, 'bump');
    await v1.store(row('old', '1'));
    const v2 = await open(2, 'bump');
    expect(await v2.getAll()).toEqual([]);
    await v2.store(row('new', '2'));
    const again = await open(2, 'bump');
    expect((await again.getAll()).map((r) => r.key)).toEqual(['new']);
  });

  it('an older open connection does not block a version bump', async () => {
    const v1 = await open(1, 'blocked');
    await v1.store(row('old', '1'));
    const settled = await Promise.race([
      open(2, 'blocked').then(() => 'opened'),
      new Promise((r) => setTimeout(() => r('blocked'), 300)),
    ]);
    expect(settled).toBe('opened');
  });

  it('falls back to a no-op store without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const db = await open();
    await db.store(row('a', '1'));
    expect(await db.getAll()).toEqual([]);
  });
});
