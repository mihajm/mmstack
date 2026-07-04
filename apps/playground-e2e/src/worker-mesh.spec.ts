import { expect, test, type Page } from '@playwright/test';

// Composition proof with NO bridge: @mmstack/worker (graph off the main thread) + @mmstack/mesh
// (sync across devices) + persist (durable to IndexedDB), all attached as readers on the worker's
// writable main-side store. The worker-computed `upper` is the tell — when it updates on a device
// that only RECEIVED an edit (or restored one from disk), the change genuinely traversed that
// device's worker, not just the main-thread store.

// idb-keyval's default DB — wipe from a page that never wires persistence so nothing holds it open.
async function wipeIdb(page: Page): Promise<void> {
  await page.goto('/core');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('keyval-store');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Raw read of idb-keyval's stored value at `key` — proof it is on disk, not in app memory. */
async function idbGet(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    (k) =>
      new Promise<unknown>((resolve) => {
        const req = indexedDB.open('keyval-store');
        req.onsuccess = () => {
          const conn = req.result;
          if (!conn.objectStoreNames.contains('keyval')) {
            conn.close();
            resolve(null);
            return;
          }
          const g = conn.transaction('keyval', 'readonly').objectStore('keyval').get(k);
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
    key,
  );
}

// real-time, multi-page, real worker + relay — allow a retry for loopback/scheduling jitter
test.describe.configure({ retries: 2 });

test.describe('worker + mesh + persist composed (no bridge)', () => {
  test('an edit on one device converges through the other device worker', async ({
    context,
  }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto('/worker-mesh?writer=device-a&room=conv');
    await b.goto('/worker-mesh?writer=device-b&room=conv');

    await expect(a.getByTestId('connected')).toHaveText('worker-live');
    await expect(b.getByTestId('connected')).toHaveText('worker-live');
    await expect(a.getByTestId('status')).toHaveText('live');
    await expect(b.getByTestId('status')).toHaveText('live');

    // device A edits its worker-owned doc
    await a.getByTestId('title-input').fill('hello graph');
    await a.getByTestId('save').click();

    await expect(a.getByTestId('title')).toHaveText('hello graph');
    // replicates to B's doc over the mesh ...
    await expect(b.getByTestId('title')).toHaveText('hello graph', {
      timeout: 15_000,
    });
    // ... and B's WORKER recomputed `upper` from the received edit
    await expect(b.getByTestId('upper')).toHaveText('HELLO GRAPH', {
      timeout: 15_000,
    });

    // the other direction, to show it is a true two-way graph
    await b.getByTestId('title-input').fill('reply from b');
    await b.getByTestId('save').click();
    await expect(a.getByTestId('title')).toHaveText('reply from b', {
      timeout: 15_000,
    });
    await expect(a.getByTestId('upper')).toHaveText('REPLY FROM B', {
      timeout: 15_000,
    });

    await a.close();
    await b.close();
  });

  test('persist composes on the worker store: worker-owned changes land in real IndexedDB', async ({
    page,
  }) => {
    await wipeIdb(page);
    // persist reader on, mesh off (isolate durability from any relay-retained room state)
    await page.goto('/worker-mesh?writer=solo&persist=1&mesh=0');
    await expect(page.getByTestId('connected')).toHaveText('worker-live');

    // a write routes through the worker, and persist (a reader on the same store) writes it to disk
    await page.getByTestId('title-input').fill('durable graph');
    await page.getByTestId('save').click();
    await expect(page.getByTestId('title')).toHaveText('durable graph');
    await expect(page.getByTestId('upper')).toHaveText('DURABLE GRAPH'); // the worker computed it

    // really on disk — persist observed the worker-owned store's change and persisted it
    await expect
      .poll(() => idbGet(page, 'wm-solo'), { timeout: 5_000 })
      .toEqual({ title: 'durable graph' });

    await wipeIdb(page);
  });
});
