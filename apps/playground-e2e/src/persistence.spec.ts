import { expect, test, type Page } from '@playwright/test';

// Mutation persistence against a REAL IndexedDB: stash offline, survive a page
// reload (the app genuinely closes), replay FIFO on regain. The unit suite covers
// the semantics on a mock DB; this covers the storage + navigator.onLine + real
// HTTP layers the mock can't.

const DB_NAME = 'mmstack-mutation-queue-db';

/**
 * Idempotency: drop the persistence DB. Runs on a dnd page ('/core') where the
 * persistence registry is never injected, so no open connection blocks the delete.
 */
async function wipeDb(page: Page): Promise<void> {
  await page.goto('/core');
  await page.evaluate(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(db);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    DB_NAME,
  );
}

/** Rows currently in the real DB — proof the stash is on disk, not app memory. */
async function dbRowCount(page: Page): Promise<number> {
  return page.evaluate(
    (db) =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open(db);
        req.onsuccess = () => {
          const conn = req.result;
          const names = Array.from(conn.objectStoreNames);
          if (!names.length) {
            conn.close();
            resolve(0);
            return;
          }
          const count = conn
            .transaction(names[0], 'readonly')
            .objectStore(names[0])
            .count();
          count.onsuccess = () => {
            conn.close();
            resolve(count.result);
          };
        };
        req.onerror = () => resolve(-1);
      }),
    DB_NAME,
  );
}

test.describe('mutation persistence on a real IndexedDB', () => {
  test.beforeEach(async ({ page }) => wipeDb(page));
  test.afterEach(async ({ page, context }) => {
    await context.setOffline(false);
    await wipeDb(page);
  });

  test('online saves flow straight through and leave nothing stashed', async ({
    page,
  }) => {
    const received: string[] = [];
    await page.route('**/api/notes', async (route) => {
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: route.request().postData() ?? '{}',
        });
        received.push(
          (route.request().postDataJSON() as { text: string }).text,
        );
      } catch {
        // request detached (navigation) — never count it
      }
    });

    await page.goto('/persistence');
    await expect(page.getByTestId('ready')).toBeVisible(); // hydration done — listeners live
    await expect(page.getByTestId('pending-count')).toHaveText('0');

    await page.getByTestId('note-input').fill('hello');
    await page.getByTestId('save').click();

    await expect(page.getByTestId('synced')).toContainText('hello');
    await expect(page.getByTestId('pending-count')).toHaveText('0');
    expect(received).toEqual(['hello']);
    expect(await dbRowCount(page)).toBe(0); // settled — the disk is clean
  });

  test('stashes offline in real IDB, survives a reload, replays FIFO on regain', async ({
    page,
    context,
  }) => {
    const received: string[] = [];
    let releaseResponses!: () => void;
    const gate = new Promise<void>((r) => (releaseResponses = r));
    await page.route('**/api/notes', async (route) => {
      await gate; // hold replies so the hydrated pending state is observable
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: route.request().postData() ?? '{}',
        });
        received.push(
          (route.request().postDataJSON() as { text: string }).text,
        );
      } catch {
        // a request aborted by the reload must not count as delivered
      }
    });

    await page.goto('/persistence');
    await expect(page.getByTestId('ready')).toBeVisible(); // hydration done — listeners live
    await expect(page.getByTestId('pending-count')).toHaveText('0');

    // --- go offline, queue two saves
    await context.setOffline(true);
    await page.getByTestId('note-input').fill('first');
    await page.getByTestId('save').click();
    await page.getByTestId('note-input').fill('second');
    await page.getByTestId('save').click();

    await expect(page.getByTestId('pending-count')).toHaveText('2');
    expect(received).toEqual([]); // nothing went out
    await expect.poll(() => dbRowCount(page)).toBe(2); // REALLY on disk (async write)

    // --- "close and reopen the app": regain connectivity, then a full reload
    await context.setOffline(false);
    await page.reload();

    // hydrated from the real DB: still pending (responses are gated, not settled)
    await expect(page.getByTestId('ready')).toBeVisible();
    await expect(page.getByTestId('pending-count')).toHaveText('2');
    expect(await dbRowCount(page)).toBe(2);

    releaseResponses();

    // replay preserved cross-session FIFO order and settled everything
    await expect(page.getByTestId('synced')).toContainText('second');
    // AT-LEAST-ONCE, demonstrated for real: the regain window before the reload may
    // send 'first' whose response never lands (the "app closed mid-flight" case), so
    // replay legitimately re-sends it — the documented reason replayed requests should
    // be idempotent. Order is FIFO modulo that redelivery:
    const collapsed = received.filter((t, i) => t !== received[i - 1]);
    expect(collapsed).toEqual(['first', 'second']);
    await expect(page.getByTestId('pending-count')).toHaveText('0');
    await expect.poll(() => dbRowCount(page)).toBe(0); // disk drained
  });

  test('two tabs: only the Web Lock holder replays; a dying holder hands over', async ({
    page,
    context,
  }) => {
    // Tab 1 stashes offline, regains, and its send is held unresolved — a stash that is
    // "in flight in a live tab". Tab 2 then opens on the same real IndexedDB and real
    // navigator.locks: it must SEE the row but not send it. Destroying tab 1's document
    // releases its lock (the Web Locks guarantee) and tab 2 takes over the leftover row.
    const attempts1: string[] = [];
    const gate = new Promise<void>(() => undefined); // never released
    await page.route('**/api/notes', async (route) => {
      attempts1.push((route.request().postDataJSON() as { text: string }).text);
      await gate;
    });

    await page.goto('/persistence');
    await expect(page.getByTestId('ready')).toBeVisible();

    await context.setOffline(true);
    await page.getByTestId('note-input').fill('solo');
    await page.getByTestId('save').click();
    await expect(page.getByTestId('pending-count')).toHaveText('1');
    await expect.poll(() => dbRowCount(page)).toBe(1);

    await context.setOffline(false);
    await expect.poll(() => attempts1).toEqual(['solo']); // tab 1 is sending (hung)

    const received2: string[] = [];
    const page2 = await context.newPage();
    await page2.route('**/api/notes', async (route) => {
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: route.request().postData() ?? '{}',
        });
        received2.push(
          (route.request().postDataJSON() as { text: string }).text,
        );
      } catch {
        // detached — never count it
      }
    });
    await page2.goto('/persistence');
    await expect(page2.getByTestId('ready')).toBeVisible();

    // tab 2 hydrated the stash from disk but is gated by tab 1's lock
    await expect(page2.getByTestId('pending-count')).toHaveText('1');
    await expect.poll(() => dbRowCount(page2)).toBe(1);
    expect(received2).toEqual([]); // no double-send

    // tab 1's document dies mid-flight (navigation destroys it → lock released);
    // its request never settled, so the row is still on disk — tab 2 must replay it
    await page.goto('/core');

    await expect(page2.getByTestId('synced')).toContainText('solo');
    expect(received2).toEqual(['solo']); // delivered exactly once, by the successor
    await expect(page2.getByTestId('pending-count')).toHaveText('0');
    await expect.poll(() => dbRowCount(page2)).toBe(0);
    expect(attempts1).toEqual(['solo']); // at-least-once: tab 1's attempt just died

    await page2.close();
  });

  test('two live tabs: a stash shows in the sibling instantly and only its owner sends it', async ({
    page,
    context,
  }) => {
    // Live mirror sync (BroadcastChannel) + owner liveness (session locks): the sibling's
    // badge must track the stash in real time, while the replay-lock holder — which is
    // deliberately NOT the stash owner here — must never send a living sibling's row.
    const received1: string[] = [];
    await page.route('**/api/notes', async (route) => {
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: route.request().postData() ?? '{}',
        });
        received1.push(
          (route.request().postDataJSON() as { text: string }).text,
        );
      } catch {
        // detached — never count it
      }
    });
    const received2: string[] = [];
    const page2 = await context.newPage();
    await page2.route('**/api/notes', async (route) => {
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: route.request().postData() ?? '{}',
        });
        received2.push(
          (route.request().postDataJSON() as { text: string }).text,
        );
      } catch {
        // detached — never count it
      }
    });

    await page2.goto('/persistence'); // first in → page2 holds the replay lock
    await expect(page2.getByTestId('ready')).toBeVisible();
    await page.goto('/persistence');
    await expect(page.getByTestId('ready')).toBeVisible();

    await context.setOffline(true);
    await page.getByTestId('note-input').fill('mine');
    await page.getByTestId('save').click();
    await expect(page.getByTestId('pending-count')).toHaveText('1');
    await expect(page2.getByTestId('pending-count')).toHaveText('1'); // live badge

    await context.setOffline(false);
    await expect(page.getByTestId('synced')).toContainText('mine');
    await expect(page.getByTestId('pending-count')).toHaveText('0');
    await expect(page2.getByTestId('pending-count')).toHaveText('0'); // cleared live
    expect(received1).toEqual(['mine']); // the owner delivered it…
    expect(received2).toEqual([]); // …the lock holder never touched it
    await expect.poll(() => dbRowCount(page)).toBe(0);

    await page2.close();
  });
});
