import { expect, test, type Page } from '@playwright/test';

// persistedStore against a REAL IndexedDB. The unit suite proves the semantics on an
// in-memory fake; this proves the actual idb-keyval backend: a write lands on disk and
// survives a full page reload, a seeded old-version record is migrated forward on boot
// and re-persisted in the new shape, and clear() removes the entry for real.

// idb-keyval's default store layout.
const DB = 'keyval-store';
const STORE = 'keyval';
const KEY = 'e2e-persisted';

/** Drop idb-keyval's DB from a page that never wires the store, so no connection blocks it. */
async function wipeDb(page: Page): Promise<void> {
  await page.goto('/core');
  await page.evaluate(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(db);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    DB,
  );
}

/** Raw read of the value idb-keyval stored at KEY — proof it is on disk, not in app memory. */
async function idbGet(page: Page): Promise<unknown> {
  return page.evaluate(
    ({ db, store, k }) =>
      new Promise<unknown>((resolve) => {
        const req = indexedDB.open(db);
        req.onsuccess = () => {
          const conn = req.result;
          if (!conn.objectStoreNames.contains(store)) {
            conn.close();
            resolve(null);
            return;
          }
          const g = conn.transaction(store, 'readonly').objectStore(store).get(k);
          g.onsuccess = () => {
            conn.close();
            resolve(g.result ?? null);
          };
          g.onerror = () => {
            conn.close();
            resolve(null);
          };
        };
        req.onerror = () => resolve(null);
      }),
    { db: DB, store: STORE, k: KEY },
  );
}

/** Seed a raw value at KEY, creating idb-keyval's object store if the app hasn't yet. */
async function idbSeed(page: Page, value: unknown): Promise<void> {
  await page.evaluate(
    ({ db, store, k, v }) =>
      new Promise<void>((resolve, reject) => {
        const put = (conn: IDBDatabase) => {
          const tx = conn.transaction(store, 'readwrite');
          tx.objectStore(store).put(v, k);
          tx.oncomplete = () => {
            conn.close();
            resolve();
          };
          tx.onerror = () => {
            conn.close();
            reject(tx.error);
          };
        };
        const open = indexedDB.open(db);
        open.onsuccess = () => {
          const conn = open.result;
          if (conn.objectStoreNames.contains(store)) return put(conn);
          const ver = conn.version + 1;
          conn.close();
          const up = indexedDB.open(db, ver);
          up.onupgradeneeded = () => up.result.createObjectStore(store);
          up.onsuccess = () => put(up.result);
          up.onerror = () => reject(up.error);
        };
        open.onerror = () => reject(open.error);
      }),
    { db: DB, store: STORE, k: KEY, v: value },
  );
}

test.describe('persistedStore on a real IndexedDB', () => {
  test.beforeEach(async ({ page }) => wipeDb(page));
  test.afterEach(async ({ page }) => wipeDb(page));

  test('persists a write to real IDB and restores it after a full reload', async ({
    page,
  }) => {
    await page.goto('/persisted-store');
    await expect(page.getByTestId('ready')).toBeVisible();
    await expect(page.getByTestId('hydrated')).toHaveText('hydrated');

    await page.getByTestId('text-input').fill('hello disk');
    await page.getByTestId('save').click();
    await page.getByTestId('flush').click();

    // really on disk, wrapped in the version envelope
    await expect
      .poll(() => idbGet(page))
      .toEqual({ __mmstack_pv: 2, data: { text: 'hello disk', note: '' } });

    // close and reopen the app: the value comes back from IndexedDB, not memory
    await page.reload();
    await expect(page.getByTestId('ready')).toBeVisible();
    await expect(page.getByTestId('hydrated')).toHaveText('hydrated');
    await expect(page.getByTestId('text')).toHaveText('hello disk');
  });

  test('migrates a seeded v1 snapshot forward on boot and heals it to v2 on disk', async ({
    page,
  }) => {
    // touch the page once so idb-keyval creates its store, then seed a pre-version-2 record
    await page.goto('/persisted-store');
    await expect(page.getByTestId('hydrated')).toHaveText('hydrated');
    await idbSeed(page, { __mmstack_pv: 1, data: { text: 'from v1' } });

    // reopen: migrate(data, 1) runs before the store adopts the snapshot
    await page.reload();
    await expect(page.getByTestId('ready')).toBeVisible();
    await expect(page.getByTestId('hydrated')).toHaveText('hydrated');
    await expect(page.getByTestId('text')).toHaveText('from v1');
    await expect(page.getByTestId('note')).toHaveText('migrated from v1');

    // the migrated shape is re-persisted, so the disk heals to v2 (no repeat migration next boot)
    await expect
      .poll(() => idbGet(page))
      .toEqual({
        __mmstack_pv: 2,
        data: { text: 'from v1', note: 'migrated from v1' },
      });
  });

  test('clear() removes the entry from real IDB and resets the store', async ({
    page,
  }) => {
    await page.goto('/persisted-store');
    await expect(page.getByTestId('hydrated')).toHaveText('hydrated');

    await page.getByTestId('text-input').fill('to be cleared');
    await page.getByTestId('save').click();
    await page.getByTestId('flush').click();
    await expect.poll(() => idbGet(page)).not.toBeNull();

    await page.getByTestId('clear').click();
    await expect(page.getByTestId('text')).toHaveText(''); // reset to initial
    await expect.poll(() => idbGet(page)).toBeNull(); // gone from disk
  });
});
